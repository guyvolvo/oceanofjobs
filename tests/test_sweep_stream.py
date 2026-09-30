"""The fast sweep saves as it goes.

Before 2026-09-30 a sweep held every polled board's jobs until the end
and wrote them all at once, so a run that ran out of memory or time
saved nothing and the next run faced the same pile. Now probe.py hands
each board over the moment it lands, stops taking boards at a deadline
and leaves the rest untouched, and scrape_handler.py reads that file
one board at a time, writes fragments first and schedules only the
boards that were really polled.
"""
import json
import os
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "loader"))
os.environ.setdefault("DATA_BUCKET", "test-bucket")

import probe  # noqa: E402
import deltas  # noqa: E402
import scrape_handler  # noqa: E402
import scrape_state  # noqa: E402

failed = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failed.append(name)


def job(i):
    return probe.Job("greenhouse", "tok", str(i), f"Role {i}", "Tel Aviv", f"https://x/{i}")


# run_and_report hands each result to the sink as it lands and keeps no jobs.
seen = []
res = probe.run_and_report(
    ["a.com", "b.com"],
    lambda d: probe.Resolution(d, "greenhouse", "tok", 2, 1, jobs=[job(1), job(2)]),
    True, sink=lambda r: seen.append((r.domain, len(r.jobs))))
check("the sink gets every board with its jobs",
      sorted(seen) == [("a.com", 2), ("b.com", 2)], repr(seen))
check("the returned results carry no jobs", all(r.jobs == [] for r in res), repr(res))
check("but keep their counts", all(r.job_count == 2 for r in res))

# Past the deadline a known board is deferred, not polled.
calls = []
probe.refetch_known = lambda *a, **k: calls.append(a) or probe.Resolution(a[1], a[2], a[3], 1, 1)
probe.BATCH_DEADLINE = None
r = probe._poll_known(None, {"domain": "c.com", "ats": "lever", "token": "t"})
check("before the deadline the board is polled", r.ats == "lever" and calls and not r.deferred, repr(r))
probe.BATCH_DEADLINE = time.monotonic() - 1
calls.clear()
r = probe._poll_known(None, {"domain": "d.com", "ats": "lever", "token": "t"})
check("past the deadline the board is deferred, untouched",
      r.deferred and r.retryable and r.ats is None and not calls, repr(r))
check("a deferred board is still a retryable miss to the loader", r.error and r.retryable)
probe.BATCH_DEADLINE = None

# The handler reads the file one board at a time: the fragment writer
# sees whole records, the scheduler a copy without the jobs.
with tempfile.TemporaryDirectory() as td:
    path = Path(td) / "results.ndjson"
    rows = [
        {"domain": "a.com", "ats": "greenhouse", "job_count": 1, "jobs": [{"title": "x"}]},
        {"domain": "b.com", "ats": "greenhouse", "unchanged": True, "job_count": 0, "jobs": []},
        {"domain": "c.com", "ats": None, "error": "sweep deadline reached", "retryable": True, "deferred": True, "jobs": []},
    ]
    path.write_text("".join(json.dumps(r) + "\n" for r in rows) + "\n", encoding="utf-8")
    meta = []
    whole = list(scrape_handler._stream_results(path, meta))
    check("every line is yielded whole", [w["domain"] for w in whole] == ["a.com", "b.com", "c.com"] and whole[0]["jobs"])
    check("meta keeps everything but the jobs",
          len(meta) == 3 and all("jobs" not in m for m in meta) and meta[0]["job_count"] == 1, repr(meta))

    # put_fragment takes that stream and writes only the changed boards.
    class FakeS3:
        def __init__(self):
            self.puts = []

        def put_object(self, Bucket=None, Key=None, Body=None, ContentType=None):
            self.puts.append(json.loads(Body))

    fake = FakeS3()
    deltas.boto3 = type("m", (), {"client": staticmethod(lambda *a, **k: fake)})()
    meta2 = []
    keys = deltas.put_fragment("bucket", scrape_handler._stream_results(path, meta2))
    check("put_fragment reads a generator and writes the changed boards only",
          len(keys) == 1 and [c["domain"] for c in fake.puts[0]] == ["a.com"], repr(fake.puts))
    check("and the scheduler's copy was filled on the way", len(meta2) == 3)
    check("nothing changed means no client and no writes",
          deltas.put_fragment("bucket", iter([{"domain": "b.com", "ats": "x", "unchanged": True}])) == [])

# A deferred board keeps its old due time; a polled one is rescheduled.
state = {"a.com": {"interval_s": 300, "next_at": "2020-01-01T00:00:00+00:00"},
         "c.com": {"interval_s": 300, "next_at": "2020-01-01T00:00:00+00:00"}}
polled = [m for m in meta if not m.get("deferred")]
scrape_state.record(state, polled)
check("the polled board is rescheduled", state["a.com"]["next_at"] > "2020-01-02")
check("the deferred board is not", state["c.com"]["next_at"] == "2020-01-01T00:00:00+00:00")

print()
if failed:
    print(f"{len(failed)} failed:")
    for f in failed:
        print(f"  - {f}")
    sys.exit(1)
print("all passed")
