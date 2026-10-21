"""Compacting jobs.db beside the live one (box/compact_db.py).

A small box-shaped pair (jobs.db with the search index beside it in
jobs-fts.db, rowid gaps, free pages, planner statistics) is compacted,
and then:
  - the verifier passes: rowid map, schema, counts, meta, sampled rows,
    the search check queries through jobs-fts.db;
  - the copy is smaller, has no free pages, and kept sqlite_stat1;
  - the verifier fails on a copy whose rowids, rows or epoch differ;
  - a build refuses when another connection commits to the source while
    it runs;
  - the loader and the API, unchanged, work on the swapped file: an apply
    through the attached index, then a search that finds it.

Run directly, no framework:  python tests/test_compact_db.py
"""
import json
import os
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
for _k, _v in {"ALERTS_TABLE": "test-alerts", "AWS_DEFAULT_REGION": "il-central-1",
               "AWS_ACCESS_KEY_ID": "testing", "AWS_SECRET_ACCESS_KEY": "testing"}.items():
    os.environ.setdefault(_k, _v)
sys.path.insert(0, str(ROOT / "loader"))
sys.path.insert(0, str(ROOT / "api"))
sys.path.insert(0, str(ROOT / "box"))

import compact_db  # noqa: E402
import load_to_sqlite  # noqa: E402
import split_fts  # noqa: E402
from job_filters import _read_caps, attach_fts, build_jobs_where, register_functions  # noqa: E402
from load_to_sqlite import load_resolved, open_db  # noqa: E402

TS = "2026-10-20T00:00:00+00:00"
failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}: {name}{'' if ok else '  -- ' + detail}")
    if not ok:
        failures.append(name)


WORDS = ["python", "kubernetes", "react", "devops", "golang", "java", "rust", "android", "security", "finance"]


def payload(jobs):
    return [{"domain": "acme.com", "ats": "greenhouse", "token": "acme", "confidence": "verified",
             "jobs": [{"external_id": ext, "ats": "greenhouse", "title": title, "url": f"https://acme.com/{ext}",
                       "location": "Tel Aviv, Israel", "department": "Engineering", "posted_at": TS,
                       "description": desc, "description_chars": len(desc)} for ext, title, desc in jobs]}]


def load(conn, tmp: Path, jobs) -> None:
    path = tmp / "resolved.json"
    path.write_text(json.dumps(payload(jobs)), encoding="utf-8")
    with conn:
        load_resolved(conn, path, True)


def search(conn, term: str) -> list[str]:
    where, args = build_jobs_where({"search": term, "confidence": "all"}, _read_caps(conn))
    return [r[0] for r in conn.execute(f"SELECT id FROM jobs WHERE {where} ORDER BY id", args)]


def expect_refusal(name: str, fn) -> None:
    try:
        fn()
        check(name, False, "no refusal")
    except SystemExit as e:
        check(name, True)
        print(f"      ({e})")


tmp = Path(tempfile.mkdtemp())
load_to_sqlite.put_many = lambda bucket, items: {jid for jid, _ in items}  # every upload 'lands'
load_to_sqlite.get_one = lambda *a, **k: None

# The box's layout, the way split_fts.py made it.
src = tmp / "src.db"
conn = open_db(src)
with conn:
    conn.execute("DROP TABLE IF EXISTS jobs_fts")
    conn.execute("CREATE VIRTUAL TABLE jobs_fts USING fts5(title, company_domain, location, department, "
                 "description, content='', contentless_delete=1)")
    conn.execute("INSERT INTO meta (key, value) VALUES ('fts_complete', '1') ON CONFLICT(key) DO UPDATE SET value='1'")
jobs = [(str(i), f"{WORDS[i % len(WORDS)].title()} Engineer {i}",
         f"We use {WORDS[i % len(WORDS)]} and {WORDS[(i * 3) % len(WORDS)]} daily.") for i in range(80)]
load(conn, tmp, jobs)
with conn:
    gone = [r[0] for r in conn.execute("SELECT rowid FROM jobs WHERE rowid % 7 = 3")]
    conn.executemany("DELETE FROM jobs_fts WHERE rowid = ?", [(g,) for g in gone])
    conn.executemany("DELETE FROM jobs WHERE rowid = ?", [(g,) for g in gone])
conn.close()
box = tmp / "box"
box.mkdir()
split_fts.build_main(src, box / "jobs.db", "test-epoch")
split_fts.build_fts(src, box / "jobs-fts.db", "test-epoch")
live = box / "jobs.db"
# Slack, the way the applier leaves it: pages freed by deleted rows.
c = sqlite3.connect(live)
c.execute("CREATE TABLE junk (b BLOB)")
c.executemany("INSERT INTO junk VALUES (randomblob(4000))", [()] * 500)
c.commit()
c.execute("DROP TABLE junk")
c.execute("ANALYZE")
c.commit()
free_before = c.execute("PRAGMA freelist_count").fetchone()[0]
stat_before = sorted(c.execute("SELECT * FROM sqlite_stat1").fetchall())
c.close()
check("the fixture carries free pages and statistics", free_before > 400 and stat_before, str(free_before))

