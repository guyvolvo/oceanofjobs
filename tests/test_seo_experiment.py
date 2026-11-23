"""The Indexing API experiment: who gets which arm, and what counts.

The two ways this experiment could lie without anyone noticing are an
assignment that is not balanced within each hiring system (so the ATS
mix, not the API, explains a difference) and a crawl counted from before
enrolment. Both are pinned here.

Run directly, no framework:  python tests/test_seo_experiment.py
"""

import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "box"))

import seo_experiment as se  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failures.append(name)


cands = ([{"id": "g%03d" % i, "ats": "greenhouse"} for i in range(101)]
         + [{"id": "w%03d" % i, "ats": "workday"} for i in range(40)]
         + [{"id": "c0", "ats": "comeet"}])
out = se.assign(cands, seed=7)
per = Counter((m["ats"], m["arm"]) for m in out)
check("every candidate gets exactly one arm", len(out) == len(cands) and {m["arm"] for m in out} == {"treatment", "control"})
check("each ATS splits as evenly as its size allows",
      all(abs(per[(a, "treatment")] - per[(a, "control")]) <= 1 for a in ("greenhouse", "workday", "comeet")), str(per))
check("the same seed gives the same arms", se.assign(cands, seed=7) == out)
check("and the order candidates arrive in does not matter", se.assign(list(reversed(cands)), seed=7) == out)
arm_of = {m["id"]: m["arm"] for m in out}
check("a different seed gives different arms",
      {m["id"]: m["arm"] for m in se.assign(cands, seed=8)} != arm_of)

check("a page Google never saw is eligible", se.eligible({"verdict": "NEUTRAL", "coverage": "URL is unknown to Google", "crawled": None}))
check("a page already crawled is not", not se.eligible({"verdict": "NEUTRAL", "crawled": "2026-11-09T01:00:00Z"}))
check("nor one already indexed", not se.eligible({"verdict": "PASS", "crawled": None}))

state = {"enrolled_at": "2026-11-10T00:00:00+00:00", "members": [
    {"arm": "treatment", "notify_status": 200, "obs": [
        {"at": "2026-11-11T00:00:00+00:00", "crawled": "2026-11-10T06:00:00Z", "verdict": "NEUTRAL"},
        {"at": "2026-11-12T00:00:00+00:00", "crawled": "2026-11-11T12:00:00Z", "verdict": "PASS"}]},
    {"arm": "treatment", "notify_status": 200, "closed_at": "2026-11-11T09:00:00+00:00", "obs": [
        {"at": "2026-11-11T00:00:00+00:00", "crawled": None, "verdict": "NEUTRAL"}]},
    {"arm": "control", "obs": [
        {"at": "2026-11-11T00:00:00+00:00", "crawled": "2026-11-09T22:00:00Z", "verdict": "NEUTRAL"}]},
]}
s = se.summarize(state)
t, c = s["treatment"], s["control"]
check("first crawl is the earliest seen, not the latest", t["median_crawl_h"] == 6.0, str(t))
check("time to index runs to the first read that saw it indexed", t["median_index_d"] == 2.0, str(t))
check("a job that closed stays in the cohort and is counted", t["n"] == 2 and t["closed"] == 1, str(t))
check("a crawl from before enrolment does not count", c["crawled"] == 0 and c["median_crawl_h"] is None, str(c))
check("notified counts only accepted sends", t["notified"] == 2 and c["notified"] == 0, str(s))

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
