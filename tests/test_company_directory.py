"""/api/companies/directory and /api/companies/<domain>, and the daily
table they read.

Run directly, no framework:  python tests/test_company_directory.py
"""
import os
import sqlite3
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))
sys.path.insert(0, str(ROOT / "loader"))
os.environ.setdefault("ALERTS_TABLE", "test-alerts")
os.environ.setdefault("DATA_BUCKET", "test-bucket")
os.environ.setdefault("DATA_KEY", "jobs.db")
os.environ.setdefault("AWS_DEFAULT_REGION", "il-central-1")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "testing")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "testing")

import aggregates  # noqa: E402
import job_filters  # noqa: E402
import precompute  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failures.append(name)


NOW = datetime.now(timezone.utc)
ago = lambda d: (NOW - timedelta(days=d)).isoformat()  # noqa: E731

# id, company, country, first_seen days ago, closed days ago
JOBS = [
    ("a1", "wiz.io", "IL", 0.5, None), ("a2", "wiz.io", "IL", 2, None), ("a3", "wiz.io", "IL", 30, None),
    ("a4", "wiz.io", "US", 3, None),
    ("b1", "monday.com", "IL", 40, None), ("b2", "monday.com", "IL", 41, None),
    ("c1", "aidoc.com", "IL", 2, 1),   # closed: not open anywhere
    ("d1", "acme.com", "US", 5, None),
]


def make_db(path):
    conn = sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE jobs (
            id TEXT PRIMARY KEY, company_domain TEXT, ats TEXT, title TEXT, location TEXT,
            department TEXT, seniority TEXT, workplace_type TEXT, url TEXT, posted_at TEXT,
            confidence TEXT, first_seen TEXT, last_seen TEXT, closed_at TEXT, skills TEXT,
            description TEXT, country TEXT, city TEXT, salary_text TEXT, salary_is_estimate INT
        );
        CREATE TABLE companies (domain TEXT PRIMARY KEY, ats TEXT, company_name TEXT, logo_url TEXT, first_seen TEXT);
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO companies VALUES ('wiz.io', 'greenhouse', 'Wiz', 'https://wiz.io/icon.png', '2026-01-01');
        INSERT INTO companies VALUES ('monday.com', 'comeet', 'monday.com', NULL, '2026-01-01');
        INSERT INTO companies VALUES ('aidoc.com', 'lever', 'Aidoc', NULL, '2026-01-01');
        INSERT INTO companies VALUES ('acme.com', 'workday', NULL, NULL, '2026-01-01');
    """)
    for jid, dom, country, seen, closed in JOBS:
        conn.execute(
            "INSERT INTO jobs (id, company_domain, ats, title, posted_at, confidence, first_seen, last_seen, closed_at, country) "
            "VALUES (?, ?, 'x', 'Engineer', ?, 'verified', ?, ?, ?, ?)",
            (jid, dom, ago(seen), ago(seen), ago(0), ago(closed) if closed is not None else None, country))
    conn.commit()
    conn.close()


with tempfile.TemporaryDirectory() as td:
    db = Path(td) / "jobs.db"
    make_db(db)
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    job_filters.register_functions(conn)

    d = aggregates.company_directory(conn, {"confidence": "verified"})
    by = {c["domain"]: c for c in d["companies"]}
    check("busiest first, open roles only", [c["domain"] for c in d["companies"]] == ["wiz.io", "monday.com", "acme.com"],
          repr([c["domain"] for c in d["companies"]]))
    check("counts and the week's new ones", by["wiz.io"]["n"] == 4 and by["wiz.io"]["new_7d"] == 3
          and by["monday.com"]["new_7d"] == 0, repr(by["wiz.io"]))
    check("name, system and whether a logo exists come from the companies table",
          by["wiz.io"]["name"] == "Wiz" and by["wiz.io"]["ats"] == "greenhouse" and by["wiz.io"]["has_logo"]
          and by["acme.com"]["name"] is None and not by["acme.com"]["has_logo"], repr(by["acme.com"]))
    check("not capped at four companies", d["capped"] is False and d["limit"] == 500)
    d_il = aggregates.company_directory(conn, {"confidence": "verified", "country": "IL"})
    by_il = {c["domain"]: c for c in d_il["companies"]}
    check("a country narrows it to the roles there", by_il["wiz.io"]["n"] == 3 and "acme.com" not in by_il, repr(by_il))
    d_cap = aggregates.company_directory(conn, {"confidence": "verified"}, limit=2)
    check("a smaller limit caps and says so", len(d_cap["companies"]) == 2 and d_cap["capped"] is True)

    p = aggregates.company_profile(conn, "WIZ.IO")
    check("a profile, found regardless of case", p is not None and p["domain"] == "wiz.io" and p["name"] == "Wiz"
          and p["ats"] == "greenhouse" and p["has_logo"], repr(p))
    check("its open roles worldwide and the week's new ones", p["open_jobs"] == 4 and p["new_jobs_7d"] == 3, repr(p))
    check("no history before the table exists", p["history"] == [])
    check("an unknown domain is None", aggregates.company_profile(conn, "nobody.example") is None)
    conn.close()

    check("the first run of the day writes the table", precompute.record_company_day(db) is True)
    check("the second run the same day does nothing", precompute.record_company_day(db) is False)
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    job_filters.register_functions(conn)
    rows = {r["domain"]: dict(r) for r in conn.execute("SELECT * FROM company_daily")}
    check("one row per company with open roles, counting the last day's arrivals",
          set(rows) == {"wiz.io", "monday.com", "acme.com"} and rows["wiz.io"]["open_n"] == 4 and rows["wiz.io"]["new_n"] == 1
          and rows["wiz.io"]["day"] == NOW.date().isoformat(), repr(rows.get("wiz.io")))
    p = aggregates.company_profile(conn, "wiz.io")
    # Backfilled weeks only exist where something was open: wiz.io's
    # oldest role was seen 30 days ago, so it has four weekly rows and
    # today's; the fixture's oldest role (41 days) gives the table five
    # weeks and today.
    check("the profile carries the history: today's row and the backfilled weeks it was hiring in",
          [h["open_n"] for h in p["history"]] == [1, 1, 1, 1, 4], repr([h["open_n"] for h in p["history"]]))
    days = conn.execute("SELECT COUNT(DISTINCT day) FROM company_daily").fetchone()[0]
    check("the first run backfilled one row a week back to the oldest open role", days == 6, str(days))
    four_weeks_ago = [h for h in p["history"] if 26 <= (NOW.date() - datetime.strptime(h["day"], "%Y-%m-%d").date()).days <= 29]
    check("a backfilled week counts what was open then: wiz.io had one role seen 30 days ago",
          four_weeks_ago and four_weeks_ago[0]["open_n"] == 1, repr(four_weeks_ago))
    d = aggregates.company_directory(conn, {"confidence": "verified"})
    t = {c["domain"]: c["trend"] for c in d["companies"]}
    check("the directory carries a twelve-week trend per company, oldest first, this week last",
          len(t["wiz.io"]) == 12 and t["wiz.io"][-1] == 4 and t["monday.com"][-1] == 2 and t["wiz.io"][7] == 1, repr(t["wiz.io"]))
    conn.close()

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
