"""Rebuild jobs.db compactly beside the live one: same schema, same rowids.

    python box/compact_db.py --src /var/lib/otj/jobs.db [--out-dir DIR]
                             [--generation G] [--expect "rows,max_rowid"]

The applier updates rows in place all day, and the file keeps the pages
that frees: 3.9GB live on 2026-10-20 against 1.75GB for the same rows
compacted. The board reads pages, not rows, so that slack is what pushed
its working set out of memory. This writes the compact copy; the swap is
a separate step, box/swap_compact.sh, with its own rollback
(box/COMPACT.md has the procedure).

The copy is a VACUUM INTO from a read-only connection, the same read
box/publish_snapshot.py makes every day. Nothing writes to the source,
the API keeps serving from it, and the copy carries every table, index,
meta row and sqlite_stat1 row as they were. Run it under the IO cap in
box/COMPACT.md: an uncapped full read of this file starved the API on
2026-09-23 and again on 2026-10-20.

The search index stays valid without a rebuild. jobs-fts.db is keyed by
jobs.rowid of one generation of the main file (box/STAGE2-FTS.md). SQLite
keeps rowids through VACUUM INTO in practice but does not promise it for
a table without an INTEGER PRIMARY KEY, which jobs is not, so the
rowid-to-id map is hashed on both sides and any difference stops the
build. meta, and with it fts_rowid_epoch, must come across unchanged.

What comes out, in DIR (default <src dir>/compact/<generation>/):
  jobs.db        the compact copy, in WAL mode
  manifest.json  generation, epoch, row counts, the rowid map hash, the
                 file's sha256, and what verify() checked
"""

import argparse
import hashlib
import json
import random
import shutil
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from split_fts import CHECK_QUERIES, _open_pair, _search_ids, file_sha256, log  # noqa: E402

SAMPLE = 2000


def map_hash(conn) -> tuple[str, int, int]:
    """A digest of every (rowid, id) pair of jobs, the row count and the
    largest rowid. A sum of per-pair hashes, so no order is needed and
    SQLite answers from the id index (about 100MB) instead of reading the
    whole table a second time under the IO cap."""
    total, n, top = 0, 0, 0
    for rowid, jid in conn.execute("SELECT rowid, id FROM jobs"):
        total += int.from_bytes(hashlib.blake2b(f"{rowid},{jid}".encode("utf-8"), digest_size=8).digest(), "big")
        n += 1
        top = max(top, rowid)
    return f"{total % (1 << 64):016x}", n, top


def _ro(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)


