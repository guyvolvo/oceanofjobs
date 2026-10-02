"""What counts as an expensive request, and the guard that limits them.

The box serves the API from gunicorn's 8 slots (-w 2 --threads 4). With
no limit, four slow facet computations could hold every slot while the
cheap requests behind them (the board's listing page, a job page, the
health check) queued and the site looked dead. So expensive work runs
under a per-worker permit: at most LIMIT at once per worker, which is 4
across the box, and at least 4 slots stay free for everything else.

The guard sits where the expensive work actually starts, not on the URL:
a facets request answered from the precomputed artifact or a per-worker
cache costs nothing and never waits here. The kinds below are the whole
list. A new heavy route takes one of them, and tests/test_expensive.py
drives every guarded route with the permits used up and expects 429, so
a route that skips the guard fails there.

A request that cannot get a permit within WAIT_S is told 429 with a
Retry-After. That is intentional limiting, not a failure, and the
frontend's getJSON already retries 429 with backoff.
"""

import threading
import time
from contextlib import contextmanager

KINDS = {
    "search": "/api/jobs with search or keywords: the full-text index",
    "live_aggregate": "/api/facets and /api/stats computed live, past the artifact and the worker cache",
    "directory": "/api/companies/directory past its cache, /api/companies/search",
    "company_page": "/company/<domain>: a company can have 26,000 rows",
}
LIMIT = 2
WAIT_S = 3.0
RETRY_AFTER_S = 2

_permits = threading.BoundedSemaphore(LIMIT)


class Busy(Exception):
    """No permit within WAIT_S. Answered with 429."""

    def __init__(self, kind: str):
        super().__init__(kind)
        self.kind = kind


@contextmanager
def guard(kind: str):
    if kind not in KINDS:
        raise ValueError(f"unknown expensive kind {kind!r}; add it to expensive.KINDS")
    if not _permits.acquire(timeout=WAIT_S):
        raise Busy(kind)
    try:
        yield
    finally:
        _permits.release()


def reset(limit: int = LIMIT) -> None:
    """For tests: a fresh semaphore of `limit` permits."""
    global _permits
    _permits = threading.BoundedSemaphore(limit)


def hold_all():
    """For tests: take every permit, returning a function that gives them back."""
    taken = 0
    while _permits.acquire(blocking=False):
        taken += 1

    def give_back():
        for _ in range(taken):
            _permits.release()
    return give_back


# Statement deadline. A runaway query must not hold a slot past
# CloudFront's 60s origin timeout, so each request on the box gets one
# here; db.py's progress handler interrupts a statement past it, and the
# handler answers 503 (the server did fail to answer that one).
STATEMENT_DEADLINE_S = 25.0
_deadline = threading.local()


def start_request() -> None:
    _deadline.at = time.monotonic() + STATEMENT_DEADLINE_S


def past_deadline() -> bool:
    at = getattr(_deadline, "at", None)
    return at is not None and time.monotonic() > at
