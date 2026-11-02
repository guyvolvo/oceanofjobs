"""An older poll applied after a newer one is skipped (2026-11-02 review).

Fragments apply in key order, which is when a fragment was written, not
when its boards were polled. A sweep killed after a hang can write its old
poll of a board after a newer sweep already wrote the current one. Applied,
the old whole board closes jobs posted since and reopens jobs closed since,
and the 304s that follow keep it that way. probe.py stamps observed_at on
each result; load_resolved skips an entry older than the one it applied.

Run directly, no framework:  python tests/test_observed_order.py
"""
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "loader"))

from load_to_sqlite import load_resolved, open_db  # noqa: E402

failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}: {name}{'' if ok else '  -- ' + detail}")
    if not ok:
        failures.append(name)


def board(ids, polled=None):
    entry = {"domain": "acme.com", "ats": "greenhouse", "token": "acme", "job_count": len(ids), "tried": 1,
             "jobs": [{"ats": "greenhouse", "token": "acme", "external_id": str(i), "title": f"Engineer {i}",
                       "url": f"https://boards.greenhouse.io/acme/jobs/{i}"} for i in ids]}
    if polled:
        entry["observed_at"] = polled
    return entry


def load(conn, entry, tmp: Path) -> None:
    p = tmp / "resolved.json"
    p.write_text(json.dumps([entry]), encoding="utf-8")
    with conn:
        load_resolved(conn, p)


def open_ids(conn) -> set[str]:
    return {r[0] for r in conn.execute("SELECT external_id FROM jobs WHERE company_domain = 'acme.com' AND closed_at IS NULL")}


def main() -> int:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        conn = open_db(tmp / "jobs.db")
        load(conn, board([1, 2, 3], "2026-11-02T10:00:00+00:00"), tmp)
        load(conn, board([1, 2, 4], "2026-11-02T10:05:00+00:00"), tmp)
        check("the newer poll applies: 3 closed, 4 opened", open_ids(conn) == {"1", "2", "4"}, repr(open_ids(conn)))
        load(conn, board([1, 2, 3], "2026-11-02T10:01:00+00:00"), tmp)
        check("an older poll arriving later is skipped: 3 stays closed and 4 stays open",
              open_ids(conn) == {"1", "2", "4"}, repr(open_ids(conn)))
        stored = conn.execute("SELECT observed_at FROM companies WHERE domain = 'acme.com'").fetchone()[0]
        check("the company keeps the newer poll time", stored == "2026-11-02T10:05:00+00:00", stored)
        load(conn, board([1, 2, 4, 5], "2026-11-02T10:10:00+00:00"), tmp)
        check("a newer poll after that applies", open_ids(conn) == {"1", "2", "4", "5"}, repr(open_ids(conn)))
        load(conn, board([1, 2, 4]), tmp)
        check("an entry with no stamp (an older producer) applies as before", open_ids(conn) == {"1", "2", "4"}, repr(open_ids(conn)))
        conn.close()
    print(f"\n{len(failures)} failed" if failures else "\nall passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
