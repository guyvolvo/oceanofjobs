# Stage 2: move the search index into its own file

Not before cutover. Nothing here fixes a problem the box has today; it
removes the reason the box will need a bigger instance later.

## The problem it solves

The database is 2.66GB and the box has 1.8GB of RAM, so the working set
does not fit. Measured with `dbstat` before the re-seed:

| part | size |
|---|---|
| `jobs_fts_data`, the inverted index | 1,364 MB |
| `jobs` table | 552 MB |
| the three board indexes | ~116 MB |
| everything else | ~75 MB |

Half the file is the full-text index, and the board never reads it. A
listing page filters and sorts on `jobs` and its indexes, about 750MB
all told, which would sit in page cache permanently if the other 1.6GB
were not competing for the same memory. Every search does read it, but
searches are a minority of requests and an index probe is cheap even
cold.

So the two live in one file and evict each other. Splitting them means
the board's working set fits in RAM and stays there, and the search
index is read from disk when a search actually happens.

This is also the answer to the IOPS question. The box's sustained EBS
IOPS are the instance's, not the volume's (the volume already has 3,000
provisioned and 125 MB/s, which is never the limit). Fewer page cache
evictions means fewer reads means less of that budget spent, which is
cheaper than a larger instance and does not need one.

## What changes

`ATTACH DATABASE '/var/lib/otj/jobs-fts.db' AS fts`, and `jobs_fts`
moves there. SQLite can join and subquery across attached databases
freely, so every existing query shape still works:

    jobs.rowid IN (SELECT rowid FROM fts.jobs_fts WHERE fts.jobs_fts MATCH ?)

The rowid contract is the thing to be careful about. FTS5 rowids only
mean anything against the table they were built beside, and `jobs.rowid`
is assigned by insertion order in `jobs.db`. Moving the index to another
file does not change that, but it does mean two files must agree about
it, and nothing enforces it. Today they cannot disagree because a single
`ATTACH`-free transaction writes both.

Concretely:

1. `loader/fts_full.py` builds into `jobs-fts.db` rather than into the
   main file, and stamps `meta.fts_rowid_epoch` in both, a value that
   changes whenever `jobs` rowids are reassigned. Nothing reassigns them
   today, but `VACUUM` on the main file would, and so would any rebuild.
2. `api/job_filters.has_fts_index` gains a fourth check: the two epochs
   match. A mismatch means the index belongs to a different generation
   of the table, and the honest answer is `fts=False`, degrading to
   metadata search exactly as it does now on Lambda. Same rule as
   `fts_complete`: an index that might be wrong is not used.
3. `api/db.py` attaches the file read-only when `DATA_PATH` is set, and
   handles the file being absent by simply not attaching, which
   `has_fts_index` then reports as no index.
4. `load_to_sqlite.index_description` writes to the attached file. It
   already takes the column list; it gains the schema prefix.
5. `box/publish_snapshot.py` gets simpler: the main file no longer
   carries the index, so the drop-and-revacuum step introduced for the
   lean copy goes away. The published snapshot is just a `VACUUM INTO`.
6. Litestream replicates two files instead of one. Both need to be in
   `/etc/litestream.yml`, and a restore needs both. Worth a line in
   `box/CUTOVER.md`'s rollback section, since restoring only the main
   file gives a working board with no description search, which is a
   degraded state rather than an obvious failure.

## What it costs

Total bytes on disk are unchanged. What changes is which bytes compete
for memory.

A transaction can no longer span both files atomically in the way a
single file allows. In practice `index_description` and `upsert_job`
already run in one `with conn:` block, and splitting them means a crash
between the two leaves the index one row stale. That is recoverable and
already handled: a row whose text changed but whose index entry did not
is exactly what `description_sha` detects on the next poll.

## How to verify it worked

The measurement that justifies the work:

- `free -m` buff/cache holding steady with the board's queries served
  from it, rather than the current churn.
- Board endpoints unchanged in latency (they are already 0.07 to 0.4s).
- Search latency: expect it to get slightly *worse* cold, since the
  index is no longer resident, and stay the same warm.