out = box / "compact" / "g1"
out.mkdir(parents=True)
built = compact_db.build(live, out / "jobs.db")
try:
    report = compact_db.verify(live, out / "jobs.db", built, sample=200)
    check("the copy verifies", True)
except SystemExit as e:
    report = {}
    check("the copy verifies", False, str(e))
check("the search checks ran through jobs-fts.db, the index in use",
      report.get("queries_identical") == len(split_fts.CHECK_QUERIES) and report.get("search_index_used") is True,
      str(report))
check("rows were compared", report.get("rows_compared", 0) > 50, str(report.get("rows_compared")))
copy = out / "jobs.db"
check("the copy is smaller", copy.stat().st_size < live.stat().st_size,
      f"{copy.stat().st_size} vs {live.stat().st_size}")
c = sqlite3.connect(copy)
check("with no free pages", c.execute("PRAGMA freelist_count").fetchone()[0] == 0)
check("and the planner's statistics as they were", sorted(c.execute("SELECT * FROM sqlite_stat1").fetchall()) == stat_before)
c.close()


def tampered(sql: str) -> Path:
    bad = box / "compact" / "bad.db"
    shutil.copyfile(copy, bad)
    t = sqlite3.connect(bad)
    t.execute(sql)
    t.commit()
    t.close()
    return bad


expect_refusal("a copy missing a row fails the rowid map",
               lambda: compact_db.verify(live, tampered("DELETE FROM jobs WHERE rowid = (SELECT MIN(rowid) FROM jobs)"),
                                         built, 200))
expect_refusal("a copy with a renumbered row fails the rowid map",
               lambda: compact_db.verify(live, tampered(
                   "UPDATE jobs SET rowid = (SELECT MAX(rowid) + 1 FROM jobs) WHERE rowid = (SELECT MIN(rowid) FROM jobs)"),
                   built, 200))
expect_refusal("a copy with another epoch fails meta",
               lambda: compact_db.verify(live, tampered(
                   "UPDATE meta SET value = 'other' WHERE key = 'fts_rowid_epoch'"), built, 200))
expect_refusal("a copy with a changed row fails the sample",
               lambda: compact_db.verify(live, tampered("UPDATE jobs SET title = 'changed'"), built, 200))

# A writer committing during the build makes it refuse.
original_state = compact_db._state


def state_then_write(conn):
    state = original_state(conn)
    w = sqlite3.connect(live)
    w.execute("UPDATE meta SET value = value WHERE key = 'fts_rowid_epoch'")
    w.execute("INSERT INTO meta (key, value) VALUES ('touched', '1')")
    w.commit()
    w.close()
    return state


compact_db._state = state_then_write
expect_refusal("a build refuses when the source changes under it",
               lambda: compact_db.build(live, box / "compact" / "moving.db"))
compact_db._state = original_state
w = sqlite3.connect(live)
w.execute("DELETE FROM meta WHERE key = 'touched'")
w.commit()
w.close()

# The swap, as swap_compact.sh does it, minus systemd. Then the loader and
# the API exactly as they are today.
shutil.move(str(live), str(box / "jobs.db.pre-compact"))
shutil.move(str(copy), str(live))
conn = open_db(live)
check("the box's loader opens it", True)
check("and attaches the search index", attach_fts(conn, live, readonly=False))
jobs[0] = (jobs[0][0], jobs[0][1], "Rewritten with zephyrword inside.")
jobs.append(("new1", "Quasarword Engineer", "A brand new listing."))
load(conn, tmp, jobs)
check("an apply updates and adds through the index",
      len(search(conn, "zephyrword")) == 1 and len(search(conn, "quasarword")) == 1)
new_rowid = conn.execute("SELECT rowid FROM jobs WHERE title = 'Quasarword Engineer'").fetchone()[0]
check("a new listing takes a rowid past every one the old file issued", new_rowid > built["max_rowid"],
      f"{new_rowid} vs {built['max_rowid']}")
conn.close()

api = sqlite3.connect(f"file:{live.as_posix()}?mode=ro", uri=True)
register_functions(api)
attach_fts(api, live)
caps = _read_caps(api)
check("the API's read of it uses the index", caps.fts and caps.fts_full)
check("and finds the new listing", len(search(api, "quasarword")) == 1)
api.close()

print()
if failures:
    print(f"{len(failures)} failed:")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)
print("all passed")
