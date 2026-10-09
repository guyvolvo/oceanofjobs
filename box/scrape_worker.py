"""The fast re-poll as a continuous worker on the box.

The scrape-fast Lambda wakes every five minutes, sweeps up to 900 due
boards in one batch and dies. Lambda bills allocated memory times wall
clock, so that was 3GB held for about 90 seconds of every five minutes,
most of it spent waiting on other people's servers: 60% of a Lambda bill
that passed the free tier five days into October 2026. The batch was
also a ceiling. Each tick took at most 900 boards, so on a busy morning
2,175 were due and the rest waited for the next one.

This does the same work without either limit. It takes the boards that
are due now, most overdue first, a hundred at a time, polls them with
the same probe.py, sends what changed as the same delta fragments the
applier already replays, and records each board's next due time in its
own copy of the poll state. Then it does it again, sleeping only when
nothing is due. The schedule itself (scrape_state: a change resets a
board to five minutes, quiet polls back it off to four hours) is
unchanged; what changes is that a board is now polled when it is due
rather than when a tick next has room for it.

It shares the box with the API, so it is built to stay small: probe.py
runs in a subprocess per batch with 8 threads (about 110MB, measured;
the memory goes back to the system when each batch ends), and the unit
caps it (see CUTOVER.md). The worker only owns the boards
worker-claim.json gives it (scrape_state.worker_owns); the Lambda skips
those, so a slice can move over, be measured, and move back.

It exits after an hour and systemd starts it again, which is how a
deploy reaches it without anything restarting it by hand.
"""
import gzip
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import boto3

try:
    import resource  # Linux; the worker's own memory report only
except ImportError:
    resource = None

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "loader"))
import scrape_state  # noqa: E402
from deltas import put_fragment  # noqa: E402
sys.path.insert(0, str(ROOT))
from probe import SLOW_BOARD_ATS  # noqa: E402

BUCKET = os.environ["DATA_BUCKET"]
# Its own state object, never the Lambda's: two writers on one object
# would keep failing each other's conditional saves.
STATE_KEY = os.environ.get("SCRAPE_WORKER_STATE_KEY", "scrape-state-worker.json.gz")
WORK = Path(os.environ.get("STATE_DIRECTORY") or "/tmp/otj-scrape")
BATCH = int(os.environ.get("SCRAPE_WORKER_BATCH") or 100)
PROBE_WORKERS = os.environ.get("SCRAPE_WORKER_THREADS") or "8"
# A batch of 100 takes about ten seconds; this only stops a probe that
# hangs. What it wrote before then is kept, as the Lambda does.
PROBE_TIMEOUT_S = 300
RUN_FOR_S = 3600
KNOWN_EVERY_S = 600
CLAIM_EVERY_S = 60
IDLE_MAX_S = 30
# No board is asked twice inside this, whatever the schedule says. The
# Lambda could not retry faster than its five-minute tick; this loop can
# retry within a second, and on its first run on the box it did: a board
# that errors is held at its old due time, so it was due again at once.
RETRY_FLOOR_S = scrape_state.FLOOR_S
# A batch of one or two boards costs a whole probe.py start-up, which was
# most of the worker's CPU on the box (36 CPU-seconds in its first four
# minutes, about 15% of a core). Due boards are gathered for up to this
# long first; a board polled 20 seconds after it came due loses nothing.
COALESCE_S = 20
# How often what changed is sent on. Every fragment wakes the applier on
# the box, and each apply costs about twenty seconds of disk whatever its
# size. Sending one per batch ran the applier 44 times in 80 minutes
# where the Lambda's one per five-minute tick had run it 16 (2026-10-08,
# the 10% trial), and disk stalls doubled. So changed boards wait in a
# local spool and go out together, the Lambda's rhythm. The poll state is
# saved only after they are sent: a crash in between means those boards
# are polled again, never that a listing is lost.
FLUSH_S = 300


def log(msg):
    print(msg, flush=True)


def _get_json(s3, key, gz=False):
    body = s3.get_object(Bucket=BUCKET, Key=key)["Body"].read()
    return json.loads(gzip.decompress(body) if gz else body)


def _save_state(s3, state, etag):
    """Conditional write; returns the new ETag, or None when the save
    failed. Only this worker writes STATE_KEY, so a failure is a real
    error rather than a race, and the next save tries again."""
    body = gzip.compress(json.dumps(state, separators=(",", ":")).encode("utf-8"))
    kwargs = {"Bucket": BUCKET, "Key": STATE_KEY, "Body": body,
              "ContentType": "application/json", "ContentEncoding": "gzip"}
    if etag:
        kwargs["IfMatch"] = etag
    else:
        kwargs["IfNoneMatch"] = "*"
    try:
        return s3.put_object(**kwargs)["ETag"]
    except Exception as e:
        log(f"poll state not saved: {e!r}")
        return None


