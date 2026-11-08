"""A read of one ATS board only closes that board's jobs. Accenture posts
on Workday (past the 2,000 listing limit, so its reads close nothing) and
on a 16-job Pinpoint board; keyed by domain alone, every complete Pinpoint
read ran the clock on the Workday jobs and 976 live ones closed in an hour
on 2026-11-05.

Run directly, no framework:  python tests/test_close_per_board.py
"""

import json
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "loader"))

import load_to_sqlite  # noqa: E402
from load_to_sqlite import load_resolved, open_db  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}: {name}{'' if ok else '  -- ' + detail}")
    if not ok:
        failures.append(name)


T0 = datetime(2026, 11, 5, 0, 0, tzinfo=timezone.utc)


def board(ats, ids, complete=True):
    return {"domain": "acme.com", "ats": ats, "token": "acme", "confidence": "verified", "job_count": len(ids),
            "complete": complete, "jobs": [{"external_id": f"{ats}-{n}", "ats": ats, "title": f"Engineer {n}",
                                            "url": f"https://acme.com/{ats}/{n}", "location": "Tel Aviv, Israel"}
                                           for n in ids]}


def apply(conn, tmp, hours, *entries):
    stamp = (T0 + timedelta(hours=hours)).isoformat(timespec="seconds")
    load_to_sqlite.now_iso = lambda: stamp
    (tmp / "r.json").write_text(json.dumps(list(entries)), encoding="utf-8")
    with conn:
        load_resolved(conn, tmp / "r.json")


def open_ids(conn, ats):
    return {r[0] for r in conn.execute("SELECT external_id FROM jobs WHERE ats = ? AND closed_at IS NULL", (ats,))}


with tempfile.TemporaryDirectory() as td:
    tmp = Path(td)
    conn = open_db(tmp / "t.db")
    apply(conn, tmp, 0, board("workday", [1, 2, 3]), board("pinpoint", [1]))
    # Workday's capped read sees only 1 and 2; Pinpoint reads keep coming, complete.
    for h in (1, 3, 5, 7, 9):
        apply(conn, tmp, h, board("workday", [1, 2], complete=False))
        apply(conn, tmp, h + 0.5, board("pinpoint", [1]))
    check("complete reads of another board never close a job",
          open_ids(conn, "workday") == {"workday-1", "workday-2", "workday-3"}, str(open_ids(conn, "workday")))
    check("and its clock never started",
          conn.execute("SELECT missing_reads FROM jobs WHERE external_id = 'workday-3'").fetchone()[0] in (None, 0))

    # The board's own complete reads still close what they stop returning.
    for h in (10, 13, 17):
        apply(conn, tmp, h, board("pinpoint", []))
    check("a board's own complete reads still close its jobs", open_ids(conn, "pinpoint") == set(),
          str(open_ids(conn, "pinpoint")))

    # Two boards in one batch: the second no longer replaces the first's seen jobs.
    for h in (20, 24, 28):
        apply(conn, tmp, h, board("workday", [1, 2, 3]), board("pinpoint", []))
    check("two boards of one company in one batch both count",
          open_ids(conn, "workday") == {"workday-1", "workday-2", "workday-3"}, str(open_ids(conn, "workday")))
    conn.close()

print()
if failures:
    print(f"{len(failures)} failed")
    sys.exit(1)
print("all passed")
