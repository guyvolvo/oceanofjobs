"""Search against a real five-column FTS5 index, matching and ranking.

The fixture holds the cases that went wrong live: a SOC analyst title, the
related titles that should come with it, a product manager whose
description merely mentions the SOC, a system-on-chip engineer, an
"Associate" that substring scoring used to reward for "soc", a SOC 2
auditor, and a description with "security" and "operations" far apart.

Each query runs through build_jobs_where and relevance_score_sql, the
same two functions route_jobs uses, and the guard at the end checks both
were handed one and the same SearchQuery.

Run directly, no framework:  python tests/test_search_fts.py
"""
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

import job_filters as J  # noqa: E402
import search_compile  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + str(detail)))
    if not ok:
        failures.append(name)


ROWS = [
    # id, title, department, description
    ("soc", "SOC Analyst", "Security", "monitor alerts and triage"),
    ("secanalyst_t1", "Security Analyst - Tier 1", "IT", "triage incidents for customers"),
    ("secops", "SecOps Engineer", "Engineering", "automate response"),
    ("cyber_l1", "Cyber Security Analyst L1", "Security", "first line monitoring"),
    ("pm", "Product Manager - Builder, AI & Cyber", "Product", "partner with our SOC on detection roadmaps"),
    ("chip", "SoC Design Engineer", "Hardware", "system on chip verification"),
    ("assoc", "Associate Accountant", "Finance", "month end close"),
    ("far", "Ops Coordinator", "Operations", "security " + "filler " * 40 + "operations"),
    ("soc2", "SOC 2 Compliance Auditor", "Compliance", "audit controls"),
    ("secopslead", "Security Operations Lead", "Security", "lead the team"),
    ("soc_t1", "Junior SOC Analyst Tier 1", "Security", "night shifts"),
    ("react_dev", "React Developer", "Engineering", "build the web app"),
    ("a_reactor", "Reactor Operator Trainee", "Plant", "run the reactor safely"),
    ("react_desc", "Frontend Engineer", "Engineering", "our stack is react and typescript"),
]
conn = sqlite3.connect(":memory:")
conn.row_factory = sqlite3.Row
conn.execute("""CREATE TABLE jobs (id TEXT PRIMARY KEY, title TEXT, company_domain TEXT, location TEXT,
                department TEXT, closed_at TEXT, confidence TEXT, posted_at TEXT, first_seen TEXT)""")
conn.execute("CREATE VIRTUAL TABLE jobs_fts USING fts5(title, company_domain, location, department, description, content='', contentless_delete=1)")
for jid, title, dept, desc in ROWS:
    cur = conn.execute("INSERT INTO jobs VALUES (?,?,?,?,?,NULL,'verified',NULL,'2026-10-01')",
                       (jid, title, "example.com", "Tel Aviv", dept))
    conn.execute("INSERT INTO jobs_fts(rowid, title, company_domain, location, department, description) VALUES (?,?,?,?,?,?)",
                 (cur.lastrowid, title, "example.com", "Tel Aviv", dept, desc))
CAPS = J.SnapshotCaps(fts=True, fts_full=True)


def run(search, **extra):
    params = {"search": search, **extra}
    where, args = J.build_jobs_where(params, CAPS)
    rank, rargs = J.relevance_score_sql(params, CAPS)
    rows = conn.execute(f"SELECT id, {rank} AS r FROM jobs WHERE {where} ORDER BY r DESC, id",
                        [*rargs, *args]).fetchall()
    return [r["id"] for r in rows]


def above(order, a, b):
    return a in order and (b not in order or order.index(a) < order.index(b))


FAMILY = ["soc", "secanalyst_t1", "secops", "cyber_l1"]
for q in ("soc", "soc analyst", "soc tier 1", "soc ana"):
    got = run(q)
    check(f"{q!r} returns every SOC-family title", all(f in got for f in FAMILY), got)
    check(f"{q!r} ranks them all above the product manager", all(above(got, f, "pm") for f in FAMILY), got)

got = run("soc analyst")
check("soc analyst does not bring back the chip engineer or the SOC 2 auditor",
      "chip" not in got and "soc2" not in got, got)
check("soc analyst skips a description that only says SOC", "pm" not in got, got)

got = run("soc")
check("ordering: literal title > related title > description only",
      above(got, "soc", "secanalyst_t1") and above(got, "secanalyst_t1", "pm"), got)
check("whole words: Associate no longer answers soc", "assoc" not in got, got)
check("the hardware sense still matches bare soc, below the security family",
      "chip" in got and all(above(got, f, "chip") for f in FAMILY), got)

got = run("soc tier 1")
check("the three tier 1 titles (Tier 1, L1) come first for soc tier 1",
      set(got[:3]) == {"soc_t1", "secanalyst_t1", "cyber_l1"}, got)
