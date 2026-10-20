# Narrow jobs.db: text off the rows, 14-day retention, a compacted file

Phase 1 of getting the board, the facets and search fast again on the
3.8GB box. Code, the migration tool and an offline benchmark on a real
copy. Nothing here has run on the box yet.

## What the data said

The plan assumed about 70% of the 3.9GB jobs.db was cold text. On the
2026-10-20 snapshot (`backups/jobs-read-2026-10-20.db`, a `VACUUM INTO`
of the live file, 2,028,542 rows) that is not so:

| column | bytes | non-null rows |
|---|---|---|
| url | 200 MB | all |
| title | 73 MB | all |
| role_evidence | 62 MB | all |
| posted_at, first_seen, last_seen | 52, 51, 51 MB | nearly all |
| location | 47 MB | all |
| description_sha | 45 MB | 1,415,988 |
| description | 0 | 0 |
| raw_json | 0 | 0 |

The box has applied with `--drop-description` since the cutover, so the
description column is empty, and raw_json has been written as NULL since
September. The whole table holds about 930MB of values. The live file is
3.9GB because it is full of free and half-empty pages: the same data
compacts to 1.75GB. That slack, not the text, is most of what pushed the
working set out of memory. The 1.2GB narrow copy precompute makes was
small because it was a fresh copy, not because of the columns it left out.

So the wins, in order of size:

1. Rebuild the file compactly (3.9GB to about 1.6GB).
2. Keep closed listings 14 days instead of 30 (380,195 fewer rows).
3. Take what is left of the text off the rows (description_sha now,
   description whenever an upload fails).

## The audit

Every reader and writer of the wide columns, and what each needs.

description, moved to `jobs_text`:
- loader/load_to_sqlite.py `upsert_job` writes it (only when the text
  changed), `load_resolved` reads the stored text back for the old
  text-based FTS delete, `--drop-description` clears it once the S3 blob
  is written. Now all three use jobs_text.
- api/handler.py `route_job_page`, `route_job_detail`: the fallback
  behind the S3 blob. Point lookup by id.
