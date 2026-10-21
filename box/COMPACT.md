# Compacting jobs.db: copy, verify, swap

The live jobs.db was 3.9GB on 2026-10-20. The same rows compact to
1.75GB (the daily `VACUUM INTO` snapshot), and to about 1.55GB once the
14-day retention (loader/archive.py, shipped 847a907) has drained. The
rest is free and half-empty pages left by the applier's in-place
updates. The board reads pages, so that slack is what pushed its working
set out of the box's 3.8GB of memory.

This rebuilds the file compactly beside the live one and swaps it in.
Same schema, same rows, same rowids, same meta. No code change: the
loader, the API, alerts and precompute run against the new file exactly
as they do against the old one (tests/test_compact_db.py runs today's
loader and API on a swapped copy).

- `box/compact_db.py` builds and verifies the copy.
- `box/swap_compact.sh` swaps it in, or back.

## What the measurements said

On the 2026-10-20 snapshot, 2,028,542 rows, the text the plan wanted to
move was not there: `description` was empty in every row (the box
applies with `--drop-description`) and `raw_json` too. The widest
columns left are url (200MB), title (73MB), role_evidence (62MB) and
description_sha (45MB), about 930MB of values in all. A table for the
text would have moved about 70MB at the cost of a schema migration
through every writer, so the plan is compaction only.

Offline, on that snapshot drained to 14 days the way the box will be
(1,647,976 rows), `tests/bench/db_bench.py`, today's code. Times are with
a warm OS cache (Windows cannot drop it); MB is what SQLite read through
the OS, which is what a cold box reads from disk.

| request | drained, not compacted | compacted |
|---|---|---|
| file | 1,755,693,056 bytes | 1,543,311,360 bytes |
| /api/jobs | 0.075s, 86MB | 0.077s, 86MB |
| search=azure | 0.088s, 141MB | 0.082s, 134MB |
| search=devops | 0.070s, 115MB | 0.067s, 110MB |
| country=US | 0.193s, 86MB | 0.191s, 86MB |
| facets (live) | 5.98s, 3,953MB | 7.21s, 3,495MB |
| facets search=devops | 0.253s, 233MB | 0.198s, 224MB |
| facets country=US | 6.62s, 3,945MB | 5.79s, 3,486MB |

Bytes read fall 4 to 12%; the warm times move within run-to-run noise
(the unfiltered facets run was slower on the compact file, the US one
faster), because on a laptop the whole file sits in the OS cache either
way. The offline source was itself a compact snapshot with only the
drain's holes in it (1.76GB), so this understates the box, where the
same rows sit in 3.9GB and the reads come from disk.

What compaction does not fix: a live facets request still reads about
3.5GB, four full scans of the jobs table (company, category, country,
and the city split, which scans twice), because no partial index
carries `confidence = 'verified'` and the freshness test beside those
columns. That is the next change, measured with the same bench.

Building and verifying that copy took 14s on a laptop NVMe disk
(VACUUM INTO 4s, verify 7s), rowid map identical, all 20 search checks
identical through jobs-fts.db.

## How the copy is made and checked

`VACUUM INTO` from a read-only connection: the same read
box/publish_snapshot.py makes every day, writing a new file and never
touching the live one. It copies every table, index, meta row and
sqlite_stat1 row. `PRAGMA data_version` is read before and after on the
same connection; any commit by another connection in between and the
build stops.

SQLite keeps rowids through VACUUM INTO in practice, but does not
promise it for a table without an INTEGER PRIMARY KEY, and jobs-fts.db
is keyed by `jobs.rowid` (box/STAGE2-FTS.md). So the verifier checks:

- `PRAGMA quick_check` on the copy;
- a digest of every (rowid, id) pair, identical on both sides;
- the schema (every table, index and its SQL), identical;
- every table's row count, sqlite_stat1 included;
- meta identical, so `fts_rowid_epoch` is too and jobs-fts.db stays valid
  without a rebuild;
- 2,000 rows by random rowid, compared column by column;
- the 20 search check queries (box/split_fts.py) through jobs-fts.db,
  identical against the source and the copy, with the index in use.

It also takes the disk lock (box/lock.py) for the build and refuses to
start unless the free space is at least the source's size.

## Runbook

All commands run on the box through SSM. Paste this helper into a local
shell once (needs the openmarket-tf profile and gh signed in):