check("a SOC title with no tier is still there, after them", "soc" in got and got.index("soc") >= 3, got)

got = run("soc ana")
check("soc ana finds SOC Analyst while it is typed", "soc" in got and "soc_t1" in got, got)

got = run("security operations")
check("security operations finds the title that says it", "secopslead" in got, got)
check("and drops the description with the words forty apart", "far" not in got, got)

got = run("soc analyst", search_exact="1")
check("search exactly: only rows with both words", sorted(got) == ["soc", "soc_t1"], got)
got = run("chip auditor", search_mode="any")
check("any-word mode still ORs the groups", sorted(got) == ["chip", "soc2"], got)

got = run("SOC 2")
check("SOC 2 finds the auditor and not the analysts", "soc2" in got and "soc" not in got, got)

# A finished word against what its stem completes to. The * on the last
# word is for a search still being typed, so it keeps matching, but the
# word as typed ranks first: exact title word > stem-only title > a
# description hit. Measured live: "react" had Reactor Operator in its top
# five and "rust" a Rustenburg financial adviser before this order.
got = run("react")
check("react still matches the stem while it may be typed", "a_reactor" in got, got)
check("exact title word > stem-only title > description only",
      above(got, "react_dev", "a_reactor") and above(got, "a_reactor", "react_desc"), got)
got = run("reac")
check("a half-typed word finds both titles", {"react_dev", "a_reactor"} <= set(got), got)

# The facets' temp table (aggregates.search_rows) stands in for the MATCH
# and must find exactly what the index finds, or the rail's counts would
# describe a different list from the one beside them.
for q in ("soc", "soc analyst tier 1", "security operations", "chip auditor"):
    params = {"search": q, **({"search_mode": "any"} if q == "chip auditor" else {})}
    plain = sorted(r["id"] for r in conn.execute(
        "SELECT id FROM jobs WHERE " + J.build_jobs_where(params, CAPS)[0], J.build_jobs_where(params, CAPS)[1]))
    expr = search_compile.match_expression(J.search_query(params))
    conn.execute("CREATE TEMP TABLE rs (rid INTEGER PRIMARY KEY)")
    conn.execute("INSERT INTO rs SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH ?", [expr])
    token = J.search_rowset.set(("rs", expr))
    try:
        where, args = J.build_jobs_where(params, CAPS)
        via = sorted(r["id"] for r in conn.execute("SELECT id FROM jobs WHERE " + where, args))
    finally:
        J.search_rowset.reset(token)
        conn.execute("DROP TABLE temp.rs")
    check(f"the search temp table finds what the index finds for {q!r}",
          via == plain and "temp.rs" in where and "MATCH" not in where, (via, plain, where))
other = {"search": "soc"}
token = J.search_rowset.set(("rs", search_compile.match_expression(J.search_query({"search": "secops"}))))
try:
    where, _ = J.build_jobs_where(other, CAPS)
finally:
    J.search_rowset.reset(token)
check("a temp table built for another search is never read", "temp.rs" not in where, where)

# search_rows must leave the connection out of any transaction. One left
# open pins the snapshot, and the API's per-thread connections then never
# see a new listing again (2026-10-05, alert emails linking to 404s).
import aggregates  # noqa: E402
aggregates.has_fts_index = lambda c: CAPS
conn.commit()
before = conn.in_transaction
with aggregates.search_rows(conn, {"search": "soc analyst"}):
    inside = J.search_rowset.get()
check("search_rows built its table", bool(inside), inside)
check("search_rows leaves no transaction open", not before and not conn.in_transaction, conn.in_transaction)

# The guard: both compilers get the one SearchQuery, never a second parse.
seen = []
real_where, real_rank = search_compile.where_sql, search_compile.rank_sql
search_compile.where_sql = lambda q, caps, rowset=None: (seen.append(("where", q)), real_where(q, caps, rowset))[1]
search_compile.rank_sql = lambda q, caps: (seen.append(("rank", q)), real_rank(q, caps))[1]
try:
    params = {"search": "soc analyst tier 1"}
    J.build_jobs_where(params, CAPS)
    J.relevance_score_sql(params, CAPS)
finally:
    search_compile.where_sql, search_compile.rank_sql = real_where, real_rank
check("matching and ranking receive the same SearchQuery object",
      [k for k, _ in seen] == ["where", "rank"] and seen[0][1] is seen[1][1], seen)
src = (Path(__file__).resolve().parent.parent / "api" / "job_filters.py").read_text(encoding="utf-8")
check("job_filters never reads the search text itself any more",
      "search_terms(params[\"search\"])" not in src and "for term in search_terms(" not in src)

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
