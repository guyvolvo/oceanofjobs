"""Automatic applications (api/apply.py): the profile is bounded, credits
follow the plan, a claim holds its credit until a result, and skipped or
failed applications give it back.

Run directly, no framework:  python tests/test_apply.py
"""
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))

import apply  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failures.append(name)


class FakeTable:
    def __init__(self):
        self.items = {}

    @staticmethod
    def _terms(cond):
        expr = cond.get_expression()
        if expr["operator"] == "AND":
            return [t for c in expr["values"] for t in FakeTable._terms(c)]
        return [(expr["operator"], expr["values"][0].name, expr["values"][1])]

    def query(self, KeyConditionExpression=None):
        rows = list(self.items.values())
        for op, name, value in self._terms(KeyConditionExpression):
            rows = [r for r in rows if (r[name] == value if op == "=" else str(r[name]).startswith(value))]
        return {"Items": [dict(r) for r in rows]}

    def get_item(self, Key=None):
        item = self.items.get((Key["user_id"], Key["alert_id"]))
        return {"Item": dict(item)} if item else {}

    def put_item(self, Item=None, **kw):
        self.items[(Item["user_id"], Item["alert_id"])] = dict(Item)

    def update_item(self, Key=None, ExpressionAttributeValues=None, **kw):
        row = self.items[(Key["user_id"], Key["alert_id"])]
        row.update(status=ExpressionAttributeValues[":s"], reason=ExpressionAttributeValues[":r"], done_at=ExpressionAttributeValues[":t"])

    def delete_item(self, Key=None):
        self.items.pop((Key["user_id"], Key["alert_id"]), None)


NOW = datetime(2026, 10, 20, 12, 0, tzinfo=timezone.utc)
t = FakeTable()

empty = apply.get_profile(t, "u")
check("a new user has a neutral profile: queue mode, nothing guarded, no demographic answers",
      empty["settings"]["mode"] == "queue" and empty["settings"]["guardrails"]["daily_limit"] is None
      and all(v is None for v in empty["eeo"].values()))
check("a new user drafts unknown answers with AI and has agreed to no privacy boxes",
      empty["settings"]["unknowns"] == "ai" and empty["settings"]["consent"] is True)
check("Fill application is Half automatic until the user picks Full", empty["settings"]["fill"] == "half")
check("Full automatic is kept; anything else is Half automatic",
      apply.clean_profile({"settings": {"fill": "full"}})["settings"]["fill"] == "full"
      and all(apply.clean_profile({"settings": {"fill": v}})["settings"]["fill"] == "half" for v in ("auto", "FULL", None, 1, ["full"])))
both = apply.clean_profile({"settings": {"mode": "auto", "fill": "full"}})["settings"]
check("Fill application and Auto-apply mode are independent: both can be on", both["mode"] == "auto" and both["fill"] == "full")
check("required privacy boxes are always ticked, for extension 1.9.10",
      apply.clean_profile({"settings": {"consent": False}})["settings"]["consent"] is True)

saved = apply.put_profile(t, "u", {
    "contact": {"first_name": "  Guy ", "email": "g@example.com", "unknown": "x"},
    "work": {"authorized_countries": ["il", "US", "nope", "us"], "needs_sponsorship": "yes", "salary": "x" * 300},
    "eeo": {"gender": "decline", "race": ""},
    "answers": [{"question": "How did you hear about us?", "answer": "Because"}, {"question": "how did you  hear about us", "answer": "dupe"}, {"question": "", "answer": "x"}],
    "settings": {"mode": "auto", "sources": ["board", "spam"], "unknowns": "ai",
                 "guardrails": {"daily_limit": "10", "blocked_companies": ["Wix.com", "bad domain!"], "min_match": None}},
    "junk": 1,
})
check("text is trimmed and bounded, unknown keys dropped",
      saved["contact"]["first_name"] == "Guy" and "unknown" not in saved["contact"] and len(saved["work"]["salary"]) == 100 and "junk" not in saved)
check("countries are two-letter codes, deduplicated", saved["work"]["authorized_countries"] == ["IL", "US"], repr(saved["work"]["authorized_countries"]))
check("sponsorship is yes, no or unset, never a string", saved["work"]["needs_sponsorship"] is None)
check("an empty demographic answer stays unset; decline is kept", saved["eeo"] == {"gender": "decline", "race": None, "veteran": None, "disability": None})
check("answers to the same question in other words are kept once", [a["answer"] for a in saved["answers"]] == ["Because"], repr(saved["answers"]))
check("settings come from closed lists", saved["settings"]["mode"] == "auto" and saved["settings"]["sources"] == ["board"]
      and saved["settings"]["unknowns"] == "ai")
check("guardrails are numbers in range and real domains", saved["settings"]["guardrails"]["daily_limit"] == 10
      and saved["settings"]["guardrails"]["blocked_companies"] == ["wix.com"])