```bash
INSTANCE="$(gh variable get BOX_INSTANCE_ID)"
box() {
  local params cmd status
  params="$(python -c 'import json,sys; print(json.dumps({"commands":[sys.stdin.read()],"executionTimeout":["3600"]}))' <<<"$1")"
  cmd="$(aws ssm send-command --profile openmarket-tf --region il-central-1 --instance-ids "$INSTANCE" \
    --document-name AWS-RunShellScript --parameters "$params" --query Command.CommandId --output text)"
  while :; do
    status="$(aws ssm get-command-invocation --profile openmarket-tf --region il-central-1 --command-id "$cmd" \
      --instance-id "$INSTANCE" --query Status --output text 2>/dev/null || true)"
    case "$status" in Success|Failed|Cancelled|TimedOut) break ;; esac
    sleep 5
  done
  echo "status: $status"
  aws ssm get-command-invocation --profile openmarket-tf --region il-central-1 --command-id "$cmd" \
    --instance-id "$INSTANCE" --query '[StandardOutputContent, StandardErrorContent]' --output text
}
```

Pick a quiet hour. The applier is paused for the build, about 45
minutes, while the fetcher keeps spooling fragments, so nothing is lost
and the board is that much behind until the spool drains.

### 0. The scripts are on the box

Merging this branch runs deploy-box (it touches `box/**`), which pulls
the checkout and restarts the API. Nothing else changes.

```bash
box 'ls -l /srv/otj/app/box/compact_db.py /srv/otj/app/box/swap_compact.sh'
```

### 1. Preflight, read-only, a minute

```bash
box '
df -h /var/lib/otj
ls -l /var/lib/otj/jobs.db /var/lib/otj/jobs-fts.db
findmnt -no SOURCE --target /var/lib/otj
sqlite3 -readonly /var/lib/otj/jobs.db "PRAGMA page_count; PRAGMA freelist_count;"
grep -n "path: litestream" /etc/litestream.yml
ls /var/lib/otj/deltas | wc -l
'
```

Go on only if:
- free space on /var/lib/otj is at least 5GB: the copy needs the
  source's size by the tool's own check (about 3.9GB, of which it uses
  about 1.6GB), and the spool grows about 20MB a minute while the
  applier waits;
- the device is `/dev/nvme0n1` (the IO cap below names it; change the
  two `-p IO...` lines if not);
- the archive drain is over: the last apply's log shows
  `"more": false` (`journalctl -u otj-apply --since -1h -o cat | grep archive:`);
- the Litestream config names `litestream/v6/jobs`.

`freelist_count / page_count` is the share of the file that is wholly
free pages; the rest of the slack is half-empty pages, which only a
rebuild shows.

### 2. Pause the writers, up to 10 minutes

The watchdog restarts a stopped timer within 15 minutes unless it has a
pause marker, so each gets one (honoured six hours). otj-names writes
company names into jobs.db, so it stops too. The fetcher does not.

```bash
box '
mkdir -p /var/lib/otj/pause
for t in otj-apply otj-publish otj-snapshot otj-names; do
  touch /var/lib/otj/pause/$t.timer
  systemctl stop $t.timer
done
for i in $(seq 1 60); do
  busy=$(for s in otj-apply otj-publish otj-snapshot otj-names; do systemctl is-active --quiet $s.service && echo $s; done)
  [ -z "$busy" ] && break
  echo "waiting for: $busy"; sleep 10
done
echo "still running: ${busy:-none}"
sqlite3 -readonly /var/lib/otj/jobs.db "SELECT COUNT(*) || \",\" || MAX(rowid) FROM jobs"
'
```

"still running: none" must show. If a publish pass is still going after
ten minutes, `systemctl stop otj-publish.service` is safe (its writes are
one transaction) and run the loop again. Keep the last line, the rows
and the largest rowid, as `EXPECT`.

### 3. Build, 15 to 45 minutes

A transient service, so it outlives the SSM command, under the same IO
cap the publisher has (`scripts/box_self_heal.sh`): 1,200 reads and 600
writes a second of the disk's 3,000, the rest for the API. `ionice` does
nothing on this disk (ARCHITECTURE.md, the 2026-09-23 experiment).

```bash
GEN=$(date -u +%Y%m%dT%H%M%SZ)
EXPECT="<rows>,<max_rowid>"   # from step 2
box "systemd-run --unit=otj-compact --uid=ubuntu --gid=ubuntu --working-directory=/srv/otj/app \
  -p IOReadIOPSMax='/dev/nvme0n1 1200' -p IOWriteIOPSMax='/dev/nvme0n1 600' -p Nice=10 \
  -E DATA_PATH=/var/lib/otj/jobs.db \
  /srv/otj/venv/bin/python box/compact_db.py --src /var/lib/otj/jobs.db --generation $GEN --expect '$EXPECT'"
```

Watch it, every few minutes:

```bash
box 'systemctl is-active otj-compact; journalctl -u otj-compact --no-pager -o cat | tail -8
curl -s -o /dev/null -w "board %{http_code} %{time_total}s\n" "http://127.0.0.1:8000/api/jobs?limit=50"'
```

