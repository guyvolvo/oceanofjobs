"""Closed listings leave after 14 days, in batches (loader/archive.py), and
the 90-day skills chart keeps counting them (closed_history).

  - a run stops at its batch size, leaves the daily marker alone so the
    next apply continues, and the last batch marks the day done;
  - closed 20 days ago goes, closed 10 days ago stays, open stays;
  - each retired listing leaves two dates, its skills and its country in
    closed_history, which forgets anything past 90 days;
  - aggregates.skills_history counts a retired listing on the days it
    was open, and not after it closed.

Run directly, no framework:  python tests/test_retention.py
"""
import json
import os
import sqlite3
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
for _k, _v in {"ALERTS_TABLE": "test-alerts", "AWS_DEFAULT_REGION": "il-central-1",
               "AWS_ACCESS_KEY_ID": "testing", "AWS_SECRET_ACCESS_KEY": "testing"}.items():
    os.environ.setdefault(_k, _v)
sys.path.insert(0, str(ROOT / "loader"))
sys.path.insert(0, str(ROOT / "api"))

import aggregates  # noqa: E402
import archive  # noqa: E402
import load_to_sqlite  # noqa: E402
from job_filters import register_functions  # noqa: E402
from load_to_sqlite import _fts_supports_rowid_delete, load_resolved, open_db  # noqa: E402

NOW = datetime.now(timezone.utc)
failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}: {name}{'' if ok else '  -- ' + detail}")
    if not ok:
        failures.append(name)


def ago(days: float) -> str:
    return (NOW - timedelta(days=days)).isoformat(timespec="seconds")


class S3:
    marks = 0
    archived = 0

    def put_object(self, **kw):
        if kw["Key"] == archive.MARKER_KEY:
            S3.marks += 1
        else:
            S3.archived += 1

    def get_object(self, **kw):
        raise KeyError(kw["Key"])


tmp = Path(tempfile.mkdtemp())
load_to_sqlite.DESCRIPTIONS_BUCKET = None
db = tmp / "jobs.db"
conn = open_db(db)
path = tmp / "resolved.json"
path.write_text(json.dumps([{
    "domain": "acme.com", "ats": "greenhouse", "token": "acme", "confidence": "verified",
    "jobs": [{"external_id": str(i), "ats": "greenhouse", "title": f"Engineer {i}", "url": f"https://acme.com/{i}",
              "location": "Tel Aviv, Israel", "posted_at": ago(1), "skills": ["Python", "AWS"]}
             for i in range(12)],
}]), encoding="utf-8")
with conn:
    load_resolved(conn, path)
ids = [r[0] for r in conn.execute("SELECT id FROM jobs ORDER BY rowid")]
retire, keep = ids[1:6], ids[6:8]  # the last rowid stays open: archive never retires the maximum
with conn:
    conn.executemany("UPDATE jobs SET closed_at = ?, first_seen = ? WHERE id = ?",
                     [(ago(20), ago(40), j) for j in retire] + [(ago(10), ago(40), j) for j in keep])
    conn.execute("INSERT INTO closed_history VALUES (?, ?, 'Python,AWS', 'IL')", (ago(130)[:10], ago(100)[:10]))

rowid_delete = _fts_supports_rowid_delete(conn)
with conn:
    first = archive.prune(conn, S3(), "bucket", archive.RETAIN_DAYS, rowid_delete, limit=3)
check("retention is 14 days", archive.RETAIN_DAYS == 14)
check("a batch stops at the limit and asks for another run", first["archived"] == 3 and first["more"], str(first))
check("and leaves the daily marker alone, so the next apply continues", S3.marks == 0)
with conn:
    second = archive.prune(conn, S3(), "bucket", archive.RETAIN_DAYS, rowid_delete, limit=3)
check("the next run takes the rest and marks the day done",
      second["archived"] == 2 and not second["more"] and S3.marks == 1, str(second))
check("every retired listing was written to the archive first", S3.archived >= 2)
left = {r[0] for r in conn.execute("SELECT id FROM jobs")}
check("closed 20 days ago is gone, closed 10 days ago and open stay",
      not (set(retire) & left) and set(keep) <= left and len(left) == len(ids) - len(retire))
hist = conn.execute("SELECT first_seen, closed_at, skills, country FROM closed_history ORDER BY closed_at").fetchall()
check("closed_history keeps two dates, the skills and the country of each",
      len(hist) == len(retire) and all(h[0] == ago(40)[:10] and h[1] == ago(20)[:10] and h[2] == "Python,AWS"
                                       and h[3] == "IL" for h in hist), str([tuple(h) for h in hist]))
check("and forgot the row past 90 days", all(h[1] >= ago(90)[:10] for h in hist))
conn.close()

ro = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)
ro.row_factory = sqlite3.Row
register_functions(ro)
days = {d["day"]: d["open"] for d in aggregates.skills_history(ro, {"skills": "python,aws", "min_match": "2"})["days"]}
# Everything else was first seen today, so 30 days ago only the seven
# back-dated listings were open, five of them now in closed_history.
day30, day15, day5 = ago(30)[:10], ago(15)[:10], ago(5)[:10]
check("30 days ago the chart counts the retired listings beside the kept ones",
      days.get(day30) == len(retire) + len(keep), f"{days.get(day30)} open on {day30}")
check("15 days ago only the two closed later", days.get(day15) == len(keep), f"{days.get(day15)} open on {day15}")
check("5 days ago none of them", days.get(day5) == 0, f"{days.get(day5)} open on {day5}")
ro.close()

print()
if failures:
    print(f"{len(failures)} failed:")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)
print("all passed")
