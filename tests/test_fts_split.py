"""The search index in its own file (box/split_fts.py, job_filters.attach_fts).

A small jobs.db with the box's five-column index and real rowid gaps is
split the way the worker splits the live one, then:
  - searches through the attached pair match the original, query by query;
  - a missing search file or a mismatched epoch turns the index off and
    the LIKE path answers, never the wrong rowids;
  - the loader, opened the way the box opens it, updates and deletes
    index rows through the attach (the rowid-delete probe reads the
    attached schema, so no duplicate rowids);
  - reopening the main file never recreates an empty jobs_fts in it;
  - the API's connection attaches the file and reports the index.

Run directly, no framework:  python tests/test_fts_split.py
"""
import json
import os
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
for _k, _v in {"ALERTS_TABLE": "test-alerts", "DATA_BUCKET": "test-bucket", "DATA_KEY": "jobs.db",
               "AWS_DEFAULT_REGION": "il-central-1", "AWS_ACCESS_KEY_ID": "testing",
               "AWS_SECRET_ACCESS_KEY": "testing"}.items():
    os.environ.setdefault(_k, _v)
sys.path.insert(0, str(ROOT / "loader"))
sys.path.insert(0, str(ROOT / "api"))
sys.path.insert(0, str(ROOT / "box"))

import load_to_sqlite  # noqa: E402
import split_fts  # noqa: E402
from job_filters import _read_caps, attach_fts, build_jobs_where, register_functions  # noqa: E402
from load_to_sqlite import _fts_supports_rowid_delete, load_resolved, open_db  # noqa: E402

TS = "2026-09-20T00:00:00+00:00"
failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}: {name}{'' if ok else '  -- ' + detail}")
    if not ok:
        failures.append(name)


WORDS = ["python", "kubernetes", "react", "devops", "golang", "java", "rust", "android", "security", "finance"]


def payload(domain: str, jobs: list[tuple[str, str, str]]) -> list[dict]:
    return [{
        "domain": domain, "ats": "greenhouse", "token": domain.split(".")[0],
        "confidence": "verified", "checked_at": TS,
        "jobs": [{"external_id": ext, "ats": "greenhouse", "title": title,
                  "url": f"https://{domain}/{ext}", "location": "Tel Aviv, Israel",
                  "department": "Engineering", "posted_at": TS,
                  "description": desc, "description_chars": len(desc)} for ext, title, desc in jobs],
    }]


def load(conn, tmp: Path, data: list[dict]) -> None:
    path = tmp / "resolved.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    with conn:
        load_resolved(conn, path, True)


def search(conn, term: str) -> list[str]:
    where, args = build_jobs_where({"search": term, "confidence": "all"}, _read_caps(conn))
    return [r[0] for r in conn.execute(f"SELECT id FROM jobs WHERE {where} ORDER BY id", args)]


tmp = Path(tempfile.mkdtemp())
load_to_sqlite.put_many = lambda bucket, items: {jid for jid, _ in items}  # no S3 here: every upload 'lands'
load_to_sqlite.get_one = lambda *a, **k: None
src = tmp / "src.db"
conn = open_db(src)
with conn:
    conn.execute("DROP TABLE IF EXISTS jobs_fts")
    conn.execute("CREATE VIRTUAL TABLE jobs_fts USING fts5(title, company_domain, location, department, "
                 "description, content='', contentless_delete=1)")
    conn.execute("INSERT INTO meta (key, value) VALUES ('fts_complete', '1') ON CONFLICT(key) DO UPDATE SET value='1'")
jobs = [(str(i), f"{WORDS[i % len(WORDS)].title()} Engineer {i}",
         f"We use {WORDS[i % len(WORDS)]} and {WORDS[(i * 3) % len(WORDS)]} every day. Marker mk{i}z.") for i in range(60)]
load(conn, tmp, payload("acme.com", jobs))
# Rowid gaps, the way the archive leaves them: rows and their index entries gone.
with conn:
    gone = [r[0] for r in conn.execute("SELECT rowid FROM jobs WHERE rowid % 7 = 3")]
    conn.executemany("DELETE FROM jobs_fts WHERE rowid = ?", [(g,) for g in gone])
    conn.executemany("DELETE FROM jobs WHERE rowid = ?", [(g,) for g in gone])
conn.close()

before = sqlite3.connect(src)
register_functions(before)
original = {w: search(before, w) for w in WORDS + ["zzqqxx"]}
check("the source answers searches from its index", _read_caps(before).fts and len(original["python"]) > 0,
      repr(_read_caps(before)))
before.close()

# The split, as the worker runs it.
out = tmp / "split"
out.mkdir()
src_hash, rows, max_rowid = split_fts.rowid_map_hash(src)
epoch = "test-" + src_hash[:12]
split_fts.build_main(src, out / "jobs.db", epoch)
split_fts.build_fts(src, out / "jobs-fts.db", epoch)
try:
    report = split_fts.verify(src, out, src_hash, rows)
    check("the split verifies: rowid map, index rows, fixed queries, both fallbacks", True)