The estimate: the source is about 950,000 pages, and at 1,200 reads a
second a page at a time the VACUUM INTO alone is 13 minutes; readahead
makes it less, a cold cache and scattered pages more. Verification reads
the new file once more (quick_check) plus small parts of both. If the
board stays above a few seconds a request, lower the read cap in place:
`systemctl set-property --runtime otj-compact IOReadIOPSMax='/dev/nvme0n1 800'`.

Done when `is-active` says inactive and the log ends with a JSON line
naming the directory. Then:

```bash
box "cat /var/lib/otj/compact/$GEN/manifest.json; ls -l /var/lib/otj/compact/$GEN/"
```

The manifest's `verified` block must show `rowid_map: identical`,
`queries_identical: 20` and `search_index_used: true`.

If it failed, nothing has changed: read the log, then
`systemctl reset-failed otj-compact` before running it again, or abort
(below).

### 4. Swap, about 2 minutes, the API down for seconds

```bash
box "bash /srv/otj/app/box/swap_compact.sh $GEN"
```

It refuses unless the timers are stopped, the file matches the manifest
and the live file still has the rows and largest rowid of the build.
Then it moves jobs.db to jobs.db.pre-compact, puts the copy in place,
moves jobs.db's Litestream replica to `litestream/v7/jobs`, starts the
API, checks the board, a search and `facets?country=US` for rows, starts
Litestream, removes the pause markers and starts the timers. Any failed
check prints the rollback command and stops before the timers start.

### 5. Point the precompute Lambda at v7

It restores jobs.db from Litestream and only knows v6, which stops moving
at the swap. Litestream 0.5 (the box and the Lambda both run 0.5.17) has
no generations, so a new file under the old path is not an option. On a
branch, then merge:

- precompute_handler.py: `REPLICA_PATH` default to `"litestream/v7/jobs"`;
- infra/precompute_lambda.tf: the two `litestream/v6/jobs` strings in
  the IAM policy (the ListBucket prefixes and the GetObject resource) to
  v7.

deploy-precompute-lambda and deploy-infra pick them up. Until they do,
the Lambda builds from the frozen v6 copy: harmless in shadow mode, stale
numbers if `precompute_mode` is live.

### 6. The first hour

```bash
box '
ls /var/lib/otj/deltas | wc -l
journalctl -u otj-apply --since -30min -o cat | grep -E "^applied" | tail -5
free -m
ls -l /var/lib/otj/jobs.db
for q in "limit=50" "search=devops&limit=50" "country=US&limit=50"; do
  curl -s -o /dev/null -w "$q %{http_code} %{time_total}s\n" "http://127.0.0.1:8000/api/jobs?$q"
done
'
aws s3 ls s3://iljobs-data-876913698688/litestream/v7/jobs/ --profile openmarket-tf --region il-central-1
```

The spool should fall back to its usual size within the hour, and v7
should hold Litestream's first snapshot of the new file.

### 7. After 48 clean hours

```bash
box 'rm -f /var/lib/otj/jobs.db.pre-compact /var/lib/otj/jobs.db.pre-compact-wal /var/lib/otj/jobs.db.pre-compact-shm
rm -rf /var/lib/otj/.jobs.db-litestream.pre-compact /var/lib/otj/compact/rolled-back
df -h /var/lib/otj'
```

The copy's manifest stays in `/var/lib/otj/compact/<generation>/`.

## Abort before the swap

```bash
box "rm -rf /var/lib/otj/compact/$GEN
rm -f /var/lib/otj/pause/otj-apply.timer /var/lib/otj/pause/otj-publish.timer /var/lib/otj/pause/otj-snapshot.timer /var/lib/otj/pause/otj-names.timer
systemctl start otj-apply.timer otj-publish.timer otj-snapshot.timer otj-names.timer"
```

## Rollback after the swap

Stop the writers as in step 2, then:

```bash
box 'bash /srv/otj/app/box/swap_compact.sh --rollback'
```

It puts jobs.db.pre-compact back with its Litestream config and state,
starts the API and Litestream, and starts the timers. If step 5 already
shipped, revert it too.

Early, before the timers ran, this is clean. Later it costs two things:

- Listings added after the swap took rowids the old file never issued,
  and jobs-fts.db indexed them. The old file would give the same rowids
  to other listings, so the rollback stamps a new epoch in it and search
  runs on the LIKE path until jobs-fts.db is rebuilt for it
  (box/STAGE2-FTS.md). Degraded, never wrong.
- Updates applied since the swap are gone from the old file, and their
  fragments were deleted from S3. Boards come back as they next change.

So roll back early or not at all.

## Doing it again

The applier grows the slack back: the file went from 1.27GB at the FTS
split (2026-10-03) to 3.9GB in 17 days with 1.75GB of rows. The same
runbook compacts it again whenever `ls -l jobs.db` is well past the last
manifest's size; each run moves Litestream one version on (v7, v8 ...),
and the Lambda's path with it.