- `EBSIOBalance%` over a normal day: the real target. If it stops
  drifting down under steady load, the instance size question is
  answered without spending anything.

## When to do it

After the cutover has been stable for a week and the Lambda stack is
retired. It touches the query layer, the loader, the API's connection
setup and the backup configuration at once, which is a bad thing to do
while the rollback path still matters.

The trigger to do it sooner: `EBSIOBalance%` trending to zero under
ordinary load, which would mean the applier cannot keep up, which is the
failure that made the Lambda stack unusable in the first place.

## 2026-10-03: built, and how it ships

The problem above arrived. The file is 5.7GB (`jobs_fts` about 2.7GB of
it, `jobs` carrying 1.4GB of in-page slack) on a 3.8GB box, and on
2026-10-02 the applier fell behind for hours while precompute, the
snapshot and a crawler took turns reading the disk. The split leaves
about 1.2GB for the board, which stays in memory.

### What changed in the code
- `api/job_filters.py`: `attach_fts()` attaches `jobs-fts.db` beside the
  main file as schema `fts` (only when main has no `jobs_fts` of its
  own, which would shadow it). `_read_caps()` reads the index's CREATE
  text and `fts_complete` from `fts.*` in that layout and compares the
  epochs. Every query still says `jobs_fts` unqualified.
- `api/db.py` and `alerts.py` attach on every connection; a missing file
  is a no-op (Lambda's snapshot has none).
- `loader/load_to_sqlite.py`: with `--box`, attaches read-write. The
  rowid-delete probe reads whichever schema holds the index. No
  automatic VACUUM on the box any more.
- `box/publish_snapshot.py`: the lean snapshot is a plain `VACUUM INTO`
  when main has no index.
- `box/split_fts.py` builds the pair off-box and verifies it;
  `box/swap_split.sh` swaps the box onto it, or back.
- Tests: `tests/test_fts_split.py`.

### The invariant
`jobs-fts.db` is derived from `jobs.db`. Its rowids are `jobs.rowid`
values of one generation of the main file, named by
`meta.fts_rowid_epoch`, stamped in both files when the pair is built.

- Epochs equal: search uses the index.
- Epochs differ, or the file is missing: the index is off and search
  takes the LIKE path. Degraded search, never wrong search.
- Anything that may change main's rowids (VACUUM, a restore from a
  different generation) must bump main's epoch, which turns the index
  off; rebuild `jobs-fts.db` against the new rowids (`split_fts.py` from
  a copy, or `loader/fts_full.py` into a fresh file); stamp the new
  epoch in it; and only then swap it in. Bumping alone invalidates the
  old index. It does not repair it.

`jobs` has an implicit rowid, which SQLite may renumber on VACUUM, so
`split_fts.py` hashes the rowid-to-id map before and after and stops on
any difference.

### Cutover (off-box; the box never copies or VACUUMs the big file)
1. Worker: a temporary t4g.xlarge in il-central-1 with read access to
   the bucket and write access to `split/`, reached through SSM.
2. On the box: `systemctl stop otj-apply.timer otj-publish.timer
   otj-snapshot.timer`; wait until none of the three services is active.
   Fragments keep spooling; nothing is lost. Read the final state:
   `sqlite3 jobs.db "SELECT COUNT(*), MAX(rowid) FROM jobs"`.
3. Wait 60s for Litestream, then on the worker: `litestream restore` the
   v5 replica, and `python box/split_fts.py --src restored.db --out-dir
   split --expect "<rows>,<max_rowid>" --upload s3://<bucket>/split/`.
4. On the box: `sudo bash box/swap_split.sh <generation>`. It checks both
   files against the manifest, swaps them in, moves Litestream to the v6
   paths for both files, checks a search through the API, and starts
   the timers. API downtime is a restart.
5. Rollback for 48 hours: `sudo bash box/swap_split.sh --rollback` puts
   `jobs.db.pre-split` back. After 48 clean hours, delete it.

### Recovery from now on
A restore needs both files from one generation. The manifest under
`s3://<bucket>/split/<generation>/` names them with their checksums. If
only `jobs.db` can be restored, search falls back to LIKE until the
index is rebuilt against it, as the invariant says.
