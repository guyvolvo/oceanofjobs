"""Anonymous growth counts: how many visits, searches, job views, apply
clicks and so on, as one-minute totals in CloudWatch.

The page sends POST /api/event?e=<name> (frontend/count.js) and nothing
else: no cookie, no id, no body. This adds one to a counter in the
worker's memory, and a thread sends the totals to CloudWatch once a
minute as the Events metric, one dimension per event. Each gunicorn
worker sends its own totals and CloudWatch's Sum adds them up, so there
is nothing shared to keep. A worker that restarts loses at most a
minute's counts.

Only the box sends. On the Lambda fallback a process lives for a few
requests, so counts there are dropped rather than sent one by one.

The Grafana growth dashboard (infra/grafana/growth-dashboard.json)
reads these. The box role's PutMetricData is limited to the OceanOfJobs
namespace, so that is where they go.
"""

import os
import sys
import threading
import time
from collections import Counter

NAMESPACE = "OceanOfJobs"
METRIC = "Events"
# What a page may report. Anything else is refused, so a caller can't
# mint new metrics, each of which CloudWatch bills for by the month.
PAGE_EVENTS = frozenset({"visit", "new_visitor", "search", "job_view", "apply", "signin"})
# Counted by the server itself, never accepted from a page.
SERVER_EVENTS = frozenset({"alert_created"})
# Per event, per worker, per minute. Real traffic is a small fraction of
# this; it bounds how far one client looping on the endpoint can bend a
# day's numbers.
MAX_PER_MINUTE = 300
FLUSH_EVERY_S = 60

_counts: Counter = Counter()
_lock = threading.Lock()
_flusher: threading.Thread | None = None
_cw = None


def enabled() -> bool:
    """The box runs with DATA_PATH set; Lambda doesn't."""
    return bool(os.environ.get("DATA_PATH")) and not os.environ.get("AWS_LAMBDA_FUNCTION_NAME")


def record(name: str, from_page: bool = True) -> bool:
    """Count one event. False when the name isn't one a page may send."""
    allowed = PAGE_EVENTS if from_page else (PAGE_EVENTS | SERVER_EVENTS)
    if name not in allowed:
        return False
    if not enabled():
        return True
    with _lock:
        if _counts[name] < MAX_PER_MINUTE:
            _counts[name] += 1
    _ensure_flusher()
    return True


def take() -> dict[str, int]:
    """The counts since the last call, and a fresh start."""
    with _lock:
        out = dict(_counts)
        _counts.clear()
    return out


def flush(cw=None) -> dict[str, int]:
    """Send what has been counted. Nothing counted, nothing sent."""
    global _cw
    counts = take()
    if not counts:
        return counts
    data = [{"MetricName": METRIC, "Dimensions": [{"Name": "event", "Value": name}],
             "Value": n, "Unit": "Count"} for name, n in sorted(counts.items())]
    if cw is None:
        if _cw is None:
            import boto3
            _cw = boto3.client("cloudwatch")
        cw = _cw
    cw.put_metric_data(Namespace=NAMESPACE, MetricData=data)
    return counts


def _loop() -> None:
    while True:
        time.sleep(FLUSH_EVERY_S)
        try:
            flush()
        except Exception as e:  # noqa: BLE001 - a lost minute of counts is not worth a crash
            print(f"events: flush failed: {e!r}", file=sys.stderr)


def _ensure_flusher() -> None:
    global _flusher
    if _flusher is not None and _flusher.is_alive():
        return
    with _lock:
        if _flusher is not None and _flusher.is_alive():
            return
        _flusher = threading.Thread(target=_loop, name="events-flush", daemon=True)
        _flusher.start()