def _state(conn) -> dict:
    """What must be identical on both sides: the schema, every table's row
    count (sqlite_stat1 included), meta, and the rowid map."""
    schema = sorted(conn.execute(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_autoindex%'").fetchall())
    tables = [r[1] for r in schema if r[0] == "table"]
    h, n, top = map_hash(conn)
    return {"schema": schema,
            "counts": {t: conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in tables},
            "meta": dict(conn.execute("SELECT key, value FROM meta").fetchall()),
            "rowid_map_sha256": h, "rows": n, "max_rowid": top}


def build(src: Path, out: Path) -> dict:
    """VACUUM INTO `out`, and the source's state read on the same
    connection. PRAGMA data_version moves when another connection commits,
    so an unchanged value before and after proves the copy and the state
    describe one version of the source."""
    out.unlink(missing_ok=True)
    conn = _ro(src)
    try:
        if conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'jobs_fts'").fetchone():
            raise SystemExit("the source carries jobs_fts in main: this is for the split layout "
                             "(box/STAGE2-FTS.md), where the index lives in jobs-fts.db")
        before = conn.execute("PRAGMA data_version").fetchone()[0]
        state = _state(conn)
        log(f"source: {state['rows']:,} rows, max rowid {state['max_rowid']}, map {state['rowid_map_sha256'][:12]}")
        t = time.monotonic()
        conn.execute("VACUUM INTO ?", (str(out),))
        log(f"VACUUM INTO took {time.monotonic() - t:.0f}s")
        if conn.execute("PRAGMA data_version").fetchone()[0] != before:
            raise SystemExit("the source changed during the build: stop the applier, publisher and "
                             "snapshot timers (box/COMPACT.md) and run it again")
    finally:
        conn.close()
    return state


def verify(src: Path, out: Path, built: dict, sample: int = SAMPLE) -> dict:
    """Everything the copy must preserve. Raises on the first failure."""
    from job_filters import _read_caps, register_functions
    report: dict = {}
    conn = _ro(out)
    try:
        ok = conn.execute("PRAGMA quick_check").fetchone()[0]
        if ok != "ok":
            raise SystemExit(f"quick_check failed: {ok}")
        got = _state(conn)
        for key in ("rowid_map_sha256", "rows", "max_rowid"):
            if got[key] != built[key]:
                raise SystemExit(f"rowid map changed ({key}: {got[key]} vs {built[key]}): the search index "
                                 "would answer with the wrong listings. Do not swap this file.")
        report["rowid_map"] = "identical"
        if got["schema"] != built["schema"]:
            raise SystemExit("the schema differs from the source's")
        report["schema"] = f"identical, {len(got['schema'])} objects"
        if got["counts"] != built["counts"]:
            raise SystemExit(f"row counts differ: {got['counts']} vs {built['counts']}")
        report["tables"] = got["counts"]
        if got["meta"] != built["meta"]:
            raise SystemExit("meta differs, so the search index's epoch could too")
        report["epoch"] = got["meta"].get("fts_rowid_epoch")

        # Rows picked by random rowid, compared column by column.
        conn.execute("ATTACH DATABASE ? AS src", (f"file:{src.as_posix()}?mode=ro",))
        rng = random.Random(built["rowid_map_sha256"])
        rowids = sorted({rng.randint(1, max(1, built["max_rowid"])) for _ in range(sample)})
        compared = 0
        for i in range(0, len(rowids), 500):
            chunk = rowids[i:i + 500]
            marks = ",".join("?" * len(chunk))
            a = conn.execute(f"SELECT rowid, * FROM src.jobs WHERE rowid IN ({marks}) ORDER BY rowid", chunk).fetchall()
            b = conn.execute(f"SELECT rowid, * FROM main.jobs WHERE rowid IN ({marks}) ORDER BY rowid", chunk).fetchall()
            if a != b:
                raise SystemExit(f"sampled rows differ between the source and the copy (rowids {chunk[0]}..{chunk[-1]})")
            compared += len(a)
        report["rows_compared"] = compared
    finally:
        conn.close()

    # Search: the source with its index, and the copy with the same index
    # attached, must answer every check query with the same listings.
    fts = src.with_name("jobs-fts.db")
    if fts.exists():
        before = _open_pair(src)
        after = _ro(out)
        register_functions(after)
        after.execute("ATTACH DATABASE ? AS fts", (f"file:{fts.as_posix()}?mode=ro",))
        try:
            used = _read_caps(after).fts
            if _read_caps(before).fts and not used:
                raise SystemExit("the search index is usable against the source but not against the copy")
            differ = [q for q in CHECK_QUERIES if _search_ids(before, q) != _search_ids(after, q)]
            if differ:
                raise SystemExit(f"search results differ for {differ}")
            report["queries_identical"] = len(CHECK_QUERIES)
            report["search_index_used"] = used
        finally:
            before.close()
            after.close()
    return report


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--src", type=Path, required=True, help="the live jobs.db, opened read-only")
    ap.add_argument("--out-dir", type=Path)
    ap.add_argument("--generation", default=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    ap.add_argument("--expect", help="'rows,max_rowid' read after the writers stopped: refuse a source "
                                      "that has moved on since")
    ap.add_argument("--sample", type=int, default=SAMPLE, help="rows compared column by column")
    args = ap.parse_args()

    out_dir = args.out_dir or args.src.parent / "compact" / args.generation
    out_dir.mkdir(parents=True, exist_ok=True)
    need, free = args.src.stat().st_size, shutil.disk_usage(out_dir).free
    # The copy is smaller than the source; the source's size is the margin
    # that also covers the fragment spool growing while the applier waits.
    if free < need:
        raise SystemExit(f"{free:,} bytes free at {out_dir}, need at least {need:,}")

    from lock import exclusive
    # Keeps the applier, publisher and snapshot off the disk while this
    # reads it. The runbook stops their timers too; this covers a run
    # already in flight.
    with exclusive("compact", wait=900) as got:
        if not got:
            raise SystemExit("another job held the disk for 15 minutes (box/lock.py); stop the timers and retry")
        started = time.monotonic()
        out = out_dir / "jobs.db"
        log(f"building {out} from {args.src} ({need:,} bytes)")
        built = build(args.src, out)
        log(f"built in {time.monotonic() - started:.0f}s: {out.stat().st_size:,} bytes")
        if args.expect:
            want = tuple(int(x) for x in args.expect.split(","))
            if (built["rows"], built["max_rowid"]) != want:
                raise SystemExit(f"the source is not the state you read: {built['rows']},{built['max_rowid']} "
                                 f"vs {args.expect}")
        t = time.monotonic()
        report = verify(args.src, out, built, args.sample)
        log(f"verified in {time.monotonic() - t:.0f}s: {report}")
        # WAL, as the live file is, and with -wal and -shm gone so jobs.db
        # alone is the file the swap moves.
        last = sqlite3.connect(out)
        last.execute("PRAGMA journal_mode = WAL")
        last.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        last.close()

    manifest = {
        "generation": args.generation, "epoch": report.get("epoch"),
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "src": str(args.src), "src_bytes": need,
        "rows": built["rows"], "max_rowid": built["max_rowid"], "rowid_map_sha256": built["rowid_map_sha256"],
        "files": {"jobs.db": {"bytes": out.stat().st_size, "sha256": file_sha256(out)}},
        "verified": report,
        "seconds": round(time.monotonic() - started),
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    log(f"manifest written; total {manifest['seconds']}s")
    print(json.dumps({"generation": args.generation, "dir": str(out_dir), "bytes": out.stat().st_size}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
