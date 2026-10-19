"""The API returns reopened_at, before and after the loader adds the column.

Run directly, no framework:  python tests/test_reopened_api.py
"""

import os
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "api"))

for k, v in {"ALERTS_TABLE": "test-alerts", "DATA_BUCKET": "test-bucket", "DATA_KEY": "jobs.db",
             "AWS_DEFAULT_REGION": "il-central-1", "AWS_ACCESS_KEY_ID": "testing", "AWS_SECRET_ACCESS_KEY": "testing"}.items():
    os.environ.setdefault(k, v)

import handler  # noqa: E402
import job_filters  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failures.append(name)


conn = sqlite3.connect(":memory:")
conn.row_factory = sqlite3.Row
conn.execute("""CREATE TABLE jobs (id TEXT PRIMARY KEY, company_domain TEXT, ats TEXT, external_id TEXT, title TEXT,
    location TEXT, department TEXT, seniority TEXT, workplace_type TEXT, url TEXT, posted_at TEXT, confidence TEXT,
    first_seen TEXT, last_seen TEXT, closed_at TEXT, skills TEXT, description TEXT, salary_text TEXT, salary_is_estimate INT)""")
conn.execute("INSERT INTO jobs (id, company_domain, ats, external_id, title, url, confidence, posted_at, first_seen, last_seen)"
             " VALUES ('j1', 'acme.com', 'lever', 'a', 'Engineer', 'https://jobs.lever.co/acme/a', 'verified',"
             " datetime('now'), datetime('now', '-40 days'), datetime('now'))")
conn.commit()
job_filters.register_functions(conn)
handler.get_connection = lambda: conn
handler._description_from_s3 = lambda job_id: None

listed = handler.route_jobs({})["jobs"][0]
check("before the column exists, the list carries reopened_at as null", "reopened_at" in listed and listed["reopened_at"] is None, repr(listed))
check("and so does a single job", handler.route_job_detail("j1")["reopened_at"] is None)

conn.execute("ALTER TABLE jobs ADD COLUMN reopened_at TEXT")
conn.execute("UPDATE jobs SET reopened_at = '2026-10-19T08:00:00+00:00'")
conn.commit()
check("once it exists, the list returns its value", handler.route_jobs({})["jobs"][0]["reopened_at"] == "2026-10-19T08:00:00+00:00")
check("and so does a single job", handler.route_job_detail("j1")["reopened_at"] == "2026-10-19T08:00:00+00:00")

print()
if failures:
    print("%d failed" % len(failures))
    sys.exit(1)
print("all passed")
