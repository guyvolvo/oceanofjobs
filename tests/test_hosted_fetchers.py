"""f_jobvite, f_hibob, f_gem and f_deel, on records cut down from what
each board served on 2026-10-13.

Run directly, no framework:  python tests/test_hosted_fetchers.py
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "api"))

import probe  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + str(detail)))
    if not ok:
        failures.append(name)


class Resp:
    def __init__(self, status=200, text="", body=None):
        self.status_code = status
        self.text = json.dumps(body) if body is not None else text
        self.headers = {"Content-Type": "application/json"} if body is not None else {}

    def json(self):
        return json.loads(self.text)


class Sess:
    def __init__(self, gets):
        self.gets_map, self.calls = gets, []
        self.headers = {}

    def get(self, url, **kw):
        self.calls.append((url, kw.get("headers") or {}))
        return self.gets_map.get(url, Resp(404))


for ats in ("jobvite", "hibob", "gem", "deel"):
    for bad in ["varonis", "bigpanda", "", None]:
        sess = Sess({})
        check(f"{ats}: a guessed token {bad!r} makes no request", probe.FETCHERS[ats](sess, bad) is None and not sess.calls)

JV = """<a href="/varonis/job/o5zVAfwT?nl=1"> <div class="job-item"> <div class="jv-job-list-name"> Detection &amp; Response Engineer </div>
<div class="ml-auto jv-job-list-location"> <span>General and Administration</span> <span> Israel </span> </div> </div> </a>
<a href="/varonis/job/aB1?nl=1"><div class="jv-job-list-name">Sales</div><div class="jv-job-list-location">New York</div></a>
<a href="/other/job/zz">not ours</a>"""
jobs = probe.f_jobvite(Sess({"https://jobs.jobvite.com/varonis/jobs": Resp(text=JV)}), "jobs.jobvite.com/varonis")
check("jobvite: each role link with its name, place and department",
      [(j.external_id, j.title, j.location, j.department) for j in jobs or []] ==
      [("o5zVAfwT", "Detection & Response Engineer", "Israel", "General and Administration"), ("aB1", "Sales", "New York", None)], jobs)

HB = {"jobAdDetails": [{"id": "68", "title": "Compliance Officer", "department": "G&A", "site": "NY", "country": "United States",
                        "description": "<p>About</p>", "requirements": "<ul><li>7+ years</li></ul>", "publishedAt": "2026-09-25T15:37:26Z",
                        "workspaceTypeId": "hybrid"}]}
sess = Sess({"https://fundbox.careers.hibob.com/api/job-ad": Resp(body=HB)})
jobs = probe.f_hibob(sess, "fundbox.careers.hibob.com")
check("hibob: the company goes in the header", sess.calls and sess.calls[0][1].get("companyidentifier") == "fundbox", sess.calls)
check("hibob: place, workplace and link",
      jobs and (jobs[0].location, jobs[0].workplace_type, jobs[0].url) == ("NY, United States", "hybrid", "https://fundbox.careers.hibob.com/jobs/68"), jobs)

GEM = [{"id": "g1", "title": "AE", "absolute_url": "https://jobs.gem.com/bigpanda/g1", "location": {"name": ""},
        "offices": [{"name": "Tel Aviv"}], "departments": [{"name": "Sales"}], "first_published_at": "2026-05-21T17:38:46Z",
        "location_type": "remote", "content": "<p>x</p>"}]
jobs = probe.f_gem(Sess({"https://api.gem.com/job_board/v0/bigpanda/job_posts/": Resp(body=GEM)}), "jobs.gem.com/bigpanda")
check("gem: a blank location falls back to the office", jobs and (jobs[0].location, jobs[0].department, jobs[0].workplace_type) == ("Tel Aviv", "Sales", "remote"), jobs)

rec = {"id": 0, "attributes": {"ashby_id": "a1", "title": "Country Finance Manager", "team_name": "Finance", "is_listed": True,
                               "ashby_published_date": "2026-09-07T08:11:40Z", "external_link": "https://jobs.deel.com/deel/job-details/a1/application",
                               "all_locations": ["South Africa", "Kenya"]}}
hidden = {"id": 1, "attributes": {"ashby_id": "a2", "title": "Hidden", "is_listed": False}}
page = "self.__next_f.push([1," + json.dumps(json.dumps([rec, hidden], separators=(",", ":")))[1:-1] + "])"
jobs = probe.f_deel(Sess({"https://www.deel.com/careers": Resp(text=page)}), "www.deel.com/careers")
check("deel: listed records only, with places and the apply link",
      [(j.external_id, j.location, j.url) for j in jobs or []] == [("a1", "South Africa, Kenya", "https://jobs.deel.com/deel/job-details/a1/application")], jobs)

print()
if failures:
    print(f"{len(failures)} failed")
    sys.exit(1)
print("all passed")
