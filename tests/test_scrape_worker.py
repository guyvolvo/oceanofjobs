"""The box scrape worker and the claim that splits boards between it and
the scrape-fast Lambda. No network: S3 and probe.py are stand-ins."""
import gzip
import json
import os
import sys
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "loader"))
sys.path.insert(0, str(ROOT / "box"))
os.environ.setdefault("DATA_BUCKET", "test-bucket")

import scrape_state  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + str(detail)))
    if not ok:
        failures.append(name)


domains = [f"company{i}.com" for i in range(2000)]
tenth = {"fast": {"mod": 10, "keep": [0]}}
share = sum(scrape_state.worker_owns(d, tenth) for d in domains) / len(domains)
check("mod 10 keep [0] owns about a tenth", 0.07 < share < 0.13, share)
check("no claim owns nothing", not any(scrape_state.worker_owns(d, {}) for d in domains))
check("mod 1 owns everything", all(scrape_state.worker_owns(d, {"fast": {"mod": 1, "keep": [0]}}) for d in domains))
check("ownership ignores case", scrape_state.worker_owns("Company3.COM", tenth) == scrape_state.worker_owns("company3.com", tenth))
check("a malformed claim owns nothing", not scrape_state.worker_owns("a.com", {"fast": {"mod": "x", "keep": [0]}}))
check("another lane's claim does not count", not any(scrape_state.worker_owns(d, {"workday": {"mod": 1, "keep": [0]}}) for d in domains))
halves = [scrape_state.worker_owns(d, {"fast": {"mod": 2, "keep": [0]}}) for d in domains]
check("widening keep only adds boards", all(h for d, h in zip(domains, halves) if scrape_state.worker_owns(d, {"fast": {"mod": 2, "keep": [0]}})))


# One pass of the worker against a fake S3 and a fake probe.py.
class FakeS3:
    class exceptions:
        class NoSuchKey(Exception):
            pass

    def __init__(self, objects):
        self.objects = dict(objects)
        self.puts = []

    def get_object(self, Bucket, Key):
        if Key not in self.objects:
            raise self.exceptions.NoSuchKey(Key)
        body = self.objects[Key]
        return {"Body": types.SimpleNamespace(read=lambda: body), "ETag": f'"{len(self.puts)}"'}

    def put_object(self, Bucket, Key, Body, **kw):
        self.objects[Key] = Body
        self.puts.append((Key, kw))
        return {"ETag": f'"{len(self.puts)}"'}


owned = [d for d in domains[:200] if scrape_state.worker_owns(d, tenth)]
known = [{"domain": d, "ats": "greenhouse", "token": d.split(".")[0]} for d in domains[:200]]
past = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
main_state = {owned[0]: {"etag": "W/1", "next_at": past, "interval_s": 300}}
s3 = FakeS3({
    "known.json": json.dumps(known).encode(),
    "worker-claim.json": json.dumps(tenth).encode(),
    "watched-domains.json": json.dumps({"domains": []}).encode(),
    scrape_state.KEY: gzip.compress(json.dumps(main_state).encode()),
})

import scrape_worker as W  # noqa: E402

W.boto3 = types.SimpleNamespace(client=lambda name: s3)
W.WORK = ROOT / "tests" / "_scrape_worker_tmp"
sent = []
W.put_fragment = lambda bucket, results: [sent.append(r["domain"]) or f"f{len(sent)}" for r in results if r.get("ats") and not r.get("unchanged")]
probed = []


def fake_run(cmd, **kw):
    batch = json.loads(Path(cmd[cmd.index("--known") + 1]).read_text(encoding="utf-8"))
    probed.append(([e["domain"] for e in batch], kw.get("env", {}).get("PROBE_WORKERS"), batch))
    out = Path(cmd[cmd.index("--out") + 1])
    with out.open("w", encoding="utf-8") as fh:
        for i, e in enumerate(batch):
            changed = i == 0
            fh.write(json.dumps({"domain": e["domain"], "ats": "greenhouse", "token": e["token"],
                                 "job_count": 3, "unchanged": not changed,
                                 "jobs": [{"id": 1}] if changed else []}) + "\n")
    return types.SimpleNamespace(returncode=0, stderr="")