except SystemExit as e:
    report = {}
    check("the split verifies: rowid map, index rows, fixed queries, both fallbacks", False, str(e))

main_db, fts_db = out / "jobs.db", out / "jobs-fts.db"
m = sqlite3.connect(main_db)
check("the main file has no search index and is marked so", not m.execute(
    "SELECT 1 FROM sqlite_master WHERE name = 'jobs_fts'").fetchone()
      and m.execute("SELECT value FROM meta WHERE key = 'fts_retired'").fetchone() == ("1",))
check("the main file carries the epoch", m.execute(
    "SELECT value FROM meta WHERE key = 'fts_rowid_epoch'").fetchone() == (epoch,))
m.close()
f = sqlite3.connect(fts_db)
tables = {r[0] for r in f.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
check("the search file holds the index and meta, nothing else",
      "jobs" not in tables and "companies" not in tables and "jobs_fts" in tables and "meta" in tables, repr(tables))
check("the search file carries the same epoch and the complete mark",
      dict(f.execute("SELECT key, value FROM meta")) == {"fts_rowid_epoch": epoch, "fts_complete": "1"})
f.close()

pair = sqlite3.connect(f"file:{main_db.as_posix()}?mode=ro", uri=True)
register_functions(pair)
check("the attach happens", attach_fts(pair, main_db))
check("searches through the pair match the original for every word",
      all(search(pair, w) == original[w] for w in original),
      repr({w: (search(pair, w), original[w]) for w in original if search(pair, w) != original[w]}))
pair.close()

# Fallbacks.
bare = sqlite3.connect(f"file:{main_db.as_posix()}?mode=ro", uri=True)
register_functions(bare)
check("without the search file the index is off and the LIKE path still finds titles",
      not _read_caps(bare).fts and len(search(bare, "python")) > 0)
bare.close()
mis = tmp / "mismatch"
mis.mkdir()
shutil.copyfile(main_db, mis / "jobs.db")
shutil.copyfile(fts_db, mis / "jobs-fts.db")
c = sqlite3.connect(mis / "jobs.db")
c.execute("UPDATE meta SET value = 'other' WHERE key = 'fts_rowid_epoch'")
c.commit()
c.close()
c = sqlite3.connect(f"file:{(mis / 'jobs.db').as_posix()}?mode=ro", uri=True)
register_functions(c)
attach_fts(c, mis / "jobs.db")
check("a mismatched epoch turns the index off", not _read_caps(c).fts, repr(_read_caps(c)))
c.close()

# The loader, the way the box opens it.
live = tmp / "live"
live.mkdir()
shutil.copyfile(main_db, live / "jobs.db")
shutil.copyfile(fts_db, live / "jobs-fts.db")
conn = open_db(live / "jobs.db")
check("reopening the main file does not recreate jobs_fts in it", not conn.execute(
    "SELECT 1 FROM main.sqlite_master WHERE name = 'jobs_fts'").fetchone())
check("the loader attaches the search file read-write", attach_fts(conn, live / "jobs.db", readonly=False))
check("the rowid-delete probe reads the attached schema", _fts_supports_rowid_delete(conn))
changed = [(ext, t, d) for ext, t, d in jobs if int(ext) % 7 != 3]
changed[0] = (changed[0][0], changed[0][1], "Now about zebrafish husbandry only.")
load(conn, tmp, payload("acme.com", changed))
dup = conn.execute("SELECT id, COUNT(*) FROM fts.jobs_fts_docsize GROUP BY id HAVING COUNT(*) > 1").fetchall()
check("an update through the attach leaves no duplicate rowids", not dup, repr(dup))
first_id = conn.execute("SELECT id FROM jobs WHERE external_id = ?", (changed[0][0],)).fetchone()[0]
check("the new words are searchable", first_id in search(conn, "zebrafish"), repr(search(conn, "zebrafish")))
marker = f"mk{changed[0][0]}z"
check("the replaced description's own words no longer find that listing",
      first_id not in search(conn, marker), repr(search(conn, marker)))
check("a listing whose text did not change is still found by its marker",
      len(search(conn, f"mk{changed[1][0]}z")) == 1, repr(search(conn, f"mk{changed[1][0]}z")))
victim = conn.execute("SELECT rowid FROM jobs WHERE external_id = '1'").fetchone()[0]
with conn:
    conn.execute("DELETE FROM jobs_fts WHERE rowid = ?", (victim,))
check("a delete by rowid reaches the attached index",
      not conn.execute("SELECT 1 FROM fts.jobs_fts_docsize WHERE id = ?", (victim,)).fetchone())
conn.close()

# The API's own connection.
import db  # noqa: E402

api = db._open_readonly(str(live / "jobs.db"))
check("the API connection attaches the search file and uses the index",
      api.execute("SELECT 1 FROM pragma_database_list WHERE name = 'fts'").fetchone() is not None and _read_caps(api).fts)
api.close()

print()
if failures:
    print(f"{len(failures)} failed:")
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
