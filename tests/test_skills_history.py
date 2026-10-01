"""/api/jobs/history: open and new roles per day for a skill set.

Run directly, no framework:  python tests/test_skills_history.py
"""
import os
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))
os.environ.setdefault("ALERTS_TABLE", "test-alerts")
os.environ.setdefault("DATA_BUCKET", "test-bucket")
os.environ.setdefault("DATA_KEY", "jobs.db")
os.environ.setdefault("AWS_DEFAULT_REGION", "il-central-1")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "testing")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "testing")

import aggregates  # noqa: E402
import job_filters  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failures.append(name)


NOW = datetime.now(timezone.utc)
ago = lambda d: (NOW - timedelta(days=d)).isoformat()  # noqa: E731
conn = sqlite3.connect(":memory:")
conn.row_factory = sqlite3.Row
conn.executescript("""
    CREATE TABLE jobs (
        id TEXT PRIMARY KEY, company_domain TEXT, ats TEXT, title TEXT, location TEXT, department TEXT,
        seniority TEXT, workplace_type TEXT, url TEXT, posted_at TEXT, confidence TEXT, first_seen TEXT,
        last_seen TEXT, closed_at TEXT, skills TEXT, description TEXT, country TEXT, city TEXT,
        salary_text TEXT, salary_is_estimate INT
    );
    CREATE TABLE companies (domain TEXT PRIMARY KEY, ats TEXT, company_name TEXT, logo_url TEXT);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
""")
# id, skills, country, first seen days ago, closed days ago
ROWS = [
    ("old", "Python,AWS,Docker", "IL", 200, None),      # open since long before the window
    ("gone", "Python,AWS,Docker", "IL", 200, 50),       # closed before the window: never counted
    ("w1", "Python,AWS,Docker,Go", "IL", 10, None),     # arrived 10 days ago, still open
    ("w2", "Python,AWS,Docker", "IL", 10, 4),           # arrived 10 days ago, closed 4 days ago
    ("weak", "Python,Go", "IL", 5, None),               # only one of the skills: out
    ("abroad", "Python,AWS,Docker", "US", 5, None),     # matches, but not in Israel
]
for jid, skills, country, seen, closed in ROWS:
    conn.execute("INSERT INTO jobs (id, company_domain, ats, title, confidence, first_seen, last_seen, closed_at, skills, country) "
                 "VALUES (?, 'x.com', 'x', 'Engineer', 'verified', ?, ?, ?, ?, ?)",
                 (jid, ago(seen), ago(0), ago(closed) if closed is not None else None, skills, country))
job_filters.register_functions(conn)

h = aggregates.skills_history(conn, {"skills": "Python,AWS,Docker", "country": "IL"}, days=30)
by = {d["day"]: d for d in h["days"]}
day = lambda d: (NOW - timedelta(days=d)).date().isoformat()  # noqa: E731
check("thirty days, today last", len(h["days"]) == 30 and h["days"][-1]["day"] == day(0))
check("before the window's arrivals, the baseline is the one old open role", by[day(20)]["open"] == 1 and by[day(20)]["new"] == 0, repr(by[day(20)]))
check("the day two arrived counts both as new and open", by[day(10)]["new"] == 2 and by[day(10)]["open"] == 3, repr(by[day(10)]))
check("after one closed, two are open", by[day(3)]["open"] == 2 and by[day(0)]["open"] == 2, repr((by[day(3)], by[day(0)])))
check("a role with one matching skill, and one abroad, are left out", all(d["open"] <= 3 for d in h["days"]))
h2 = aggregates.skills_history(conn, {"skills": "Python,AWS,Docker"}, days=30)
check("without a country the American one counts too", {d["day"]: d["open"] for d in h2["days"]}[day(0)] == 3)
h3 = aggregates.skills_history(conn, {"skills": "Python,Go", "min_match": "1"}, days=30)
check("min_match widens it", {d["day"]: d["open"] for d in h3["days"]}[day(0)] == 4, repr(h3["days"][-1]))
try:
    aggregates.skills_history(conn, {})
    check("no skills is an error", False)
except ValueError:
    check("no skills is an error", True)

c = aggregates.skill_counts(conn, {"skills": "Python,AWS,Go,Rust", "country": "IL", "confidence": "all"})["counts"]
check("one pass counts every skill named, in the country", c == {"Python": 3, "AWS": 2, "Go": 2, "Rust": 0}, repr(c))

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
