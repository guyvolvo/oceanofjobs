"""box/describe_backfill.py without the network: where each ATS's text
comes from, how a page's markup is read, and which answers end a
listing's turn for good versus get retried.

Run directly, no framework:  python tests/test_describe_backfill.py
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "box"))

import describe_backfill as d  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failures.append(name)


LONG = "<p>" + "Build and run the payments platform. " * 10 + "</p>"


def page(data):
    return f'<html><script type="application/ld+json">{json.dumps(data)}</script></html>'


check("SmartRecruiters reads its posting API",
      d.source("smartrecruiters", "https://jobs.smartrecruiters.com/Acme1/744000", "744000")
      == ("https://api.smartrecruiters.com/v1/companies/Acme1/postings/744000", "smartrecruiters"))
check("BambooHR reads the detail endpoint",
      d.source("bamboohr", "https://acme.bamboohr.com/careers/213", "213") == ("https://acme.bamboohr.com/careers/213/detail", "bamboohr"))
check("the others read the job page", d.source("breezy", "https://acme.breezy.hr/p/1-x", "1") == ("https://acme.breezy.hr/p/1-x", "page"))

check("a JobPosting block is read", "payments platform" in (d.ld_description(page({"@type": "JobPosting", "description": LONG})) or ""))
check("a list of blocks is read", "payments platform" in (d.ld_description(page([{"@type": "Organization"}, {"@type": "JobPosting", "description": LONG}])) or ""))
check("an @graph is read", "payments platform" in (d.ld_description(page({"@graph": [{"@type": "JobPosting", "description": LONG}]})) or ""))
check("broken JSON and other types are skipped",
      d.ld_description('<script type="application/ld+json">{oops</script>' + page({"@type": "Organization", "description": LONG})) is None)

check("BambooHR's JSON gives plain text",
      "payments platform" in d.parse("bamboohr", json.dumps({"result": {"jobOpening": {"description": LONG}}})) and "<p>" not in d.parse("bamboohr", json.dumps({"result": {"jobOpening": {"description": LONG}}})))
sr = {"jobAd": {"sections": {"companyDescription": {"text": "<p>About Acme.</p>"}, "jobDescription": {"text": LONG}}}}
check("SmartRecruiters' sections are joined", "About Acme." in d.parse("smartrecruiters", json.dumps(sr)) and "payments" in d.parse("smartrecruiters", json.dumps(sr)))


class Resp:
    def __init__(self, status, text=""):
        self.status_code, self.text = status, text

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(self.status_code)


class Sess:
    def __init__(self, resp):
        self.resp = resp

    def get(self, *a, **k):
        return self.resp


row = ("id1", "breezy", "https://acme.breezy.hr/p/1-x", "1")


def outcome(resp):
    try:
        return d.fetch(Sess(resp), row)
    except d.Gone:
        return "gone"
    except Exception:  # noqa: BLE001
        return "retry"


check("a described page is written", outcome(Resp(200, page({"@type": "JobPosting", "description": LONG})))[0] == "id1")
check("404 is gone for good", outcome(Resp(404)) == "gone")
check("410 is gone for good", outcome(Resp(410)) == "gone")
check("a page with no text is not asked again", outcome(Resp(200, "<html>nothing</html>")) == "gone")
check("a title-length text is not asked again", outcome(Resp(200, page({"@type": "JobPosting", "description": "Short."}))) == "gone")
check("429 is retried", outcome(Resp(429)) == "retry")
check("500 is retried", outcome(Resp(500)) == "retry")

print()
if failures:
    print("%d failed" % len(failures))
    sys.exit(1)
print("all passed")
