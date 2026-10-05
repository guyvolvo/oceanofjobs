"""Time every concept alternative as an FTS5 phrase, warm, on a real index.

    DATA_PATH=/var/lib/otj/jobs.db python3 tests/search_alt_cost.py --api /tmp/new/api

A related phrase costs a full read of each of its words' doclists, which
for words like "security" or "and" is most of the index. This lists the
alternatives worst first so the concept table can drop the ones that cost
more than they find. Read-only.
"""
import argparse
import os
import sys
import time


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", required=True)
    a = ap.parse_args()
    sys.path.insert(0, a.api)
    os.environ.setdefault("ALERTS_TABLE", "x")
    from db import get_connection
    from search_terms import CONCEPTS

    conn = get_connection()
    rows = []
    for c in CONCEPTS:
        name = c["name"]
        phrases = sorted({*c.get("triggers", []), *c.get("related", [])})
        for p in phrases:
            expr = 'title : "' + p.replace('"', '""') + '"'
            conn.execute("SELECT COUNT(*) FROM jobs_fts WHERE jobs_fts MATCH ?", (expr,)).fetchone()
            s = time.perf_counter()
            n = conn.execute("SELECT COUNT(*) FROM jobs_fts WHERE jobs_fts MATCH ?", (expr,)).fetchone()[0]
            rows.append((time.perf_counter() - s, n, name, p))
    rows.sort(reverse=True)
    for dt, n, name, p in rows:
        print(f"{dt:6.3f}s {n:>7} title rows  {name:24} {p}")
    print(f"total {sum(r[0] for r in rows):.2f}s over {len(rows)} phrases")


if __name__ == "__main__":
    main()
