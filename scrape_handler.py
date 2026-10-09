"""EventBridge-triggered Lambda for the fast re-poll cycle.

GitHub Actions' schedule: trigger turned out to not be reliable enough to
depend on: scrape-fast.yml's cron sat for over an hour, and every offset
tried, without firing a single scheduled run (only manual dispatches ever
ran). That's a known, long-standing GitHub issue with no official fix --
see https://github.com/orgs/community/discussions/147369. EventBridge has
an actual SLA, so this Lambda now owns the recurring cadence entirely;
scrape-fast.yml keeps workflow_dispatch only, for manual/on-demand runs.

Each tick it polls the boards that are due, by each board's own
backoff (loader/scrape_state.py), at most MAX_PER_SWEEP of them, with
the validators that turn most polls into a 304. Boards that changed go
out as delta fragments (loader/deltas.py) for the box to apply; nothing
here opens a database. This replaced a fixed rotation of 50-company
shards, which polled by position rather than by whether a board had
anything new.

Runs probe.py --known as a subprocess against /tmp, the same command
scrape-fast.yml runs by hand.
"""

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT / "loader"))

from deltas import put_fragment  # noqa: E402
import scrape_state  # noqa: E402
TMP = Path("/tmp")
BUCKET = os.environ["DATA_BUCKET"]
# When the probe stops taking new boards. Whatever it polled by then is
# already on disk (its --out file, one board per line) and gets written
# and scheduled below; the rest keep their old due time and go first next
# run. So a run can no longer lose its work: the 40-hour loop of
# 2026-09-28 (a failed run saved nothing, the next faced the same pile
# and failed the same way) has nothing to feed on. Five minutes leaves
# the boards in flight at the deadline time to finish, and the fragment
# and state writes after them, inside the 420s hard kill on the probe and
# the Lambda's 600s.
#
# 3.5, down from 5: with nothing to stop two sweeps running at once (no
# reserved concurrency on this account), a run longer than the 5-minute
# schedule overlapped the next one, which polled the same boards and lost
# its state save. Runs reached 415s on 2026-10-04 and 301s on 10-07.
PROBE_DEADLINE_MIN = 3.5

# The old DynamoDB validator table. Read once, only when the S3 poll
# state is missing, to seed it (see scrape_state.load). Everything else
# about conditional polling lives in that object now. Unset it and the
# first run after a wipe just refetches every board once.
STATE_TABLE = os.environ.get("SCRAPE_STATE_TABLE")


def _watched_domains(s3) -> frozenset:
    """Companies with an alert on them, as the maintenance run last saw
    them. An empty set is the safe answer to every failure here: it means
    the sweep schedules exactly the way it did before this existed.
    """
    try:
        body = s3.get_object(Bucket=BUCKET, Key="watched-domains.json")["Body"].read()
        return frozenset(json.loads(body).get("domains") or ())
    except Exception as e:
        print(f"watched-domains.json unreadable, nobody gets the fast lane this tick: {e!r}")
        return frozenset()