for bad in ({"settings": {"guardrails": {"daily_limit": 500}}}, {"settings": {"guardrails": {"min_match": "abc"}}}):
    try:
        apply.clean_profile(bad)
        check(f"out-of-range guardrail {bad} is refused", False)
    except ValueError:
        pass

apply.add_answer(t, "u", "How did you HEAR about us?!", "Better answer")
check("a saved answer replaces the old one to the same question",
      [a["answer"] for a in apply.get_profile(t, "u")["answers"]] == ["Better answer"])

u = apply.usage(t, "u", NOW)
check("free plan: 10 a month", u == {"plan": "free", "period": "month", "limit": 10, "used": 0, "remaining": 10}, repr(u))

jobs = [f"{i:016x}" for i in range(1, 32)]
r = apply.claim(t, "u", {"job_id": jobs[0], "company": "Acme", "title": "Engineer"}, NOW)
check("a claim takes one credit", r == {"remaining": 9})
try:
    apply.claim(t, "u", {"job_id": jobs[0]}, NOW)
    check("the same job cannot be claimed twice", False)
except apply.AlreadyApplied:
    check("the same job cannot be claimed twice", True)
apply.result(t, "u", {"job_id": jobs[0], "status": "skipped", "reason": "needs answer: Why us?"}, NOW)
check("a skipped job gives its credit back", apply.usage(t, "u", NOW)["remaining"] == 10)
check("and can be claimed again later", apply.claim(t, "u", {"job_id": jobs[0]}, NOW) == {"remaining": 9})
apply.result(t, "u", {"job_id": jobs[0], "status": "submitted"}, NOW)
for j in jobs[1:10]:
    apply.claim(t, "u", {"job_id": j}, NOW)
check("ten used", apply.usage(t, "u", NOW)["used"] == 10)
try:
    apply.claim(t, "u", {"job_id": jobs[10]}, NOW)
    check("the eleventh claim is refused on free", False)
except apply.LimitReached:
    check("the eleventh claim is refused on free", True)
later = NOW + timedelta(seconds=apply.CLAIM_HOLD_S + 1)
check("claims with no result free themselves after the hold", apply.usage(t, "u", later)["used"] == 1)
check("a new month starts empty", apply.usage(t, "u", datetime(2026, 11, 1, tzinfo=timezone.utc))["used"] == 0)

t.put_item(Item={"user_id": "u", "alert_id": apply.PLAN_ROW, "plan": "pro", "status": "active"})
check("pro counts per day, 50", apply.usage(t, "u", NOW)["limit"] == 50 and apply.usage(t, "u", NOW)["period"] == "day")
t.put_item(Item={"user_id": "u", "alert_id": apply.PLAN_ROW, "plan": "pro", "status": "canceled"})
check("a canceled plan is free again", apply.usage(t, "u", NOW)["plan"] == "free")
t.put_item(Item={"user_id": "u", "alert_id": apply.GRANT_ROW, "plan": "basic", "until": "2026-10-31"})
check("a license given in the CRM is in force", apply.plan_of(t, "u", NOW) == "basic")
check("a license ends after its last day", apply.plan_of(t, "u", datetime(2026, 11, 1, tzinfo=timezone.utc)) == "free")
t.put_item(Item={"user_id": "u", "alert_id": apply.PLAN_ROW, "plan": "pro", "status": "active"})
check("a paid plan above the license wins", apply.plan_of(t, "u", NOW) == "pro")
t.put_item(Item={"user_id": "u", "alert_id": apply.GRANT_ROW, "plan": "free", "until": ""})
t.put_item(Item={"user_id": "u", "alert_id": apply.PLAN_ROW, "plan": "pro", "status": "canceled"})
check("a removed license is free again", apply.plan_of(t, "u", NOW) == "free")

for bad in ({"job_id": "../x"}, {"job_id": jobs[0], "status": "won"}):
    try:
        apply.result(t, "u", bad, NOW)
        check(f"result {bad} is refused", False)
    except ValueError:
        pass
try:
    apply.result(t, "u", {"job_id": "ffffffffffffffff", "status": "submitted"}, NOW)
    check("a result for a job never claimed is refused", False)
except ValueError:
    check("a result for a job never claimed is refused", True)

h = apply.history(t, "u")
check("history lists every claimed job, newest first, with its status",
      len(h) == 10 and {"job_id", "status", "company", "at"} <= set(h[0]), repr(h[:1]))

apply.enqueue(t, "u", jobs[5], NOW)
apply.enqueue(t, "u", jobs[2], NOW + timedelta(minutes=1))
check("the queue keeps the order jobs were approved in", [q["job_id"] for q in apply.queue(t, "u")] == [jobs[5], jobs[2]])
apply.dequeue(t, "u", jobs[5])
check("and removes them", [q["job_id"] for q in apply.queue(t, "u")] == [jobs[2]])