def _seed(s3, state, owned):
    """Copy the Lambda's rows for boards this worker now owns and has no
    row for, so a board moving over keeps its validators and its next
    due time instead of being fetched in full the moment it arrives."""
    missing = [d for d in owned if d not in state]
    if not missing:
        return 0
    try:
        main = _get_json(s3, scrape_state.KEY, gz=True)
    except Exception as e:
        log(f"couldn't read the Lambda's poll state to seed from: {e!r}")
        return 0
    n = 0
    for d in missing:
        if d in main:
            state[d] = main[d]
            n += 1
    return n


def _watched(s3):
    try:
        return frozenset(_get_json(s3, "watched-domains.json").get("domains") or ())
    except Exception:
        return frozenset()


def _flush(s3, spool, state, etag):
    """Send the spooled changes as one fragment, then save the poll state.
    Returns (etag, fragments sent)."""
    sent = []
    if spool.exists() and spool.stat().st_size:
        with open(spool, encoding="utf-8") as fh:
            sent = put_fragment(BUCKET, (json.loads(line) for line in fh if line.strip()))
    spool.unlink(missing_ok=True)
    return _save_state(s3, state, etag) or etag, len(sent)


def _results(path, meta):
    """probe.py's --out file, one board at a time (see scrape_handler)."""
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                r = json.loads(line)
                meta.append({k: v for k, v in r.items() if k != "jobs"})
                yield r


def _overdue(state, domains, now, failing_set):
    """(waiting, oldest wait in seconds, failing). A board whose last poll
    failed is failing, not waiting: the scheduler holds an erroring board
    at its old due time, so counting it would make "oldest overdue" the
    age of a dead board rather than the backlog, which is the number the
    throughput test and the overnight watch read."""
    waiting, oldest, failing = 0, 0.0, 0
    for d in domains:
        nxt = scrape_state._parse((state.get(d) or {}).get("next_at"))
        late = float("inf") if nxt is None else (now - nxt).total_seconds()
        if late <= 0:
            continue
        if d in failing_set:
            failing += 1
            continue
        waiting += 1
        if late != float("inf"):
            oldest = max(oldest, late)
    return waiting, oldest, failing


def _sleep_for(state, domains, now):
    """Until the next owned board comes due, between 5 and IDLE_MAX_S
    seconds. Never less: a board with no due time that was just tried is
    held back by RETRY_FLOOR_S, and treating it as due now made the loop
    spin without sleeping."""
    soonest = None
    for d in domains:
        nxt = scrape_state._parse((state.get(d) or {}).get("next_at"))
        if nxt is None:
            continue
        wait = (nxt - now).total_seconds()
        soonest = wait if soonest is None else min(soonest, wait)
    return max(5.0, min(IDLE_MAX_S, soonest if soonest is not None else IDLE_MAX_S))


