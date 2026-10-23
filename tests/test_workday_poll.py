"""Workday, read the fast way: one page to see whether a board moved,
every page at once when it did, and tenants found rather than pinned.

Run directly, no framework:  python tests/test_workday_poll.py
"""

import json
import os
import sys
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "api"))
sys.path.insert(0, str(ROOT / "loader"))
os.environ.setdefault("DATA_BUCKET", "test-bucket")
os.environ.setdefault("AWS_DEFAULT_REGION", "il-central-1")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "testing")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "testing")

import probe  # noqa: E402
import discover_companies  # noqa: E402
import merge_discovered_batch  # noqa: E402
import scrape_workday_handler as handler  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failures.append(name)


# A tenant with 45 postings: three pages, newest first, no descriptions
# on the list, a detail endpoint per job.
def posting(i):
    return {"title": f"Role {i}", "externalPath": f"/job/Tel-Aviv/Role-{i}_R{i:04d}", "locationsText": "Tel Aviv, Israel",
            "postedOn": "Posted 3 Days Ago", "bulletFields": [f"R{i:04d}"]}


class Resp:
    def __init__(self, status, body):
        self.status_code, self._body = status, body
        self.headers = {"Content-Type": "application/json"}
        self.text = json.dumps(body)
        self.content = self.text.encode()

    def json(self):
        return self._body


class Sess:
    """Answers the list endpoint from a fixed set of postings and counts
    every request, so the tests can say how many a poll cost."""

    def __init__(self, postings, total=None):
        self.postings, self.total = postings, total if total is not None else len(postings)
        self.calls, self.lock = [], threading.Lock()
        self.headers = {}

    def post(self, url, json=None, **kw):
        with self.lock:
            self.calls.append(("POST", url, json.get("offset"), json.get("appliedFacets")))
        off = json.get("offset", 0)
        page = self.postings[off:off + json.get("limit", 20)]
        body = {"total": self.total if off == 0 else 0, "jobPostings": page,
                "facets": [{"facetParameter": "Location_Country", "values": [
                    {"id": "il1", "descriptor": "Israel", "count": 7}, {"id": "us1", "descriptor": "United States", "count": 38}]}] if off == 0 else []}
        return Resp(200, body)

    def get(self, url, **kw):
        with self.lock:
            self.calls.append(("GET", url, None, None))
        return Resp(200, {"jobPostingInfo": {"jobDescription": "<p>Build things</p>", "location": "Tel Aviv, Israel"}})


postings = [posting(i) for i in range(45)]
sess = Sess(postings)
p1 = probe.workday_page1(sess, "acme", "wd1", "External")
check("page 1 carries the total, the newest twenty and the facet tree",
      p1 and p1["total"] == 45 and len(p1["postings"]) == 20 and p1["facets"][0]["facetParameter"] == "Location_Country")
check("the Israel count is read off the facets", probe.workday_israel_count(p1["facets"]) == 7)
check("Beth Israel is a hospital, not the country",
      probe.workday_israel_count([{"facetParameter": "x", "values": [{"id": "a", "descriptor": "Beth Israel Deaconess - Boston", "count": 900}, {"id": "b", "descriptor": "Tel Aviv, Israel", "count": 3}]}]) == 3
      and probe._find_israel_facets([{"facetParameter": "x", "values": [{"id": "a", "descriptor": "Beth Israel Lahey"}, {"id": "b", "descriptor": "Israel"}]}]) == {"x": ["b"]})
fp = probe.workday_fingerprint(p1)
check("the fingerprint is stable for the same board and moves with the newest posting",
      fp == probe.workday_fingerprint(probe.workday_page1(sess, "acme", "wd1", "External"))
      and fp != probe.workday_fingerprint({"total": 45, "postings": [posting(99)] + postings[1:20]})
      and fp != probe.workday_fingerprint({"total": 44, "postings": postings[:20]}))

sess = Sess(postings)
jobs = probe.f_workday(sess, "acme", "wd1", "External", known_external_ids=set())
offsets = [c[2] for c in sess.calls if c[0] == "POST"]
check("every posting comes back, and the pages after the first were asked for together off one total",
      len(jobs) == 45 and sorted(offsets) == [0, 20, 40] and all(j.ats == "workday" for j in jobs), repr(offsets))
check("the token, url and id are the tenant's own",
      jobs[0].token == "acme:wd1:External" and jobs[0].external_id == "R0000"
      and jobs[0].url == "https://acme.wd1.myworkdayjobs.com/External/job/Tel-Aviv/Role-0_R0000")

sess = Sess(postings)
jobs = probe.f_workday(sess, "acme", "wd1", "External", page1=p1, known_external_ids={f"R{i:04d}" for i in range(45)})
check("a page 1 already in hand is not fetched again, and known jobs skip the detail fetch",
      [c[2] for c in sess.calls if c[0] == "POST"] == [20, 40] and not [c for c in sess.calls if c[0] == "GET"], repr(sess.calls))

