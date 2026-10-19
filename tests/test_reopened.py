"""reopened_at: when a listing, the same ATS id, came back after being
gone from the employer's board for at least two days.

Run directly, no framework:  python tests/test_reopened.py
"""

import json
import os
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

from load_to_sqlite import load_resolved, open_db  # noqa: E402
import handler  # noqa: E402
import job_filters  # noqa: E402

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
    load(conn, tmp, [1, 1, 2, 3])  # same second as the last load, and the same id twice
    check("the mark survives the next reads", rows(conn)["1"]["reopened_at"] == when)
    conn.execute("UPDATE jobs SET closed_at = ?, reopened_at = ? WHERE external_id = '1'", (ago(days=5), ago(days=30)))
    conn.commit()
    load(conn, tmp, [1, 2, 3])
    check("a second reappearance moves the mark to the latest", rows(conn)["1"]["reopened_at"] > ago(minutes=5), str(rows(conn)["1"]))

    # The production check: what the loader wrote, read back through the API.
    meta = dict(conn.execute("SELECT key, value FROM meta WHERE key LIKE 'reopened_%'").fetchall())
    check("each reappearance is counted once in meta", meta.get("reopened_count") == "2", str(meta))
    job_filters.register_functions(conn)
    handler.get_connection = lambda: conn
    handler._description_from_s3 = lambda job_id: None
    health = handler.route_health()["reappeared"]
    check("health says the column exists", health["column"] is True, str(health))
    check("health reports the count and the latest job", health["recorded"] == 2 and health["last_job_id"], str(health))
    job = handler.route_job_detail(health["last_job_id"])
    check("that job, read through the API, carries the same time",
          job and job["reopened_at"] == health["last_at"] == rows(conn)["1"]["reopened_at"], f"{job and job.get('reopened_at')} vs {health}")
    conn.close()

# A database the loader has not migrated yet: health must say so, not guess.
import sqlite3  # noqa: E402
bare = sqlite3.connect(":memory:")
bare.row_factory = sqlite3.Row
bare.executescript("""CREATE TABLE jobs (id TEXT, closed_at TEXT); CREATE TABLE companies (domain TEXT, ats TEXT, last_checked TEXT);
                      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);""")
handler.get_connection = lambda: bare
health = handler.route_health()["reappeared"]
check("before the migration, health reports no column and nothing recorded",
      health == {"column": False, "recorded": 0, "last_at": None, "last_job_id": None}, str(health))

print()
if failures:
    print(f"{len(failures)} failed")
    sys.exit(1)
print("all passed")