def main():
    WORK.mkdir(parents=True, exist_ok=True)
    s3 = boto3.client("s3")
    started = time.time()
    try:
        obj = s3.get_object(Bucket=BUCKET, Key=STATE_KEY)
        state, etag = json.loads(gzip.decompress(obj["Body"].read())), obj["ETag"]
    except s3.exceptions.NoSuchKey:
        state, etag = {}, None
    known, known_at, claim, claim_at, watched = [], 0.0, {}, 0.0, frozenset()
    owned_key = None
    attempted: dict[str, float] = {}
    failing_set: set[str] = set()
    gathering = None
    # Left by a run that stopped between a batch and its flush. Its poll
    # state was never saved, so those boards come due again and are
    # re-polled; sending this copy as well would only repeat them.
    spool = WORK / "spool.ndjson"
    spool.unlink(missing_ok=True)
    last_flush, dirty, spooled = time.time(), False, 0
    log(f"scrape worker up: {len(state)} boards in {STATE_KEY}, batches of {BATCH} on {PROBE_WORKERS} threads")
    while time.time() - started < RUN_FOR_S:
        now_s = time.time()
        if now_s - known_at > KNOWN_EVERY_S:
            known = _get_json(s3, "known.json")
            watched = _watched(s3)
            known_at = now_s
        if now_s - claim_at > CLAIM_EVERY_S:
            try:
                claim = scrape_state.load_claim(BUCKET, s3)
            except Exception as e:  # noqa: BLE001 -- an unreadable claim keeps the last one
                log(f"worker-claim.json unreadable, keeping the last claim: {e!r}")
            claim_at = now_s
        # Only boards probe.py can poll. known.json keeps a few entries
        # with no ATS or token; the Lambda's sweep carries them along
        # harmlessly, but a batch of nothing else makes probe.py exit 2
        # without a result, so they stayed due and were retried every
        # second (2026-10-08, the trial's first five minutes).
        # And not the slow-board ATSes (Workday, big-tech career sites):
        # probe.py --known drops those silently, because the Workday
        # Lambda polls them, so they came back without a result, were
        # never scheduled, and sat due forever.
        mine = [e for e in known if e.get("ats") and e.get("token") and e["ats"] not in SLOW_BOARD_ATS
                and scrape_state.worker_owns(e.get("domain"), claim)]
        domains = [e["domain"] for e in mine]
        key = (len(known), json.dumps(claim, sort_keys=True))
        if key != owned_key:
            seeded = _seed(s3, state, domains)
            owned_key = key
            log(f"owns {len(mine)} of {len(known)} boards (claim {claim.get('fast')}); seeded {seeded} from the Lambda's state")
            if seeded:
                etag = _save_state(s3, state, etag) or etag
        if not mine:
            time.sleep(IDLE_MAX_S)
            continue

        now = datetime.now(timezone.utc)
        floor = time.time() - RETRY_FLOOR_S
        due = [e for e in scrape_state.due(state, mine, now=now) if attempted.get(e["domain"], 0) < floor]
        if not due:
            time.sleep(_sleep_for(state, domains, now))
            continue
        rank = lambda e: scrape_state._parse((state.get(e["domain"]) or {}).get("next_at")) or datetime.min.replace(tzinfo=timezone.utc)  # noqa: E731
        due.sort(key=rank)
        if len(due) < BATCH // 4:
            gathering = gathering or time.time()
            if time.time() - gathering < COALESCE_S:
                time.sleep(5)
                continue
        gathering = None
        batch = due[:BATCH]
        for e in batch:
            attempted[e["domain"]] = time.time()

        t0 = time.time()
        batch_path, out_path = WORK / "batch.json", WORK / "results.ndjson"
        batch_path.write_text(json.dumps(batch, ensure_ascii=False), encoding="utf-8")
        out_path.unlink(missing_ok=True)
        try:
            p = subprocess.run(
                [sys.executable, str(ROOT / "probe.py"), "--known", str(batch_path), "--out", str(out_path)],
                cwd=str(ROOT), env={**os.environ, "PROBE_WORKERS": PROBE_WORKERS},
                capture_output=True, text=True, timeout=PROBE_TIMEOUT_S,
            )
            if p.returncode != 0:
                log(f"probe.py exited {p.returncode}; keeping what it wrote. {(p.stderr or '')[-400:]}")
        except subprocess.TimeoutExpired:
            log(f"probe.py killed at {PROBE_TIMEOUT_S}s; keeping what it wrote")
        if not out_path.exists():
            log("probe.py wrote no results; trying again shortly")
            time.sleep(IDLE_MAX_S)
            continue

        # Changed boards go to the spool; the state is recorded in memory
        # and saved only when the spool is sent (see FLUSH_S).
        meta = []
        with open(spool, "a", encoding="utf-8") as fh:
            for r in _results(out_path, meta):
                if r.get("ats") and not r.get("unchanged"):
                    fh.write(json.dumps(r, ensure_ascii=False) + "\n")
                    spooled += 1
        data = [r for r in meta if not r.get("deferred")]
        sched = scrape_state.record(state, data, watched=watched)
        dirty = True
        fragments = []
        if time.time() - last_flush >= FLUSH_S:
            etag, n = _flush(s3, spool, state, etag)
            fragments = [None] * n
            last_flush, dirty, spooled = time.time(), False, 0
        changed = sum(1 for r in data if r.get("ats") and not r.get("unchanged"))
        unchanged = sum(1 for r in data if r.get("unchanged"))
        errors = sum(1 for r in data if r.get("error"))
        for r in data:
            if r.get("error") or not r.get("ats"):
                failing_set.add(r["domain"])
            else:
                failing_set.discard(r["domain"])
        late, oldest, failing = _overdue(state, domains, datetime.now(timezone.utc), failing_set)
        child_mb = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss / 1024 if resource else 0
        self_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024 if resource else 0
        log(f"batch {len(data)}/{len(due)} due: {changed} changed, {unchanged} unchanged, {errors} errors, "
            f"{len(fragments)} fragments, {time.time() - t0:.1f}s; waiting {late}, oldest {oldest / 60:.1f} min late, failing {failing}; "
            f"peak memory worker {self_mb:.0f}MB probe {child_mb:.0f}MB "
            f"({sched['changed']} to floor, {sched['unchanged']} backed off, {sched['errored']} held)")
    if dirty:
        etag, n = _flush(s3, spool, state, etag)
        log(f"sent the last {n} fragment(s) before exiting")
    log("an hour up; exiting so systemd starts the current code")


if __name__ == "__main__":
    main()
