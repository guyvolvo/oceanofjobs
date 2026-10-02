"""The expensive-request guard (api/expensive.py).

Run directly, no framework:  python tests/test_expensive.py

Three things: the permit itself (two in, the rest turned away quickly),
every route that does expensive work actually takes a permit (with the
permits used up, each answers 429 while the cheap routes answer as
usual), and a statement past the request's deadline is interrupted and
answered 503.
"""
import json
import os
import sqlite3
import sys
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))

DB = Path(tempfile.mkdtemp()) / "jobs.db"
for k, v in {"ALERTS_TABLE": "test-alerts", "DATA_BUCKET": "test-bucket", "DATA_KEY": "jobs.db",
             "AWS_DEFAULT_REGION": "il-central-1", "AWS_ACCESS_KEY_ID": "testing",
             "AWS_SECRET_ACCESS_KEY": "testing", "DATA_PATH": str(DB)}.items():
    os.environ[k] = v

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failures.append(name)


import expensive  # noqa: E402

# The permit.
try:
    with expensive.guard("not-a-kind"):
        pass
    check("an unknown kind is refused", False)
except ValueError:
    check("an unknown kind is refused", True)

expensive.reset(2)
expensive.WAIT_S = 0.3
outcomes, lock = [], threading.Lock()


def worker():
    try:
        with expensive.guard("search"):
            with lock:
                outcomes.append("ran")
            time.sleep(1.0)
    except expensive.Busy:
        with lock:
            outcomes.append("busy")


started = time.monotonic()
threads = [threading.Thread(target=worker) for _ in range(6)]
for t in threads:
    t.start()
for t in threads:
    t.join()
check("six at once: two run, four are turned away", outcomes.count("ran") == 2 and outcomes.count("busy") == 4,
      repr(outcomes))
check("the four are turned away quickly, not after the two finish", time.monotonic() - started < 1.5,
      f"{time.monotonic() - started:.2f}s")
expensive.WAIT_S = 0.2

# A small database for the routes.
NOW = datetime.now(timezone.utc)
ago = lambda d: (NOW - timedelta(days=d)).isoformat(timespec="seconds")  # noqa: E731
JOB_ID = "a1b2c3d4e5f6a7b8"
conn = sqlite3.connect(DB)
conn.executescript("""
CREATE TABLE jobs (id TEXT PRIMARY KEY, company_domain TEXT, ats TEXT, external_id TEXT, title TEXT, location TEXT,
  department TEXT, category TEXT, seniority TEXT, workplace_type TEXT, url TEXT, posted_at TEXT, confidence TEXT,
  first_seen TEXT, last_seen TEXT, closed_at TEXT, skills TEXT, description TEXT, country TEXT, city TEXT,
  salary_text TEXT, salary_is_estimate INT, salary_source TEXT, role_class TEXT);
CREATE TABLE companies (domain TEXT PRIMARY KEY, ats TEXT, company_name TEXT, logo_url TEXT, first_seen TEXT,
  error TEXT, last_checked TEXT, job_count INT, confidence TEXT, token TEXT);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
INSERT INTO companies (domain, ats, company_name, first_seen) VALUES ('wix.com', 'greenhouse', 'Wix', '2026-01-01');
""")
conn.execute("INSERT INTO jobs (id, company_domain, ats, external_id, title, location, department, url, posted_at, "
             "confidence, first_seen, last_seen, country, city) VALUES (?, 'wix.com', 'greenhouse', 'x', "
             "'Python Engineer', 'Tel Aviv, Israel', 'R&D', 'https://x/y', ?, 'verified', ?, ?, 'IL', 'Tel Aviv')",
             (JOB_ID, ago(2), ago(2), ago(0)))
conn.commit()
conn.close()

import handler  # noqa: E402

handler._precomputed_json = lambda name: None  # no S3 here: every aggregate is computed live
handler._description_from_s3 = lambda job_id: None


def call(path, query=""):
    return handler.lambda_handler({"rawPath": path, "rawQueryString": query, "headers": {},
                                   "requestContext": {"http": {"method": "GET"}}}, None)


# Every route that does expensive work, as a request that reaches it.
KNOWN_EXPENSIVE = [
    ("/api/jobs", "search=python"),
    ("/api/jobs", "keywords=python"),
    ("/api/facets", "confidence=all&department=Software%20Engineering"),
    ("/api/stats", "country=IL"),
    ("/api/companies/directory", ""),
    ("/api/companies/search", "q=wi"),
    ("/company/wix.com", ""),
]
CHEAP = [
    ("/api/jobs", "country=IL"),
    ("/job/" + JOB_ID, ""),
    ("/api/health", ""),
]

expensive.reset(2)
give_back = expensive.hold_all()
try:
    for path, q in KNOWN_EXPENSIVE:
        r = call(path, q)
        headers = r.get("headers") or {}
        check(f"with every permit taken, {path}?{q} answers 429 with Retry-After",
              r["statusCode"] == 429 and headers.get("Retry-After") and headers.get("Cache-Control") == "no-store",
              f"{r['statusCode']} {headers}")
    for path, q in CHEAP:
        r = call(path, q)
        check(f"with every permit taken, the cheap {path}?{q} still answers", r["statusCode"] == 200,
              f"{r['statusCode']} {str(r.get('body'))[:120]}")
finally:
    give_back()

for path, q in KNOWN_EXPENSIVE:
    r = call(path, q)
    check(f"with permits free, {path}?{q} answers normally", r["statusCode"] == 200,
          f"{r['statusCode']} {str(r.get('body'))[:160]}")

# The statement deadline.
import db  # noqa: E402

c = db._open_readonly(str(DB))
expensive.STATEMENT_DEADLINE_S = 0.2
expensive.start_request()
time.sleep(0.3)
try:
    c.execute("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50000000) "
              "SELECT count(*) FROM n").fetchone()
    check("a statement past the deadline is interrupted", False, "it ran to the end")
except sqlite3.OperationalError as e:
    check("a statement past the deadline is interrupted", "interrupted" in str(e), str(e))
expensive.STATEMENT_DEADLINE_S = 25.0
expensive.start_request()
check("a statement inside the deadline runs", c.execute("SELECT count(*) FROM jobs").fetchone()[0] == 1)

real_route_jobs = handler.route_jobs
handler.route_jobs = lambda params: (_ for _ in ()).throw(sqlite3.OperationalError("interrupted"))
r = call("/api/jobs", "country=IL")
check("an interrupted statement is answered 503 with Retry-After, never cached",
      r["statusCode"] == 503 and r["headers"].get("Retry-After") and r["headers"].get("Cache-Control") == "no-store",
      f"{r['statusCode']} {r.get('headers')}")
handler.route_jobs = lambda params: (_ for _ in ()).throw(sqlite3.OperationalError("no such column: x"))
r = call("/api/jobs", "country=IL")
check("any other database error is still a 500", r["statusCode"] == 500, str(r["statusCode"]))
handler.route_jobs = real_route_jobs
check("the frontend retries 429", "429" in (ROOT / "frontend" / "app.js").read_text(encoding="utf-8", errors="replace"))

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
