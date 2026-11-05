"""A Comeet job's date: Comeet's own time_updated unless we read the board
recently, when first sight is the better posting time.

Run directly, no framework:  python tests/test_comeet_dates.py
"""
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "loader"))

import load_to_sqlite  # noqa: E402
from load_to_sqlite import load_resolved, open_db  # noqa: E402

failed = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failed.append(name)


COMEET_DATE = "2026-09-01T08:00:00+00:00"


def read(conn, tmp, at, ids):
    load_to_sqlite.now_iso = lambda: at
    jobs = [{"external_id": str(n), "ats": "comeet", "title": f"Engineer {n}", "url": f"https://acme.com/{n}",
             "location": "Tel Aviv, Israel", "posted_at": COMEET_DATE} for n in ids]
    path = tmp / "resolved.json"
    path.write_text(json.dumps([{"domain": "acme.com", "ats": "comeet", "token": "1.1:t", "confidence": "verified",
                                 "job_count": len(ids), "jobs": jobs}]), encoding="utf-8")
    with conn:
        load_resolved(conn, path)


def posted(conn, n):
    return conn.execute("SELECT posted_at FROM jobs WHERE external_id = ?", (str(n),)).fetchone()[0]


with tempfile.TemporaryDirectory() as td:
    tmp = Path(td)
    conn = open_db(tmp / "t.db")
    read(conn, tmp, "2026-09-10T10:00:00+00:00", [1])
    check("a new company's jobs keep Comeet's date", posted(conn, 1) == COMEET_DATE, posted(conn, 1))

    read(conn, tmp, "2026-09-10T12:00:00+00:00", [1, 2])
    check("a job new on a board read two hours ago is dated when we saw it",
          posted(conn, 2) == "2026-09-10T12:00:00+00:00", posted(conn, 2))

    read(conn, tmp, "2026-11-04T12:35:00+00:00", [1, 2, 3])
    check("a job new on a board unread for two months keeps Comeet's date",
          posted(conn, 3) == COMEET_DATE, posted(conn, 3))
    conn.close()

print()
if failed:
    print(f"{len(failed)} failed")
    sys.exit(1)
print("all passed")