def _write_status(s3, phase: str, detail: str = "") -> None:
    """Best-effort, real-time "what is the pipeline doing right now"
    signal -- read by /api/pipeline-status (api/handler.py) so the
    frontend can show an actual phase (scraping/loading/idle/error)
    instead of just a last-updated timestamp, which says nothing about
    whether a run is even in progress. Never allowed to break the real
    pipeline: a status write failing is a cosmetic loss, not a reason to
    fail the whole invocation.
    """
    try:
        s3.put_object(
            Bucket=BUCKET, Key="status.json",
            Body=json.dumps({
                "phase": phase, "detail": detail, "run": "fast-poll",
                "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }).encode("utf-8"),
            ContentType="application/json",
        )
    except Exception as e:
        print(f"status.json write failed (non-fatal): {e!r}")


def _stream_results(path: Path, meta: list):
    """probe.py's --out file, one board per line: each yielded whole for
    the fragment writer, with a copy minus its jobs kept in meta for the
    scheduler and the counts. One board's jobs in memory at a time."""
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            if not line.strip():
                continue
            r = json.loads(line)
            meta.append({k: v for k, v in r.items() if k != "jobs"})
            yield r


def lambda_handler(event, context):
    s3 = boto3.client("s3")
    known_path = TMP / "known.json"
    try:
        s3.download_file(BUCKET, "known.json", str(known_path))
    except ClientError as e:
        if e.response["Error"]["Code"] in ("404", "NoSuchKey"):
            # Same as scrape-fast.yml's own early exit: nothing to
            # re-poll before scrape-discover.yml's first run has ever
            # produced known.json.
            print("known.json not in S3 yet, skipping this run")
            return {"skipped": True}
        raise

    known = json.loads(known_path.read_text(encoding="utf-8"))

    # Every company, every run. Sharding existed because a poll used to
    # mean downloading and parsing a whole board, so the only way to keep
    # cost flat as the company list grew was to check 1/NUM_SHARDS of it
    # per invocation -- which is precisely why a new job took up to 5.8
    # hours to be noticed. Conditional polling removed that cost:
    # measured live, a 50-company shard where everything answered 304
    # completed in 2.3s, and most of even that was the partition round
    # trip rather than the polling. Sweeping all of them costs seconds.
    # Every board is a candidate; scrape_state.due decides which are
    # actually polled. The old fixed-window rotation is gone: it split
    # the list by position, which is unrelated to whether a board has
    # anything new, so it delayed busy boards and still polled dead ones
    # on a schedule.
    sweep = known

    # Poll state: which boards are due, and the validators to send them.
    #
    # Both used to be separate problems. The validators lived in
    # DynamoDB (~286,000 reads a day for 200KB of mostly-static text) and
    # every board was polled every five minutes regardless of whether it
    # had ever changed. Measured over 27 consecutive sweeps, 101 of 3,434
    # boards changed at all. The other 97% answered "nothing changed"
    # twenty-seven times in a row.
    #
    # Now one gzipped S3 object holds both, and each board carries its
    # own interval: reset to 3 minutes by a change, backed off by 1.5x
    # per quiet poll up to 20. See loader/scrape_state.py.
    poll_state, state_etag = scrape_state.load(BUCKET, s3, STATE_TABLE)
    # The boards somebody is waiting on. They get a much lower ceiling so
    # a posting reaches the reader who asked for it in half an hour
    # rather than four. The file is written by the maintenance run, which
    # reads the alert table anyway; missing it is not an error, it only
    # means everything backs off the way it always did.
    watched = _watched_domains(s3)
    # Rows for companies that have left the list. Harmless but permanent
    # without this: due() only ever looks up companies that exist, so an
    # orphan is never swept and never expires.
    dropped = scrape_state.prune(poll_state, known)
    if dropped:
        print(f"pruned {dropped} state rows with no company behind them")
    # Boards the box's scrape worker owns are its to poll and publish,
    # and polling them here as well would send every change twice. See
    # scrape_state.CLAIM_KEY.
    claim = scrape_state.load_claim(BUCKET, s3)
    ours = [e for e in sweep if not scrape_state.worker_owns(e.get("domain"), claim)]
    if len(ours) < len(sweep):
        print(f"{len(sweep) - len(ours)} boards belong to the box worker, left to it")
    sweep = scrape_state.due(poll_state, ours)
    if not sweep:
        # Everything is inside its own interval. Nothing to do, and
        # saying so costs a second rather than a full sweep.
        _write_status(s3, "idle", "no boards due this tick")
        print("no boards due")
        return {"swept": 0, "unchanged": 0, "changed": 0, "fragments": 0,
                "hits": 0, "errors": 0, "jobs": 0}

    shard_path = TMP / "known-shard.json"
    shard_path.write_text(json.dumps(sweep, ensure_ascii=False), encoding="utf-8")
    # A warm container keeps /tmp between runs; a stale file here would
    # be read as this run's results if the probe died before opening it.
    results_path = TMP / "results.ndjson"
    results_path.unlink(missing_ok=True)

    _write_status(s3, "scraping", f"sweeping {len(sweep)} of {len(known)} companies due now")

    # The probe writes each board's result to results_path as it lands
    # and stops taking boards at PROBE_DEADLINE_MIN. The 420s timeout is
    # only a backstop now, for a probe that hangs rather than finishes;
    # even then the file holds every board polled before it.
    try:
        probe = subprocess.run(
            [sys.executable, str(ROOT / "probe.py"), "--known", str(shard_path),
             "--out", str(results_path), "--deadline-minutes", str(PROBE_DEADLINE_MIN)],
            capture_output=True, text=True, timeout=420,
        )
    except subprocess.TimeoutExpired as e:
        print(f"probe.py killed at 420s; keeping what it wrote. stderr: {(e.stderr or '')[-800:]}")
        probe = None
    if probe is not None:
        if probe.stderr:
            print(probe.stderr)
        if probe.returncode != 0:
            print(f"probe.py exited {probe.returncode}; keeping what it wrote")
    if not results_path.exists():
        _write_status(s3, "error", "probe.py wrote no results")
        raise RuntimeError("probe.py wrote no results")

    # Fragments before poll state, and both from the file, one board at a
    # time. A fragment written for a board whose state then fails to save
    # is polled once more next run, a harmless repeat; state saved for a
    # board whose fragment was never written would leave its listings
    # unposted until the board next changed.
    _write_status(s3, "loading", "writing deltas for the boards that changed")
    meta: list[dict] = []
    fragments = put_fragment(BUCKET, _stream_results(results_path, meta))
    print(f"delta fragments: {len(fragments)} written"
          if fragments else "delta fragments: (nothing changed, none written)")

    # A deferred board was never asked. It is not scheduled, so it keeps
    # its old due time and stays at the front of the line.
    data = [r for r in meta if not r.get("deferred")]
    deferred = len(meta) - len(data)
    hits = [r for r in data if r.get("ats")]
    errors = [r["domain"] for r in data if r.get("error")]
    unchanged = [r for r in data if r.get("unchanged")]
    n_jobs = sum(r["job_count"] for r in hits)
    sched = scrape_state.record(poll_state, data, watched=watched)
    saved = scrape_state.save(BUCKET, s3, poll_state, state_etag)
    changed = [r for r in data if r.get("ats") and not r.get("unchanged")]
    print(f"sweep: {len(hits)}/{len(data)} re-verified, {n_jobs} jobs, "
          f"{len(unchanged)} unchanged, poll state {'saved' if saved else 'NOT saved'} "
          f"({sched['changed']} reset to floor, {sched['unchanged']} backed off, "
          f"{sched['errored']} held)"
          + (f"; {deferred} boards not reached by the deadline, left for the next run" if deferred else ""))
    if errors:
        print(f"{len(errors)} known boards failed to re-poll: {len(errors)} companies")

    # The fragments above are one small write, not N partition rewrites.
    # That is what makes a wide sweep affordable: persisting a sweep used
    # to mean a 48MB pull-modify-push per shard it touched, 50-170s each,
    # and a run wanting 18 of them finished 1 and discarded the rest. A
    # fragment holds only the companies that actually changed, so the
    # sweep never opens a database at all and the write is kilobytes.
    # The applier on the box replays them; fragments survive until a
    # snapshot containing them has been pushed, so a crash there costs a
    # repeat, never a listing.
    _write_status(s3, "idle", f"last sweep: {len(data)} companies, {len(unchanged)} unchanged, "
                              f"{len(changed)} changed, {n_jobs} jobs")
    return {"swept": len(data), "unchanged": len(unchanged), "changed": len(changed),
            "fragments": len(fragments), "hits": len(hits),
            "errors": len(errors), "jobs": n_jobs}