W.subprocess = types.SimpleNamespace(run=fake_run, TimeoutExpired=TimeoutError)
clock = {"t": 1000.0}
W.time = types.SimpleNamespace(time=lambda: clock["t"], sleep=lambda s: clock.__setitem__("t", clock["t"] + max(s, 1) + W.RUN_FOR_S))
W.main()

batch_domains, workers, batch = probed[0] if probed else ([], None, [])
check("the worker polls only the boards it owns", probed and set(batch_domains) == set(owned), (len(batch_domains), len(owned)))
check("it runs probe.py on 8 threads", workers == "8", workers)
check("a board moving over keeps the Lambda's validators",
      any(e["domain"] == owned[0] and e.get("etag") == "W/1" for e in batch), [e for e in batch if e["domain"] == owned[0]])
check("what changed is sent as a fragment", sent == [batch_domains[0]], sent)
saved = json.loads(gzip.decompress(s3.objects[W.STATE_KEY]))
check("its own state is saved, under its own key", set(owned) <= set(saved) and W.STATE_KEY != scrape_state.KEY, sorted(saved)[:3])
check("the Lambda's state is never written", all(k != scrape_state.KEY for k, _ in s3.puts), [k for k, _ in s3.puts])
check("every polled board gets a next due time", all(saved[d].get("next_at") for d in owned))
check("after the batch nothing is due, so the worker sleeps rather than polling again", len(probed) == 1, len(probed))

# What the first five minutes on the box did: owned entries with no ATS
# or token (probe.py exits 2 on a batch of only those), and a board that
# errors (held at its old due time). Two minutes of simulated time must
# poll the erroring board once, never the unresolvable ones, and sleep
# between passes rather than spin.
dead = [d for d in domains[200:400] if scrape_state.worker_owns(d, tenth)][:3]
bad = [d for d in domains[400:600] if scrape_state.worker_owns(d, tenth)][0]
known2 = [{"domain": d, "ats": None, "token": None} for d in dead] + [{"domain": bad, "ats": "lever", "token": "bad"}]
s3b = FakeS3({
    "known.json": json.dumps(known2).encode(),
    "worker-claim.json": json.dumps(tenth).encode(),
    "watched-domains.json": json.dumps({"domains": []}).encode(),
    scrape_state.KEY: gzip.compress(json.dumps({}).encode()),
})
W.boto3 = types.SimpleNamespace(client=lambda name: s3b)
W.STATE_KEY = "scrape-state-worker-test2.json.gz"
calls, sleeps = [], []


def erroring_run(cmd, **kw):
    batch = json.loads(Path(cmd[cmd.index("--known") + 1]).read_text(encoding="utf-8"))
    calls.append([e["domain"] for e in batch])
    out = Path(cmd[cmd.index("--out") + 1])
    out.write_text("".join(json.dumps({"domain": e["domain"], "ats": None, "token": None, "job_count": 0,
                                       "error": "HTTP 503", "retryable": True, "jobs": []}) + "\n" for e in batch),
                   encoding="utf-8")
    return types.SimpleNamespace(returncode=0, stderr="")


W.subprocess = types.SimpleNamespace(run=erroring_run, TimeoutExpired=TimeoutError)
clock2 = {"t": 5000.0}


def fake_sleep(sec):
    sleeps.append(sec)
    clock2["t"] += sec


W.time = types.SimpleNamespace(time=lambda: clock2["t"], sleep=fake_sleep)
W.RUN_FOR_S = 120
W.main()
check("entries with no ATS or token are never handed to probe.py",
      all(d not in dead for c in calls for d in c), calls)
check("an erroring board is polled once inside the retry floor, not every second",
      sum(c.count(bad) for c in calls) == 1, calls)
check("between passes the worker sleeps at least 5 seconds",
      sleeps and min(sleeps) >= 5, sleeps[:10])

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