class FlakySess(Sess):
    """Page two always fails, the way a 429 or a timeout does."""

    def post(self, url, json=None, **kw):
        if json.get("offset") == 20:
            return Resp(500, {})
        return super().post(url, json=json, **kw)


sleep, probe.time.sleep = probe.time.sleep, lambda s: None
try:
    check("a page that still fails after retries fails the read, rather than closing its twenty jobs",
          probe.f_workday(FlakySess(postings), "acme", "wd1", "External", known_external_ids=set()) is None)
finally:
    probe.time.sleep = sleep

sess = Sess(postings)
jobs = probe.f_workday(sess, "acme", "wd1", "External", known_external_ids={"R0000", "R0001"}, describe_budget=10)
described = [j for j in jobs if j.description]
check("a description budget describes that many of the not-yet-described jobs and leaves the rest for next time",
      len(described) == 10 and len([c for c in sess.calls if c[0] == "GET"]) == 10
      and not any(j.external_id in ("R0000", "R0001") for j in described) and len(jobs) == 45, (len(described), len(sess.calls)))

sess = Sess(postings, total=45)
jobs = probe.f_workday(sess, "acme", "wd1", "External", israel_facets={"Location_Country": ["il1"]}, known_external_ids=set(), max_jobs=20)
il_calls = [c for c in sess.calls if c[0] == "POST" and c[3]]
check("past the cap, the Israel postings are fetched on their own and merged without duplicates",
      len(il_calls) >= 1 and il_calls[0][3] == {"Location_Country": ["il1"]} and len({j.external_id for j in jobs}) == len(jobs), repr(il_calls[:2]))

# Multi-city postings: the real names come from the detail page, with the
# description, and a failed fetch keeps the placeholder for the loader to
# ignore (load_to_sqlite keeps the stored location).
class DetailSess(Sess):
    def __init__(self, postings, detail):
        super().__init__(postings)
        self.detail = detail

    def get(self, url, **kw):
        with self.lock:
            self.calls.append(("GET", url, None, None))
        return self.detail(url)


multi = [dict(posting(i), locationsText=text, externalPath=f"/job/x/Role-{i}_R{i:04d}")
         for i, text in enumerate(["2 Locations", "3 Locations   |   Glass - Michigan"])]
ok = DetailSess(multi, lambda url: Resp(200, {"jobPostingInfo": {"location": "Haifa, Israel", "additionalLocations": ["Tel Aviv, Israel"],
                                                                 "jobDescription": "<p>Build</p>"}}))
jobs = probe.f_workday(ok, "acme", "wd1", "External", known_external_ids=set())
check("a new multi-city job gets its cities from the detail page, a suffix after the count included",
      [j.location for j in jobs] == ["Haifa, Israel, Tel Aviv, Israel"] * 2, repr([j.location for j in jobs]))
sleep, probe.time.sleep = probe.time.sleep, lambda s: None
try:
    jobs = probe.f_workday(DetailSess(multi, lambda url: Resp(429, {})), "acme", "wd1", "External", known_external_ids=set())
finally:
    probe.time.sleep = sleep
check("a failed detail fetch keeps the placeholder, and no description",
      [j.location for j in jobs] == ["2 Locations", "3 Locations   |   Glass - Michigan"] and not any(j.description for j in jobs),
      repr([j.location for j in jobs]))
known = DetailSess(multi, lambda url: Resp(200, {}))
probe.f_workday(known, "acme", "wd1", "External", known_external_ids={"R0000", "R0001"})
check("a multi-city job already described is not fetched again", not [c for c in known.calls if c[0] == "GET"], repr(known.calls))

today = [dict(posting(0), postedOn="Posted Today")]
before = probe.datetime.now(probe.timezone.utc)
jobs = probe.f_workday(Sess(today), "acme", "wd1", "External", known_external_ids=set())
check("'Posted Today' on a tenant read before is dated first sight, not midnight",
      jobs[0].posted_at and before <= probe.datetime.fromisoformat(jobs[0].posted_at) <= probe.datetime.now(probe.timezone.utc),
      repr(jobs[0].posted_at))
jobs = probe.f_workday(Sess(today), "acme", "wd1", "External")
check("'Posted Today' on a first read of a tenant stays unknown", jobs[0].posted_at is None, repr(jobs[0].posted_at))

# A job left at "3 Locations" by an earlier failed fetch is fetched again.
import sqlite3  # noqa: E402

state_dir = Path(tempfile.mkdtemp())


def fake_pull(bucket, key, path):
    c = sqlite3.connect(path)
    c.execute("CREATE TABLE jobs (company_domain, external_id, description_sha, location, closed_at, last_seen)")
    c.executemany("INSERT INTO jobs VALUES (?, ?, ?, ?, NULL, '2026-10-23T08:00:00+00:00')", [
        ("acme.com", "R1", "sha", "Haifa, Israel"), ("acme.com", "R2", "sha", "3 Locations"), ("acme.com", "R3", None, "Haifa, Israel")])
    c.commit()
    c.close()
    return True, None


