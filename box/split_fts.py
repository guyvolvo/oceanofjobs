"""Split jobs.db into the board's file and the search index's file.

    python box/split_fts.py --src restored.db --out-dir split/ [--generation G]
                            [--expect "rows,max_rowid"] [--upload s3://bucket/split/]

Run on a worker, never on the box: it copies and VACUUMs a file bigger
than the box's memory twice, and the last time that ran on the serving
box (2026-09-23) it drained the disk's burst budget and took the site
down. The source is a Litestream restore of the box's live file.

What comes out, in --out-dir:
  jobs.db       everything but the search index, marked fts_retired so
                the loader never recreates an empty one that would shadow
                the attached file; VACUUMed (about 1.2GB from 5.7GB)
  jobs-fts.db   the search index (jobs_fts and its shadow tables) and a
                meta table, nothing else; VACUUMed
  manifest.json generation, epoch, row counts, and sha256 per file

The invariant (also beside api/job_filters._read_caps):
  jobs-fts.db is derived from jobs.db. Its rowids are jobs.rowid values
  of one generation of the main file, named by meta.fts_rowid_epoch and
  stamped in both files here. Epochs equal: search uses the index.
  Epochs differ or the file is missing: search falls back to LIKE,
  degraded but never wrong. Anything that may change main's rowids
  (VACUUM, a restore from another generation) must bump main's epoch,
  rebuild this file against the new rowids, stamp the new epoch in it,
  and only then swap it in. Bumping alone invalidates; it does not repair.

jobs has an implicit rowid (id TEXT PRIMARY KEY), and SQLite reserves
the right to renumber those on VACUUM. So this does not trust it: the
rowid-to-id map is hashed before and after, and a mismatch stops the
build before anything is written out.
"""

import argparse
import hashlib
import json
import shutil
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))

FTS_TABLE = "jobs_fts"
EPOCH_KEY = "fts_rowid_epoch"

# Fixed queries compared between the source and the split pair. Words the
# board's own visitors search for, a multi-word one, a Hebrew one, and one
# that must match nothing.
CHECK_QUERIES = ["python", "kubernetes", "react", "devops", "data engineer", "security", "golang",
                 "java", "product manager", "machine learning", "rust", "android", "sales",
                 "marketing", "hr", "finance", "backend", "frontend", "מפתח", "zzqqxxnotaword"]


def log(msg: str) -> None:
    print(f"{time.strftime('%H:%M:%S')} {msg}", flush=True)


def rowid_map_hash(path: Path) -> tuple[str, int, int]:
    """sha256 of every (rowid, id) of jobs in rowid order, the row count,
    and the largest rowid."""
    h = hashlib.sha256()
    conn = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
    n, top = 0, 0
    try:
        for rowid, jid in conn.execute("SELECT rowid, id FROM jobs ORDER BY rowid"):
            h.update(f"{rowid},{jid}\n".encode("utf-8"))
            n += 1
            top = rowid
    finally:
        conn.close()
    return h.hexdigest(), n, top


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _index_tables(conn) -> set[str]:
    """jobs_fts and its shadow tables (jobs_fts_data, _idx, _docsize, _config...)."""
    return {name for (name,) in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
            if name == FTS_TABLE or name.startswith(FTS_TABLE + "_")}


