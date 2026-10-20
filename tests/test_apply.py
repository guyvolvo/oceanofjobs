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

saved = apply.put_profile(t, "u", {
    "contact": {"first_name": "  Guy ", "email": "g@example.com", "unknown": "x"},
    "work": {"authorized_countries": ["il", "US", "nope", "us"], "needs_sponsorship": "yes", "salary": "x" * 300},
    "eeo": {"gender": "decline", "race": ""},
    "answers": [{"question": "Why us?", "answer": "Because"}, {"question": "why  us", "answer": "dupe"}, {"question": "", "answer": "x"}],
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

apply.add_answer(t, "u", "Why US?!", "Better answer")
check("a saved answer replaces the old one to the same question",
      [a["answer"] for a in apply.get_profile(t, "u")["answers"]] == ["Better answer"])

u = apply.usage(t, "u", NOW)
check("free plan: 30 a month", u == {"plan": "free", "period": "month", "limit": 30, "used": 0, "remaining": 30}, repr(u))

jobs = [f"{i:016x}" for i in range(1, 32)]
r = apply.claim(t, "u", {"job_id": jobs[0], "company": "Acme", "title": "Engineer"}, NOW)
check("a claim takes one credit", r == {"remaining": 29})
try:
    apply.claim(t, "u", {"job_id": jobs[0]}, NOW)
    check("the same job cannot be claimed twice", False)
except apply.AlreadyApplied:
    check("the same job cannot be claimed twice", True)
apply.result(t, "u", {"job_id": jobs[0], "status": "skipped", "reason": "needs answer: Why us?"}, NOW)
check("a skipped job gives its credit back", apply.usage(t, "u", NOW)["remaining"] == 30)
check("and can be claimed again later", apply.claim(t, "u", {"job_id": jobs[0]}, NOW) == {"remaining": 29})
apply.result(t, "u", {"job_id": jobs[0], "status": "submitted"}, NOW)
for j in jobs[1:30]:
    apply.claim(t, "u", {"job_id": j}, NOW)
check("thirty used", apply.usage(t, "u", NOW)["used"] == 30)
try:
    apply.claim(t, "u", {"job_id": jobs[30]}, NOW)
    check("the thirty-first claim is refused on free", False)
except apply.LimitReached:
    check("the thirty-first claim is refused on free", True)
later = NOW + timedelta(seconds=apply.CLAIM_HOLD_S + 1)
check("claims with no result free themselves after the hold", apply.usage(t, "u", later)["used"] == 1)
check("a new month starts empty", apply.usage(t, "u", datetime(2026, 11, 1, tzinfo=timezone.utc))["used"] == 0)

t.put_item(Item={"user_id": "u", "alert_id": apply.PLAN_ROW, "plan": "pro", "status": "active"})
check("pro counts per day, 50", apply.usage(t, "u", NOW)["limit"] == 50 and apply.usage(t, "u", NOW)["period"] == "day")
t.put_item(Item={"user_id": "u", "alert_id": apply.PLAN_ROW, "plan": "pro", "status": "canceled"})
check("a canceled plan is free again", apply.usage(t, "u", NOW)["plan"] == "free")

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
      len(h) == 30 and {"job_id", "status", "company", "at"} <= set(h[0]), repr(h[:1]))

apply.enqueue(t, "u", jobs[5], NOW)
apply.enqueue(t, "u", jobs[2], NOW + timedelta(minutes=1))
check("the queue keeps the order jobs were approved in", [q["job_id"] for q in apply.queue(t, "u")] == [jobs[5], jobs[2]])
apply.dequeue(t, "u", jobs[5])
check("and removes them", [q["job_id"] for q in apply.queue(t, "u")] == [jobs[2]])

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
