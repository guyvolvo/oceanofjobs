"""The rail's counts read idx_jobs_open_facets and answer exactly as before.

Two changes are checked here against the way facets were counted until
2026-10-21, over a box-built database of random listings and every
filter the board sends:

- the company, category and place counts name idx_jobs_open_facets with
  INDEXED BY where it exists. The answer with it must equal the answer
  without it, and no filter may hit "no query solution", which is a 500.
- the country and city counts come from one grouped pass split in Python
  instead of two recursive CTEs. old_locations below is the SQL that
  replaced, verbatim, and the tree must match it value for value and in
  order, ties included.

Run directly, no framework:  python tests/test_facets_index.py
"""

import json
import os
import random
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "loader"))
sys.path.insert(0, str(ROOT / "api"))
for k, v in {"ALERTS_TABLE": "test-alerts", "DATA_BUCKET": "test-bucket", "DATA_KEY": "jobs.db",
             "AWS_DEFAULT_REGION": "il-central-1", "AWS_ACCESS_KEY_ID": "testing", "AWS_SECRET_ACCESS_KEY": "testing"}.items():
    os.environ.setdefault(k, v)

import load_to_sqlite as lts  # noqa: E402
import aggregates  # noqa: E402
import job_filters  # noqa: E402
from countries import label_for  # noqa: E402

failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}: {name}{'' if ok else '  -- ' + detail}")
    if not ok:
        failures.append(name)


def old_locations(conn, params, country_limit=40):
    """location_tree as it was, both queries verbatim."""
    scoped = {k: v for k, v in params.items() if k not in ("country", "city")}
    where_sql, args = job_filters.build_jobs_where(scoped, job_filters.has_fts_index(conn), True)
    crows = conn.execute(
        f"""
        WITH RECURSIVE split(code, rest) AS (
            SELECT '', country || ','
            FROM jobs
            WHERE {where_sql} AND country IS NOT NULL AND country != ''
            UNION ALL
            SELECT SUBSTR(rest, 1, INSTR(rest, ',') - 1),
                   SUBSTR(rest, INSTR(rest, ',') + 1)
            FROM split
            WHERE rest != ''
        )
        SELECT code AS value, COUNT(*) AS n
        FROM split
        WHERE code != ''
        GROUP BY code
        ORDER BY n DESC
        LIMIT ?
        """, [*args, country_limit]).fetchall()
    rows = conn.execute(
        f"""
        WITH RECURSIVE
        csplit(job, code, rest) AS (
            SELECT rowid, '', country || ','
            FROM jobs
            WHERE {where_sql} AND country IS NOT NULL AND country != ''
              AND city IS NOT NULL AND city != ''
            UNION ALL
            SELECT job, SUBSTR(rest, 1, INSTR(rest, ',') - 1),
                   SUBSTR(rest, INSTR(rest, ',') + 1)
            FROM csplit
            WHERE rest != ''
        ),
        tsplit(job, name, rest) AS (
            SELECT rowid, '', city || ','
            FROM jobs
            WHERE {where_sql} AND country IS NOT NULL AND country != ''
              AND city IS NOT NULL AND city != ''
            UNION ALL
            SELECT job, SUBSTR(rest, 1, INSTR(rest, ',') - 1),
                   SUBSTR(rest, INSTR(rest, ',') + 1)
            FROM tsplit
            WHERE rest != ''
        )
        SELECT csplit.code AS code, tsplit.name AS name, COUNT(*) AS n
        FROM csplit
        JOIN tsplit ON tsplit.job = csplit.job
        WHERE csplit.code != '' AND tsplit.name != ''
        GROUP BY csplit.code, tsplit.name
        ORDER BY n DESC, tsplit.name
        """, [*args, *args]).fetchall()
    cities: dict = {}
    for r in rows:
        cities.setdefault(r["code"], []).append({"value": r["name"], "n": r["n"]})

    def kept(rs):
        return [r for i, r in enumerate(rs[:aggregates.CITY_LIMIT])
                if i < aggregates.CITY_TOP or r["n"] >= aggregates.CITY_MIN_LISTINGS]

    return [{"value": r["value"], "label": label_for(r["value"]), "n": r["n"], "cities": kept(cities.get(r["value"], []))}
            for r in crows]


rng = random.Random(20261021)
NOW = datetime.now(timezone.utc)
DOMAINS = [f"co{i}.com" for i in range(25)] + [""]
COUNTRIES = ["US", "IL", "GB", "DE", "FR", "NL", "US,IL", "IL,US", "GB,,DE", "IL,IL", "US,GB,DE", "", None]
CITIES = ["Tel Aviv", "Haifa", "Haifa,Tel Aviv", "New York", "London", "Berlin,Tel Aviv", "Paris", "", None,
          "Amsterdam,,Rotterdam", "Zürich", "Ra'anana"]


