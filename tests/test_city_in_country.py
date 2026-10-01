"""city=AR:Buenos Aires means that city in that country alone.

Run directly, no framework:  python tests/test_city_in_country.py
"""
import os
import sqlite3
import sys
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
ROWS = [("ar1", "AR", "Buenos Aires"), ("ar2", "AR", "Buenos Aires"), ("ar3", "AR", "Córdoba"),
        ("bo1", "BO", "Buenos Aires"), ("br1", "BR", "Buenos Aires"), ("br2", "BR", "São Paulo"),
        ("two", "AR,BR", "Buenos Aires,São Paulo")]
for jid, country, city in ROWS:
    conn.execute("INSERT INTO jobs (id, company_domain, ats, title, confidence, first_seen, last_seen, country, city) "
                 "VALUES (?, 'x.com', 'x', 'Engineer', 'verified', '2026-09-01', '2026-10-01', ?, ?)", (jid, country, city))
job_filters.register_functions(conn)


def ids(params):
    where, args = job_filters.build_jobs_where(params, job_filters.has_fts_index(conn), job_filters.has_places(conn))
    return sorted(r[0] for r in conn.execute(f"SELECT id FROM jobs WHERE {where}", args))


check("a bare city name still means the city in any country",
      ids({"city": "Buenos Aires"}) == ["ar1", "ar2", "bo1", "br1", "two"], repr(ids({"city": "Buenos Aires"})))
check("a city with its country means that city there alone",
      ids({"country": "AR", "city": "AR:Buenos Aires"}) == ["ar1", "ar2", "two"], repr(ids({"country": "AR", "city": "AR:Buenos Aires"})))
check("two cities in two countries OR, each inside its own country",
      ids({"country": "AR,BR", "city": "AR:Buenos Aires,BR:São Paulo"}) == ["ar1", "ar2", "br2", "two"],
      repr(ids({"country": "AR,BR", "city": "AR:Buenos Aires,BR:São Paulo"})))
check("the country code is case-insensitive and an unknown one is read as part of the name",
      ids({"city": "ar:Buenos Aires"}) == ["ar1", "ar2", "two"] and ids({"city": "ZZ:Buenos Aires"}) == [])
check("the names alone, for callers that only need which",
      job_filters.wanted_cities({"city": "AR:Buenos Aires,BO:Buenos Aires,Córdoba"}) == ["Buenos Aires", "Córdoba"])
with aggregates.place_rows(conn, {"country": "AR", "city": "AR:Buenos Aires"}):
    check("the temp rowset the facets read agrees", ids({"country": "AR", "city": "AR:Buenos Aires"}) == ["ar1", "ar2", "two"])

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
