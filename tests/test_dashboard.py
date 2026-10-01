"""api/dashboard.py: the account overview's numbers, computed once.

Run directly, no framework:  python tests/test_dashboard.py
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

import dashboard  # noqa: E402
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
for jid, skills in [("a", "Python,AWS,Docker,GCP"), ("b", "Python,AWS,Docker,GCP"), ("c", "Python,AWS,Docker"),
                    ("d", "Python,AWS,Docker,Rust"), ("e", "Python,Go")]:
    conn.execute("INSERT INTO jobs (id, company_domain, ats, title, confidence, first_seen, last_seen, skills, country, salary_text) "
                 "VALUES (?, 'x.com', 'x', 'Engineer', 'verified', ?, ?, ?, 'IL', '₪30K')", (jid, ago(3), ago(0), skills))
job_filters.register_functions(conn)


def page(params):
    where, args = job_filters.build_jobs_where(params, job_filters.has_fts_index(conn), job_filters.has_places(conn))
    return {"jobs": [dict(r) for r in conn.execute(f"SELECT * FROM jobs WHERE {where} LIMIT {int(params['limit'])}", args)]}


profile = {"skills": ["Python", "AWS", "Docker"], "country": ["IL"]}
check("the scope key names the skills, the one country and the match floor",
      dashboard.scope_key(profile) == "Python,AWS,Docker|IL|3", dashboard.scope_key(profile))
check("two countries means no country in the scope", dashboard.scope({"skills": ["Python"], "country": ["IL", "US"]})["country"] == "")
out = dashboard.compute(conn, profile, page)
check("history, matches, counts and a stamp come back",
      out["history"] and len(out["matches"]) == 5 and out["counts"].get("Python") == 5 and out["computed_at"], repr({k: type(v).__name__ for k, v in out.items()}))
check("GCP, in half the matches, is suggested; Rust, in a quarter, is too; Go is not",
      [s["skill"] for s in out["suggested"]] == ["GCP", "Rust"], repr(out["suggested"]))
check("the suggested skills' counts come along", out["counts"].get("GCP") == 2 and out["counts"].get("Rust") == 1, repr(out["counts"]))
check("a match carries only the fields the overview reads", set(out["matches"][0]) <= set(dashboard.MATCH_FIELDS), repr(sorted(out["matches"][0])))
empty = dashboard.compute(conn, {"skills": []}, page)
check("no skills: an empty answer, no queries", empty["history"] is None and empty["matches"] == [] and empty["counts"] == {})

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