def ts(days):
    return (NOW - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%S+00:00")


with tempfile.TemporaryDirectory() as td:
    conn = lts.open_db(Path(td) / "t.db")
    with conn:
        for d in DOMAINS:
            conn.execute("INSERT INTO companies (domain, ats, first_seen, last_checked) VALUES (?, 'greenhouse', ?, ?)", (d, ts(30), ts(0)))
        for i in range(4000):
            lo = rng.choice([None, None, None, 12000, 20000, 35000])
            conn.execute(
                "INSERT INTO jobs (id, company_domain, ats, title, department, category, seniority, workplace_type,"
                " country, city, role_class, confidence, posted_at, first_seen, last_seen, closed_at,"
                " salary_min_ils, salary_max_ils, salary_source, skills) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (f"{i:016x}", rng.choice(DOMAINS), rng.choice(["greenhouse", "lever"]),
                 rng.choice(["Software Engineer", "Data Engineer", "DevOps Engineer", "Account Manager"]),
                 "Engineering", rng.choice(["Security", "Data", "Software Engineering", "", None, " "]),
                 rng.choice(["senior", "junior", None]), rng.choice(["remote", "hybrid", "onsite", None]),
                 rng.choice(COUNTRIES), rng.choice(CITIES), rng.choice(["tech", "non-tech", "adjacent", None]),
                 rng.choice(["verified"] * 9 + ["best_effort"]),
                 rng.choice([ts(rng.randint(0, 30)), ts(rng.randint(0, 30)), ts(500), None]),
                 ts(rng.randint(0, 40)), ts(0), rng.choice([None] * 6 + [ts(2)]),
                 lo, lo and lo + 8000, rng.choice([None, None, "disclosed", "table"]),
                 rng.choice(["python,go", "java", None])))
        conn.execute("INSERT INTO meta (key, value) VALUES ('posted_at_utc', '1')"
                     " ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        lts.ensure_box_indexes(conn, optimize=False)
    job_filters.register_functions(conn)

    COMBOS = [
        {}, {"confidence": "verified"}, {"confidence": "all"}, {"confidence": "best_effort"},
        {"confidence": "all", "roles": "tech"}, {"search": "devops"}, {"confidence": "all", "search": "engineer"},
        {"country": "US"}, {"confidence": "all", "country": "IL"}, {"confidence": "all", "country": "US,GB"},
        {"confidence": "all", "city": "IL:Tel Aviv"}, {"confidence": "all", "country": "IL", "city": "Haifa"},
        {"confidence": "all", "department": "Security"}, {"confidence": "all", "department": "Security,Data"},
        {"confidence": "all", "seniority": "senior"}, {"confidence": "all", "workplace": "remote"},
        {"confidence": "all", "company": "co3.com"}, {"confidence": "all", "company": "co3.com,co7.com"},
        {"confidence": "all", "max_age_days": "7"}, {"confidence": "all", "salary_min": "20000"},
        {"confidence": "all", "salary_min": "15000", "salary_max": "40000", "salary_known": "1"},
        {"confidence": "all", "salary_disclosed": "1"}, {"confidence": "all", "skills": "python"},
        {"confidence": "all", "include_outdated": "1"}, {"confidence": "all", "include_closed": "1"},
        {"confidence": "all", "roles": "tech", "country": "US", "seniority": "senior", "workplace": "remote"},
        {"confidence": "all", "roles": "tech", "department": "Security", "country": "IL", "max_age_days": "30"},
        {"confidence": "all", "roles": "tech", "search": "engineer", "country": "IL", "company": "co1.com"},
    ]

    def answers(p):
        aggregates._DIRECTORY_CACHE.clear()
        facets = aggregates.compute_facets(conn, dict(p))
        scoped = aggregates.compute_scoped_stats(conn, dict(p)) if aggregates.has_board_filters(p) else None
        return facets, scoped

    caps = job_filters._read_caps(conn)
    check("the loader builds the facets index and the API sees it", caps.facets_index)
    check("and gives it statistics on the spot",
          conn.execute("SELECT 1 FROM sqlite_stat1 WHERE idx = 'idx_jobs_open_facets'").fetchone() is not None)
    hint = job_filters.facet_index_hint
    check("covered filters name the index",
          all(hint(p, caps) for p in ({}, {"confidence": "all", "roles": "tech"}, {"country": "IL", "city": "Haifa"},
                                      {"department": "Security", "seniority": "senior", "salary_min": "20000"})))
    check("a search, skills, salary_known, salary_disclosed or closed rows do not",
          not any(hint(p, caps) for p in ({"search": "devops"}, {"skills": "python"}, {"salary_known": "1"},
                                          {"salary_disclosed": "1"}, {"include_closed": "1"})))

    with_index = {}
    for p in COMBOS:
        try:
            with_index[json.dumps(p)] = answers(p)
        except Exception as e:  # noqa: BLE001
            check(f"{json.dumps(p)} runs with the index", False, repr(e))
            continue
        got = with_index[json.dumps(p)][0]["locations"]
        want = old_locations(conn, p)
        check(f"{json.dumps(p)}: locations match the old SQL", got == want,
              f"\n  got  {[(c['value'], c['n']) for c in got]}\n  want {[(c['value'], c['n']) for c in want]}")

    trees = [f[0]["locations"] for f in with_index.values()]
    check("the fixture has nested cities and countries tied on count, so order is tested",
          any(c["cities"] for t in trees for c in t)
          and any(a["n"] == b["n"] for t in trees for a, b in zip(t, t[1:])))

    conn.execute("DROP INDEX idx_jobs_open_facets")
    job_filters._caps_cache.clear()
    check("without the index nothing is hinted", not job_filters._read_caps(conn).facets_index
          and hint({}, job_filters._read_caps(conn)) == "")
    for p in COMBOS:
        key = json.dumps(p)
        if key in with_index:
            check(f"{key}: same answer without the index", answers(p) == with_index[key])
    conn.close()

print()
if failures:
    print(f"{len(failures)} failed")
    sys.exit(1)
print("all passed")
