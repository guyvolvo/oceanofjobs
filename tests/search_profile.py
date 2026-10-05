"""Where a search's time goes: each FTS5 expression it runs, timed alone.

    DATA_PATH=/var/lib/otj/jobs.db python3 tests/search_profile.py --api /tmp/new/api "soc analyst" "backend eng"

Prints the WHERE match, then every ranking subquery, with its row count
and time, so a slow query can be fixed where the time actually goes.
Read-only.
"""
import argparse
import os
import sys
import time


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", required=True)
    ap.add_argument("queries", nargs="+")
    a = ap.parse_args()
    sys.path.insert(0, a.api)
    os.environ.setdefault("ALERTS_TABLE", "x")
    from db import get_connection
    from job_filters import has_fts_index, search_query
    import search_compile

    conn = get_connection()
    caps = has_fts_index(conn)
    for raw in a.queries:
        q = search_query({"search": raw})
        print(f"\n== {raw!r}: {len(q.groups)} groups, {sum(len(g.alternatives) for g in q.groups)} alternatives")
        exprs = [("where", search_compile.match_expression(q))]
        _, rargs = search_compile.rank_sql(q, caps)
        exprs += [(f"rank{i}", e) for i, e in enumerate(rargs)]
        total = 0.0
        for name, expr in exprs:
            if not expr:
                continue
            s = time.perf_counter()
            n = conn.execute("SELECT COUNT(*) FROM jobs_fts WHERE jobs_fts MATCH ?", (expr,)).fetchone()[0]
            dt = time.perf_counter() - s
            total += dt
            print(f"  {name:7} {dt:6.3f}s {n:>8} rows  {expr[:150]}")
        print(f"  sum    {total:6.3f}s")


if __name__ == "__main__":
    main()