def _set_meta(conn, key: str, value: str | None) -> None:
    if value is None:
        conn.execute("DELETE FROM meta WHERE key = ?", (key,))
    else:
        conn.execute("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                     (key, value))


def build_main(src: Path, out: Path, epoch: str) -> None:
    """The board's file: a copy with the search index dropped, VACUUMed."""
    shutil.copyfile(src, out)
    conn = sqlite3.connect(out)
    try:
        conn.execute("PRAGMA journal_mode = DELETE")
        conn.execute(f"DROP TABLE IF EXISTS {FTS_TABLE}")
        # Marked, so open_db() never recreates an empty jobs_fts in main
        # (db/schema.sql says IF NOT EXISTS) that would shadow the attached one.
        _set_meta(conn, "fts_retired", "1")
        _set_meta(conn, "fts_complete", None)
        _set_meta(conn, EPOCH_KEY, epoch)
        conn.commit()
        conn.execute("VACUUM")
        conn.execute("PRAGMA journal_mode = WAL")
    finally:
        conn.close()


def build_fts(src: Path, out: Path, epoch: str) -> None:
    """The search file: a copy with everything but the index dropped, VACUUMed.

    A copy rather than a rebuild: the index is contentless, so its rows
    cannot be read back out and inserted elsewhere, and SQLite refuses
    writes to FTS5 shadow tables (ARCHITECTURE.md, the Sept experiment)."""
    shutil.copyfile(src, out)
    conn = sqlite3.connect(out)
    try:
        conn.execute("PRAGMA journal_mode = DELETE")
        keep = _index_tables(conn) | {"meta"}
        complete = conn.execute("SELECT value FROM meta WHERE key = 'fts_complete'").fetchone()
        for (name,) in conn.execute(
                "SELECT name FROM sqlite_master WHERE type IN ('view', 'trigger')").fetchall():
            kind = conn.execute("SELECT type FROM sqlite_master WHERE name = ?", (name,)).fetchone()[0]
            conn.execute(f'DROP {kind.upper()} IF EXISTS "{name}"')
        for (name,) in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall():
            if name not in keep and not name.startswith("sqlite_"):
                conn.execute(f'DROP TABLE IF EXISTS "{name}"')
        conn.execute("DELETE FROM meta")
        _set_meta(conn, "fts_complete", complete[0] if complete else None)
        _set_meta(conn, EPOCH_KEY, epoch)
        conn.commit()
        conn.execute("VACUUM")
        conn.execute("PRAGMA journal_mode = WAL")
    finally:
        conn.close()


def _search_ids(conn, term: str) -> list[str]:
    from job_filters import _read_caps, build_jobs_where
    caps = _read_caps(conn)
    where, args = build_jobs_where({"search": term, "confidence": "all"}, caps)
    return [r[0] for r in conn.execute(
        f"SELECT id FROM jobs WHERE {where} ORDER BY posted_at DESC, id LIMIT 300", args)]


def _open_pair(main: Path, attach: bool = True) -> sqlite3.Connection:
    from job_filters import attach_fts, register_functions
    conn = sqlite3.connect(f"file:{main.as_posix()}?mode=ro", uri=True)
    register_functions(conn)
    if attach:
        attach_fts(conn, main)
    return conn


def verify(src: Path, out_dir: Path, src_hash: str, rows: int) -> dict:
    """Everything the split must preserve. Raises on the first failure."""
    from job_filters import _read_caps, register_functions
    main, fts = out_dir / "jobs.db", out_dir / "jobs-fts.db"
    report: dict = {}

    h, n, _ = rowid_map_hash(main)
    if h != src_hash or n != rows:
        raise SystemExit(f"rowid map changed: {n} rows, hash {h[:12]} vs {rows} rows, {src_hash[:12]}. "
                         "Rebuild the search file from the new main with loader/fts_full.py instead.")
    report["rowid_map"] = "identical"

    for path in (main, fts):
        c = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
        ok = c.execute("PRAGMA quick_check").fetchone()[0]
        c.close()
        if ok != "ok":
            raise SystemExit(f"quick_check failed on {path.name}: {ok}")

    s = sqlite3.connect(f"file:{src.as_posix()}?mode=ro", uri=True)
    register_functions(s)
    pair = _open_pair(main)
    src_docs = s.execute(f"SELECT COUNT(*) FROM {FTS_TABLE}_docsize").fetchone()[0]
    pair_docs = pair.execute(f"SELECT COUNT(*) FROM fts.{FTS_TABLE}_docsize").fetchone()[0]
    if src_docs != pair_docs:
        raise SystemExit(f"index rows differ: {src_docs} in the source, {pair_docs} split out")
    report["index_rows"] = pair_docs

    if not _read_caps(s).fts or not _read_caps(pair).fts:
        raise SystemExit(f"search index not in use: source {_read_caps(s)}, split {_read_caps(pair)}")
    differ = [t for t in CHECK_QUERIES if _search_ids(s, t) != _search_ids(pair, t)]
    if differ:
        raise SystemExit(f"search results differ for {differ}")
    report["queries_identical"] = len(CHECK_QUERIES)

    # The safety path: a mismatched epoch, and a missing file, both turn
    # the index off rather than answer from the wrong rowids.
    bare = _open_pair(main, attach=False)
    if _read_caps(bare).fts:
        raise SystemExit("main without its search file still claims an index")
    bare.close()
    report["missing_file_falls_back"] = True
    pair.close(); s.close()

    tmp = out_dir / "epoch-check.db"
    shutil.copyfile(main, tmp)
    c = sqlite3.connect(tmp)
    _set_meta(c, EPOCH_KEY, "mismatch")
    c.commit()
    c.close()
    shutil.copyfile(fts, out_dir / "epoch-check-fts.db")
    from job_filters import attach_fts
    c = sqlite3.connect(f"file:{tmp.as_posix()}?mode=ro", uri=True)
    register_functions(c)
    c.execute("ATTACH DATABASE ? AS fts", (f"file:{(out_dir / 'epoch-check-fts.db').as_posix()}?mode=ro",))
    caps = _read_caps(c)
    like = _search_ids(c, "python")
    c.close()
    tmp.unlink()
    (out_dir / "epoch-check-fts.db").unlink()
    if caps.fts:
        raise SystemExit("a mismatched epoch still claims the index")
    report["epoch_mismatch_falls_back"] = f"fts off, LIKE path answered {len(like)} rows"
    return report


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--src", type=Path, required=True, help="a restored jobs.db, not the box's live file")
    ap.add_argument("--out-dir", type=Path, required=True)
    ap.add_argument("--generation", default=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    ap.add_argument("--expect", help="'rows,max_rowid' read from the box after its writers stopped: "
                                      "refuse a restore that is not the box's final state")
    ap.add_argument("--upload", help="s3://bucket/prefix/ to put the generation under")
    args = ap.parse_args()

    args.out_dir.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    log(f"hashing the source's rowid map: {args.src} ({args.src.stat().st_size:,} bytes)")
    src_hash, rows, max_rowid = rowid_map_hash(args.src)
    log(f"{rows:,} rows, max rowid {max_rowid}, map {src_hash[:12]}")
    if args.expect:
        want_rows, want_max = (int(x) for x in args.expect.split(","))
        if (rows, max_rowid) != (want_rows, want_max):
            raise SystemExit(f"the restore is not the box's final state: {rows},{max_rowid} vs {args.expect}")

    epoch = f"{args.generation}-{src_hash[:12]}"
    t = time.monotonic()
    build_main(args.src, args.out_dir / "jobs.db", epoch)
    log(f"jobs.db built in {time.monotonic() - t:.0f}s: {(args.out_dir / 'jobs.db').stat().st_size:,} bytes")
    t = time.monotonic()
    build_fts(args.src, args.out_dir / "jobs-fts.db", epoch)
    log(f"jobs-fts.db built in {time.monotonic() - t:.0f}s: {(args.out_dir / 'jobs-fts.db').stat().st_size:,} bytes")

    t = time.monotonic()
    report = verify(args.src, args.out_dir, src_hash, rows)
    log(f"verified in {time.monotonic() - t:.0f}s: {report}")

    manifest = {
        "generation": args.generation, "epoch": epoch,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "rows": rows, "max_rowid": max_rowid, "rowid_map_sha256": src_hash,
        "files": {name: {"bytes": (args.out_dir / name).stat().st_size, "sha256": file_sha256(args.out_dir / name)}
                  for name in ("jobs.db", "jobs-fts.db")},
        "verified": report,
    }
    (args.out_dir / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    log(f"manifest written; total {time.monotonic() - started:.0f}s")

    if args.upload:
        import boto3
        from boto3.s3.transfer import TransferConfig
        bucket, _, prefix = args.upload.removeprefix("s3://").partition("/")
        prefix = f"{prefix.rstrip('/')}/{args.generation}/"
        s3 = boto3.client("s3")
        cfg = TransferConfig(multipart_chunksize=64 << 20, max_concurrency=8)
        for name in ("jobs.db", "jobs-fts.db", "manifest.json"):  # the manifest last: its presence means complete
            s3.upload_file(str(args.out_dir / name), bucket, prefix + name, Config=cfg)
        log(f"uploaded to s3://{bucket}/{prefix}")
    print(json.dumps({"generation": args.generation, "epoch": epoch}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
