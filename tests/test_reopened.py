"""reopened_at: when a listing, the same ATS id, came back after being
gone from the employer's board for at least two days.

Run directly, no framework:  python tests/test_reopened.py
"""

import json
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "loader"))

from load_to_sqlite import load_resolved, open_db  # noqa: E402

failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}: {name}{'' if ok else '  -- ' + detail}")
    if not ok:
        failures.append(name)


def job(n: int) -> dict:
    return {"external_id": str(n), "ats": "greenhouse", "title": f"Engineer {n}",
            "url": f"https://acme.com/{n}", "location": "Tel Aviv, Israel"}


def load(conn, tmp: Path, ids: list[int]) -> None:
    path = tmp / "resolved.json"
    path.write_text(json.dumps([{"domain": "acme.com", "ats": "greenhouse", "token": "acme",
                                 "confidence": "verified", "job_count": len(ids),
                                 "jobs": [job(n) for n in ids]}]), encoding="utf-8")
    with conn:
        load_resolved(conn, path)


def rows(conn) -> dict:
    return {r["external_id"]: dict(r) for r in conn.execute("SELECT external_id, first_seen, closed_at, reopened_at FROM jobs")}


def ago(**kw) -> str:
    return (datetime.now(timezone.utc) - timedelta(**kw)).isoformat(timespec="seconds")


with tempfile.TemporaryDirectory() as td:
    tmp = Path(td)
    conn = open_db(tmp / "t.db")

    load(conn, tmp, [1, 2, 3])
    check("new listings have no reappearance", all(r["reopened_at"] is None for r in rows(conn).values()))
    first_seen = rows(conn)["1"]["first_seen"]

    # A read that missed listing 3 closes it; the next read brings it back
    # within seconds. That is the glitch the two days are there for.
    load(conn, tmp, [1, 2])
    check("a listing missing from a read is closed", rows(conn)["3"]["closed_at"] is not None)
    load(conn, tmp, [1, 2, 3])
    check("back on the next read: not a reappearance", rows(conn)["3"]["reopened_at"] is None, str(rows(conn)["3"]))

    # Gone three days, gone one day.
    conn.execute("UPDATE jobs SET closed_at = ? WHERE external_id = '1'", (ago(days=3),))
    conn.execute("UPDATE jobs SET closed_at = ? WHERE external_id = '2'", (ago(hours=20),))
    conn.commit()
    load(conn, tmp, [1, 2, 3])
    r = rows(conn)
    check("back after three days is a reappearance", r["1"]["reopened_at"] is not None and r["1"]["closed_at"] is None, str(r["1"]))
    check("back after twenty hours is not", r["2"]["reopened_at"] is None, str(r["2"]))
    check("a reappearance keeps the listing's first_seen", r["1"]["first_seen"] == first_seen)
    check("a listing that was never gone stays unmarked", r["3"]["reopened_at"] is None)

    # It stays marked while it stays listed, and moves if it goes and comes back again.
    when = r["1"]["reopened_at"]
    load(conn, tmp, [1, 2, 3])
    check("the mark survives the next reads", rows(conn)["1"]["reopened_at"] == when)
    conn.execute("UPDATE jobs SET closed_at = ?, reopened_at = ? WHERE external_id = '1'", (ago(days=5), ago(days=30)))
    conn.commit()
    load(conn, tmp, [1, 2, 3])
    check("a second reappearance moves the mark to the latest", rows(conn)["1"]["reopened_at"] > ago(minutes=5), str(rows(conn)["1"]))
    conn.close()

print()
if failures:
    print(f"{len(failures)} failed")
    sys.exit(1)
print("all passed")