handler.TMP, real_pull, handler.s3_pull = state_dir, handler.s3_pull, fake_pull
try:
    open_ids, described_ids, _ = handler._known_state_by_domain()
finally:
    handler.s3_pull = real_pull
check("a job still at '3 Locations' counts as undescribed, so its detail page is read again",
      open_ids["acme.com"] == {"R1", "R2", "R3"} and described_ids["acme.com"] == {"R1"}, repr(described_ids))

# The handler's poll: unchanged is one request, changed is the walk.
class FakeProbe:
    pass


# The version on each row below is what says "the jobs behind this
# fingerprint were delivered". Without it the board is walked whatever
# the fingerprint says, which is its own test in
# tests/test_workday_delivery_order.py.
CURRENT = handler.WORKDAY_STATE_VERSION
sess = Sess(postings)
r = handler._poll_workday(sess, {"domain": "acme.com", "tenant": "acme", "wd": "wd1", "site": "External"}, {"content_hash": fp, "version": CURRENT}, {"R0001"})
check("a board whose fingerprint matches is reported unchanged after one request",
      r.get("unchanged") is True and r["job_count"] == 1 and r["content_hash"] == fp and len(sess.calls) == 1, repr(r)[:200])
sess = Sess(postings)
r = handler._poll_workday(sess, {"domain": "acme.com", "tenant": "acme", "wd": "wd1", "site": "External"}, {"content_hash": fp, "version": CURRENT}, None)
check("with nothing known yet, a matching fingerprint still walks every page",
      not r.get("unchanged") and r["job_count"] == 45 and r["content_hash"] == fp, repr(r)[:200])
sess = Sess(postings)
r = handler._poll_workday(sess, {"domain": "acme.com", "tenant": "acme", "wd": "wd1", "site": "External"}, {"content_hash": "stale", "version": CURRENT}, {"R0001"})
check("a moved board is walked and its jobs come back", not r.get("unchanged") and len(r["jobs"]) == 45 and r["jobs"][0]["company_domain"] if "company_domain" in r["jobs"][0] else len(r["jobs"]) == 45)


class DeadSess(Sess):
    def post(self, url, json=None, **kw):
        return Resp(404, {"errorCode": "S21"})


r = handler._poll_workday(DeadSess(postings), {"domain": "gone.com", "tenant": "gone", "wd": "wd1", "site": "X"}, None, None)
check("a tenant that does not answer is a retryable miss, not an empty board", r["ats"] is None and r["retryable"] and r["jobs"] == [])

# Discovery: tenants and sites out of crawl URLs.
urls = ["https://3m.wd1.myworkdayjobs.com/en-US/Search/job/US-Alabama/Eng_R1", "https://3m.wd1.myworkdayjobs.com/Search",
        "https://greystar.wd1.myworkdayjobs.com/External/login", "https://greystar.wd1.myworkdayjobs.com/login",
        "https://Alterra.wd1.myworkdayjobs.com/en-US/Alterra_External/details/Cook_R1", "https://alterra.wd1.myworkdayjobs.com/Alterra_Internal",
        "https://www.myworkdayjobs.com/", "https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Ext/jobs"]
check("crawl URLs yield one tenant:wd:site per tenant, the busiest site, never a job path or login",
      sorted(discover_companies.extract_tokens("workday", urls)) == ["3m:wd1:Search", "alterra:wd1:Alterra_External", "greystar:wd1:External"],
      repr(sorted(discover_companies.extract_tokens("workday", urls))))

# Merge: discovered tenants land in workday-tenants.json, once.
tmp = Path(tempfile.mkdtemp()) / "workday-tenants.json"
merge_discovered_batch.TENANTS_PATH = tmp
n = merge_discovered_batch.add_workday_tenants([
    {"ats": "workday", "token": "3m:wd1:Search", "domain": "3m.com", "job_count": 677, "israel_job_count": 0},
    {"ats": "workday", "token": "acme:wd1:External", "domain": None, "job_count": 45, "israel_job_count": 7},
])
again = merge_discovered_batch.add_workday_tenants([{"ats": "workday", "token": "3M:wd1:search", "domain": "3m.com", "job_count": 1}])
saved = json.loads(tmp.read_text(encoding="utf-8"))
check("two new tenants written, a repeat ignored, a missing domain given the tenant's own host",
      n == 2 and again == 0 and [t["domain"] for t in saved] == ["3m.com", "acme.myworkdayjobs.com"]
      and saved[0] == {**saved[0], "tenant": "3m", "wd": "wd1", "site": "Search", "jobs_seen": 677, "source": "common-crawl"}, repr(saved))

# The handler reads pins and the discovered list as one, pins first.
handler.TENANTS_PATH = tmp
probe.PINS.setdefault("workday", {})["3m.com"] = {"tenant": "3m", "wd": "wd1", "site": "Search"}
entries = handler._workday_entries()
check("a discovered tenant that is also a pin appears once, as the pin",
      sum(1 for e in entries if e["tenant"].lower() == "3m") == 1 and any(e["domain"] == "acme.myworkdayjobs.com" for e in entries))

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
