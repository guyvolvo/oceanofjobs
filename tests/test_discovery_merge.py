"""merge_discovered_batch.main: where each kind of candidate ends up.

A candidate discovery verified carries its ats and token, and the merge
used to throw the token away and re-probe the guessed domain, which lost
every board whose slug a guess cannot reach (workable:deloitte6). Oracle
boards went to known.json, which the fast poll skips, so they were never
scraped. A candidate that probed to nothing was dropped silently and
queued again by the next day's discovery.

Run directly, no framework:  python tests/test_discovery_merge.py
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "api"))
sys.path.insert(0, str(ROOT / "loader"))
os.environ.setdefault("AWS_DEFAULT_REGION", "il-central-1")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "testing")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "testing")
os.environ["DATA_BUCKET"] = "test-bucket"

import discover_companies as dc  # noqa: E402
import load_to_sqlite as lts  # noqa: E402
import merge_discovered_batch as mdb  # noqa: E402
import probe  # noqa: E402
import scrape_workday_handler as handler  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failures.append(name)


tmp = Path(tempfile.mkdtemp())
saved = (mdb.ROOT, mdb.QUEUE_PATH, mdb.DOMAINS_PATH, mdb.TENANTS_PATH, mdb.ORACLE_PATH, mdb.REJECTED_PATH,
         mdb.recent_fast_poll_had_errors, mdb.latest_fast_poll_duration_ms, mdb.subprocess.run,
         lts.s3_pull, lts.s3_push_conditional)
try:
    queue = [
        {"ats": "comeet", "token": "91.001:abc", "domain": "comeetco.com", "job_count": 5},
        {"ats": "workable", "token": "deloitte6", "domain": "deloitte6.com", "job_count": 40},
        {"ats": "oracle", "token": "ebcs.fa.em2.oraclecloud.com:CX_1", "domain": "arcadis.com",
         "job_count": 90, "israel_job_count": 2},
        {"ats": None, "token": None, "domain": "dead.example", "job_count": 0},
    ]
    mdb.ROOT = tmp
    mdb.QUEUE_PATH = tmp / "queue.json"
    mdb.DOMAINS_PATH = tmp / "domains.txt"
    mdb.TENANTS_PATH = tmp / "workday-tenants.json"
    mdb.ORACLE_PATH = tmp / "oracle-boards.json"
    mdb.REJECTED_PATH = tmp / "discovery-rejected.json"
    mdb.QUEUE_PATH.write_text(json.dumps(queue), encoding="utf-8")
    mdb.DOMAINS_PATH.write_text("existing.com\n", encoding="utf-8")
    mdb.recent_fast_poll_had_errors = lambda: False
    mdb.latest_fast_poll_duration_ms = lambda: 1000.0

    probed = []

    def fake_probe(cmd, **kw):
        domains = cmd[cmd.index("--domain") + 1].split(",")
        probed.extend(domains)
        rows = [{"domain": d, "ats": None, "token": None, "retryable": False, "error": "no ATS matched"} for d in domains]
        return subprocess.CompletedProcess(cmd, 0, json.dumps(rows), "")

    mdb.subprocess.run = fake_probe

    # known.json in S3, with a write by someone else landing between the
    # merge's read and its push: the first conditional push fails.
    s3 = {"body": [{"domain": "old.com", "ats": "greenhouse", "token": "old"}], "etag": "v1"}
    pushes = []

    def fake_pull(bucket, key, dest):
        Path(dest).write_text(json.dumps(s3["body"]), encoding="utf-8")
        return True, s3["etag"]

    def fake_push(bucket, key, src, etag):
        pushes.append(etag)
        if etag != s3["etag"]:
            return False
        s3["body"], s3["etag"] = json.loads(Path(src).read_text(encoding="utf-8")), etag + "+"
        return True

    def racing_pull(bucket, key, dest):
        got = fake_pull(bucket, key, dest)
        # The full sweep's push lands right after this read.
        s3["body"] = s3["body"] + [{"domain": "meanwhile.com", "ats": "lever", "token": "mw"}]
        s3["etag"] = "v2"
        lts.s3_pull = fake_pull
        return got

    lts.s3_pull = racing_pull
    lts.s3_push_conditional = fake_push

    rc = mdb.main()
    known = {e["domain"]: e for e in s3["body"]}
    check("main succeeds", rc == 0, repr(rc))
    check("only the candidate without a token is probed", probed == ["dead.example"], repr(probed))
    check("the Comeet pin reaches known.json on its token",
          known.get("comeetco.com", {}).get("token") == "91.001:abc", repr(known.get("comeetco.com")))
    check("an unguessable Workable token reaches known.json without probing",
          known.get("deloitte6.com") == {"domain": "deloitte6.com", "ats": "workable", "token": "deloitte6"},
          repr(known.get("deloitte6.com")))
    check("a write that landed meanwhile is kept, and the old entry too",
          "meanwhile.com" in known and "old.com" in known, repr(sorted(known)))
    check("the conflicting push was retried against the newer ETag", pushes == ["v1", "v2"], repr(pushes))
    check("the Oracle board is not in known.json (the fast poll skips oracle)", "arcadis.com" not in known)
    oracle = json.loads(mdb.ORACLE_PATH.read_text(encoding="utf-8"))
    check("the Oracle board goes to oracle-boards.json",
          [(b["domain"], b["token"]) for b in oracle] == [("arcadis.com", "ebcs.fa.em2.oraclecloud.com:CX_1")], repr(oracle))
    rejected = json.loads(mdb.REJECTED_PATH.read_text(encoding="utf-8"))
    check("the dead candidate goes to the rejected list", [r["domain"] for r in rejected] == ["dead.example"], repr(rejected))
    check("and is not queued again", json.loads(mdb.QUEUE_PATH.read_text(encoding="utf-8")) == [])
    lines = mdb.DOMAINS_PATH.read_text(encoding="utf-8").splitlines()
    check("domains.txt gets the non-Oracle domains as before",
          {"comeetco.com", "deloitte6.com", "dead.example"} <= set(lines) and "arcadis.com" not in lines, repr(lines))

    # The slow Lambda reads the Oracle list, minus anything companies.yml pins.
    handler.ORACLE_PATH = mdb.ORACLE_PATH
    got = handler._oracle_boards()
    check("the slow Lambda reads the discovered Oracle board",
          [(a, d, b["token"]) for a, d, b in got] == [("oracle", "arcadis.com", "ebcs.fa.em2.oraclecloud.com:CX_1")], repr(got))
    pinned_token = next(iter(probe.PINS.get("oracle", {}).values()))["token"]
    mdb.add_oracle_boards([{"ats": "oracle", "token": pinned_token, "domain": "pinned-elsewhere.com"}])
    check("a board companies.yml already pins is not read twice",
          all(b["token"] != pinned_token for _, _, b in handler._oracle_boards()))
finally:
    (mdb.ROOT, mdb.QUEUE_PATH, mdb.DOMAINS_PATH, mdb.TENANTS_PATH, mdb.ORACLE_PATH, mdb.REJECTED_PATH,
     mdb.recent_fast_poll_had_errors, mdb.latest_fast_poll_duration_ms, mdb.subprocess.run,
     lts.s3_pull, lts.s3_push_conditional) = saved
    shutil.rmtree(tmp, ignore_errors=True)

# Discovery skips a rejected token until it expires, and rotates the
# verify window so a pool larger than the limit is all checked.
tmp = Path(tempfile.mkdtemp())
try:
    old = time.strftime("%Y-%m-%d", time.gmtime(time.time() - (dc.REJECTED_DAYS + 1) * 86400))
    today = time.strftime("%Y-%m-%d", time.gmtime())
    (tmp / "r.json").write_text(json.dumps([{"ats": "workable", "token": "gone", "rejected": today},
                                            {"ats": "workable", "token": "expired", "rejected": old}]))
    check("a rejected entry expires", [r["token"] for r in dc.load_rejected(tmp / "r.json")] == ["gone"])
    check("a missing rejected list is empty", dc.load_rejected(tmp / "missing.json") == [])
finally:
    shutil.rmtree(tmp, ignore_errors=True)

pool = [f"t{i:02d}" for i in range(10)]
seen = set()
for day in (1, 2, 3):
    window = dc.rotate(pool, 4, day)
    check(f"day {day} checks 4 distinct candidates", len(window) == 4 == len(set(window)), repr(window))
    seen.update(window)
check("consecutive days cover the whole pool, tail included", seen == set(pool), repr(sorted(set(pool) - seen)))
check("a pool under the limit is checked whole", sorted(dc.rotate(pool[:3], 4, 7)) == pool[:3])

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