- api/job_filters.py (keywords) and api/search_compile.py (two places):
  the LIKE path used when no index is usable, and for terms with `+` or
  `#` (c++, c#). `search_compile.description_like` picks the column or a
  subquery on jobs_text by `SnapshotCaps.text_table`.
- loader/sitemap.py RSS feed blurb. On the box this has been empty since
  the column emptied; it reads jobs_text now, still empty there.
- backfill_descriptions.py, run by hand against a snapshot.
- loader/fts_full.py and loader/rebuild_fts.py read the text from S3,
  never the column. No change. loader/archive.py never archived it.

description_sha, moved to `jobs_text` with the text:
- loader `load_resolved` reads it per listing in the payload to decide
  whether to upload; `upsert_job` writes it; a failed upload clears it.
- scrape_workday_handler.py reads it from jobs-partition-workday.db to
  know which Workday listings are described. It reads either shape.

raw_json: read by nothing, written NULL since September. Dropped.

role_evidence: stays on the row, though it is 62MB. The loader is its
only reader, but it reads it in bulk: `_company_tech_share` sums
`role_evidence LIKE '%software%'` over a company's open rows on every
apply, and `idx_jobs_role_review` is a partial index on it. In another
table each of those becomes a join for every open row of the companies
an apply touched, which is the applier's hot path. Measured below, it is
worth another 7% of what the facets read, so it is the next candidate,
done by storing the two facts the loader asks of it as their own small
columns.

url, external_id, last_seen, title, location: read by the board, the
listing pages, alerts and the MCP server for every row they show. Not
cold.

## Design

`jobs_text (id TEXT PRIMARY KEY, description, description_sha) WITHOUT
ROWID`, in jobs.db, beside a new `closed_history` table (below). Keyed by
id, so it never has to agree with jobs about rowids.

A separate jobs-text.db, like the search index's file, was the first
choice. The audit is why it is a table instead. What moves is about 70MB
of hashes and an almost always empty text column, so a third file would
buy nothing on disk, and it would cost a third Litestream replica and
restore pairing, an ATTACH in every writer, and cross-file transactions
for the upsert, which today commits row and text together. The board
never reads jobs_text pages, so they do not compete for memory either way.
jobs.db still shrinks, through the rebuild.

`open_db` migrates an older file in place (copy into jobs_text, `DROP
COLUMN`), which suits partitions and test files. On the box it refuses
instead (`split_text_in_place=False` under `--box`): rewriting a 3.9GB
table under the API is the shape of the 2026-09-23 outage. The box gets
the new file from `box/split_text.py` and a swap.

The API reads both shapes, so the API code can ship before the swap.

## Retention

`loader/archive.py` already retires closed listings to S3 and deletes
them, once a day, inside the apply. Changed:

- 14 days instead of 30 (`RETAIN_DAYS`, `ARCHIVE_CLOSED_DAYS` in
  box/shadow_apply.py and scrape_maintenance_handler.py).
- At most 20,000 rows a run (`MAX_PER_RUN`). A run that hits the limit
  does not write the daily marker, so the next apply takes the next
  batch. The cut from 30 to 14 days is 380,195 rows: 20 runs.
- Each retired listing leaves `(first_seen date, closed_at date, skills,
  country)` in `closed_history`, kept 90 days. The account page's skills
  chart (`aggregates.skills_history`, 90 days) adds those rows, so its
  older days do not read low. The 14-day charts, the 24h and 7-day
  counters and `company_daily` only ever read inside 14 days, or keep
  their own daily rows.
- The listing's jobs_text row goes with it, as its index entries did.

Visible change: a closed listing's own page answers 404 after 14 days
instead of the "closed" page for 30 (api/job_page.py EXPIRED_KEEP_DAYS
still says 30, and is simply never reached past 14).

## The migration tool

`box/split_text.py --src /var/lib/otj/jobs.db [--expect rows,max_rowid]`

Opens the live file read-only and copies it in one read transaction
into `split-text/<generation>/jobs.db` beside it: every table and index
from the source's own schema, jobs rows with their rowids given
explicitly and in rowid order, the moved columns dropped and their
values put in jobs_text, the planner's statistics copied so no query
changes plan. It takes the box's disk lock (box/lock.py) for the build.

Then it verifies: quick_check, the rowid-to-id map hash identical to the
source's, every table's row count, meta identical (so the FTS epoch is),
2,000 rows compared column by column with their text, and the 20 search
check queries answered identically through jobs-fts.db against the
source and against the copy. The manifest records all of it with the
file's sha256.

The search index does not need rebuilding: same rowids, same epoch,
proved before the tool says done. Run again later on a split file, the
tool is a plain compaction, which is how to reclaim the slack the
in-place applier grows back.

## Procedure

Two deploys, so the retention drain happens on the old file and the
rebuild then compacts it away.

1. Ship the retention commit alone. It works on the live file as it is.
   Watch the first applies: each logs `archive: {... "more": true}`
   while it drains, 20 runs for the backlog. Locally a 20,000-row batch
   with its index deletes took 2 to 20s; expect several times that on
   the box.
2. When `"more": false` shows, stop the writers:
   `sudo systemctl stop otj-apply.timer otj-publish.timer otj-snapshot.timer`
   and wait until none of the three services is active. The fetcher
   keeps spooling fragments; nothing is lost.
3. Deploy the jobs_text commit. The API restarts on code that reads the
   old file correctly. Leave the timers stopped: the new loader refuses
   the old file, on purpose.
4. Read the final state:
   `sqlite3 -readonly /var/lib/otj/jobs.db "SELECT COUNT(*), MAX(rowid) FROM jobs"`
5. Build, as ubuntu, from /srv/otj/app:
   `DATA_PATH=/var/lib/otj/jobs.db /srv/otj/venv/bin/python box/split_text.py --src /var/lib/otj/jobs.db --expect "<rows>,<max_rowid>"`
   It prints the generation.
6. `sudo bash box/swap_text.sh <generation>`. It checks the file against
   the manifest and the live file against the build, moves jobs.db to
   jobs.db.pre-text, puts the new one in place, moves jobs.db's
   Litestream replica to the next path (v6 to v7), starts the API, checks
   the board, a search and `facets?country=US`, then starts Litestream
   and the timers.
7. Point the precompute Lambda at the new replica path: `REPLICA_PATH`
   in precompute_handler.py and the two `litestream/v6/jobs` prefixes in
   infra/precompute_lambda.tf, then deploy. Until then it restores the
   frozen v6 replica.
8. After 48 clean hours delete jobs.db.pre-text and
   .jobs.db-litestream.pre-text.

### Rollback

`sudo bash box/swap_text.sh --rollback` with the timers stopped puts
jobs.db.pre-text back, the Litestream config and its state directory
with it. Then deploy the code from before the jobs_text commit before
starting the timers, since the new loader refuses the old file.

If the timers ran after the swap, new listings took rowids the old file
never issued and jobs-fts.db indexed them. The old file would hand the
same rowids to other listings, so the rollback stamps a new epoch in it
and search falls back to LIKE until the index is rebuilt for that file
(box/STAGE2-FTS.md, the invariant). Fragments applied after the swap
were deleted from S3, so a rollback after hours of applies also loses
those updates until the boards change again. Roll back early or not at
all.

## Numbers

Sizes, from the 2026-10-20 snapshot:

| file | bytes |
|---|---|
| live jobs.db (not measured here) | about 3.9 GB |
| snapshot, the live file compacted | 1,754,370,048 |
| split, no retention | 1,790,689,280 |
| 14-day drain, then split | 1,565,937,664 |
| jobs-fts.db | unchanged by the tool |

Split without retention is slightly bigger than the snapshot: jobs_text
is its own B-tree of 1.4M ids and hashes. The jobs table itself is the
smaller part, which is what the board reads. The drain's 380,195 index
deletes grew the copy of jobs-fts.db by 44MB of tombstones, which FTS5
merges away over time.

Benchmark, `tests/bench/db_bench.py`, the API's own route functions
in-process. Windows cannot drop its page cache, so the time column is a
warm OS cache either way. The MB column is what SQLite read through the
OS (its own cache is 2MB), which is what a cold box has to read from
disk. "Before" is the snapshot with the new code; the old code read the
same bytes.

| request | before s | before MB | after s | after MB |
|---|---|---|---|---|
| /api/jobs | 0.073 | 86 | 0.074 | 86 |
| /api/jobs search=azure | 0.103 | 176 | 0.077 | 131 |
| /api/jobs search=devops | 0.084 | 144 | 0.064 | 108 |
| /api/jobs country=US | 0.179 | 86 | 0.196 | 86 |
| /api/jobs country=IL | 0.188 | 86 | 0.182 | 86 |
| /api/facets (live) | 5.98 | 4,044 | 5.64 | 3,312 |
| /api/facets search=devops | 0.221 | 292 | 0.183 | 220 |
| /api/facets country=US | 5.98 | 4,036 | 5.70 | 3,304 |
| /api/jobs/{id} | 0.000 | 0 | 0.000 | 0 |

Where the facets' saving comes from (old code, MB read warm): snapshot
4,044, with the 14-day retention 3,496, plus the text columns off 3,311,
plus role_evidence off as well 3,086 (not done, see the audit).

The snapshot is already compact, so this table cannot show the biggest
change on the box: the same requests against a 3.9GB file of half-empty
pages read correspondingly more, and the file no longer fits beside the
search index in 3.8GB. After the rebuild jobs.db is about 1.6GB.

## What is still slow, and what to do next

Live facets read about 3.3GB per request on a 1.6GB file. Four
statements are almost all of it, each a full scan of the jobs table
(about 750MB): the company, category and country counts and the city
split (1.7GB, it scans twice). They filter on `confidence = 'verified'`
and the freshness test, which no partial index carries alongside those
columns, so SQLite reads every open row from the table. A covering
partial index for the facet columns, or one pass that counts all four
at once, would cut that by an order of magnitude. That is the next
change, measured with this same bench.

`/api/jobs` with no filter reads 86MB per request, every request, from
the count. Same remedy.

Search: 97.6% of jobs-fts.db's postings are description terms (on the
2026-10-03 index: 716M of 734M instances; titles 1.0%, locations 0.8%,
company 0.5%, departments 0.1%). A column filter such as
`{title company_domain} : azure` does not avoid them, because FTS5 keeps
one doclist per term across all columns and reads the whole of it. A
separate index of the four metadata columns is 117MB for the whole
board, small enough to stay in memory for good, and answers a title or
company match without touching the 3.9GB description index. Searching
it first and the description index only when the reader asks for more
is a behaviour change, so it is left for its own phase.