# Regression, bug 1 (2026-10-21): a submitted application is final. A
# re-queued job that screens as already applied must not be turned into a
# skip, refunded, or claimed again, under its own id or another one.
t2 = FakeTable()
gh = "https://job-boards.greenhouse.io/embed/job_app?for=celonis&token=8015242003"
apply.claim(t2, "u", {"job_id": "aaaaaaaaaaaaaaaa", "url": gh, "company": "celonis.com", "title": "Engineer"}, NOW)
apply.result(t2, "u", {"job_id": "aaaaaaaaaaaaaaaa", "status": "submitted"}, NOW)
used = apply.usage(t2, "u", NOW)["used"]
apply.result(t2, "u", {"job_id": "aaaaaaaaaaaaaaaa", "status": "skipped", "reason": "You've already applied to this job."}, NOW)
row = t2.items[("u", apply.APPLIED + "aaaaaaaaaaaaaaaa")]
check("a skip reported for a submitted job leaves it submitted", row["status"] == "submitted" and row["reason"] == "", repr(row))
check("and refunds nothing", apply.usage(t2, "u", NOW)["used"] == used)
apply.result(t2, "u", {"job_id": "aaaaaaaaaaaaaaaa", "status": "failed", "reason": "no confirmation"}, NOW)
check("nor can a failure overwrite it", t2.items[("u", apply.APPLIED + "aaaaaaaaaaaaaaaa")]["status"] == "submitted")
try:
    apply.claim(t2, "u", {"job_id": "aaaaaaaaaaaaaaaa", "url": gh}, NOW + timedelta(days=40))
    check("a submitted job cannot be claimed again, even months later", False)
except apply.AlreadyApplied:
    check("a submitted job cannot be claimed again, even months later", True)
try:
    apply.claim(t2, "u", {"job_id": "bbbbbbbbbbbbbbbb", "url": "https://careers.celonis.com/open-roles?gh_jid=8015242003"}, NOW)
    check("nor under another id, from the company's own careers page", False)
except apply.AlreadyApplied:
    check("nor under another id, from the company's own careers page", True)
check("the queue guard sees it by id", apply.submitted_already(t2, "u", "aaaaaaaaaaaaaaaa"))
check("and by the job itself", apply.submitted_already(t2, "u", "cccccccccccccccc", "https://boards.greenhouse.io/celonis/jobs/8015242003"))
check("but not another job", not apply.submitted_already(t2, "u", "cccccccccccccccc", "https://boards.greenhouse.io/celonis/jobs/9999"))
legacy = FakeTable()
legacy.put_item(Item={"user_id": "u", "alert_id": apply.APPLIED + "dddddddddddddddd", "job_id": "dddddddddddddddd",
                      "url": "https://jobs.lever.co/shieldai/96d0e0da-6c0a-4918-af24-6e1d3e499808", "status": "submitted", "at": NOW.isoformat()})
try:
    apply.claim(legacy, "u", {"job_id": "eeeeeeeeeeeeeeee", "url": "https://jobs.lever.co/shieldai/96d0e0da-6c0a-4918-af24-6e1d3e499808/apply"}, NOW)
    check("rows written before canonical ids still match by their url", False)
except apply.AlreadyApplied:
    check("rows written before canonical ids still match by their url", True)

# Regression, bug 2: a job skipped before any claim (a question the profile
# can't answer) is recorded at no cost, so the next run sees it as tried.
t3 = FakeTable()
apply.result(t3, "u", {"job_id": "ffffffffffffffff", "status": "skipped", "reason": "needs answer: Why us?"}, NOW)
row = t3.items.get(("u", apply.APPLIED + "ffffffffffffffff"))
check("a skip with no claim is kept as a record", row and row["status"] == "skipped" and row["reason"] == "needs answer: Why us?", repr(row))
check("and costs nothing", apply.usage(t3, "u", NOW)["used"] == 0)
check("the job can still be claimed once the question is answered", apply.claim(t3, "u", {"job_id": "ffffffffffffffff"}, NOW) == {"remaining": 9})

for url, want in [(gh, "greenhouse:8015242003"), ("https://boards.greenhouse.io/celonis/jobs/8015242003", "greenhouse:8015242003"),
                  ("https://jobs.ashbyhq.com/synthesia/ce402b96-d2c2-4651-bb20-2b8cf6166acc/application", "ashby:ce402b96-d2c2-4651-bb20-2b8cf6166acc"),
                  ("https://apply.workable.com/j/969FF41C4F", "workable:969ff41c4f"), ("https://apply.workable.com/acme/j/969FF41C4F/apply", "workable:969ff41c4f"),
                  ("https://www.Example.com/Careers/Job-1/?utm=x", "example.com/careers/job-1"), ("", "")]:
    check(f"canonical {want or 'nothing'}", apply.canonical_job(url) == want, apply.canonical_job(url))

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
