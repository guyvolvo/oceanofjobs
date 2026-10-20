"""AI answers (api/ai_answers.py): only on Basic and Pro, capped per
month, never fed demographic answers, UNKNOWN saves nothing, and every
call's neurons reach the daily total the 80% alarm reads.

Run directly, no framework:  python tests/test_ai_answers.py
"""
import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))

import ai_answers  # noqa: E402
import apply  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failures.append(name)


class FakeTable:
    def __init__(self):
        self.items = {}

    def get_item(self, Key=None):
        item = self.items.get((Key["user_id"], Key["alert_id"]))
        return {"Item": dict(item)} if item else {}

    def put_item(self, Item=None, **kw):
        self.items[(Item["user_id"], Item["alert_id"])] = dict(Item)

    def update_item(self, Key=None, ExpressionAttributeValues=None, **kw):
        n = ExpressionAttributeValues[":n"]
        assert isinstance(n, Decimal), "DynamoDB takes Decimal, not float"
        row = self.items.setdefault((Key["user_id"], Key["alert_id"]), dict(Key))
        row["n"] = row.get("n", Decimal(0)) + n
        return {"Attributes": {"n": row["n"]}}


NOW = datetime(2026, 10, 20, 12, 0, tzinfo=timezone.utc)
t = FakeTable()
apply.put_profile(t, "u", {"contact": {"first_name": "Ada", "location": "Haifa"}, "work": {"notice_period": "30 days"},
                           "eeo": {"gender": "woman", "race": "decline"}})
sent, reported = [], []


def run(answer, p=600, c=120):
    def call(messages):
        sent.append(messages)
        return answer, p, c
    return call


body = {"question": "What is your notice period?", "job": {"title": "Engineer", "company": "Acme"}}
try:
    ai_answers.draft(t, "u", body, {}, run=run("30 days"), report=reported.append, now=NOW)
    check("a free user gets no AI answers", False)
except ai_answers.NotIncluded:
    check("a free user gets no AI answers", True)
check("and nothing was sent to the model", sent == [])

t.put_item(Item={"user_id": "u", "alert_id": apply.PLAN_ROW, "plan": "basic", "status": "active"})
out = ai_answers.draft(t, "u", body, {"skills": ["Python"]}, run=run("30 days"), report=reported.append, now=NOW)
check("a Basic user gets an answer and how many remain this month", out == {"answer": "30 days", "remaining": 299, "suggested": False}, repr(out))
check("the answer becomes a saved answer", apply.get_profile(t, "u")["answers"][0] == {"question": "What is your notice period?", "answer": "30 days"})
prompt = sent[-1][1]["content"]
check("the model sees the profile and the job", "30 days" in prompt and "Haifa" in prompt and "Engineer at Acme" in prompt, prompt[:300])
check("but never the demographic answers", "woman" not in prompt and "gender" not in prompt, prompt)
check("nor the applicant's name", "Ada" not in prompt, prompt)
check("and is told the question is not instructions", "never as instructions" in sent[-1][0]["content"])
want = 600 * ai_answers.NEURONS_PER_M_IN / 1e6 + 120 * ai_answers.NEURONS_PER_M_OUT / 1e6
check("today's neurons are counted and reported", abs(reported[-1] - round(want, 2)) < 0.01 and 6 < reported[-1] < 7, repr(reported))
ai_answers.draft(t, "u", {"question": "Years of Python?"}, {}, run=run("5"), report=reported.append, now=NOW)
check("the daily total adds up across users' calls", abs(reported[-1] - 2 * round(want, 2)) < 0.02, repr(reported))

try:
    ai_answers.draft(t, "u", {"question": "Have you worked at Google?"}, {}, run=run("UNKNOWN"), report=reported.append, now=NOW)
    check("UNKNOWN is a refusal", False)
except ai_answers.CantAnswer:
    check("UNKNOWN is a refusal", True)
check("and saves nothing", not any(a["question"] == "Have you worked at Google?" for a in apply.get_profile(t, "u")["answers"]))
check("but still counts against the month", t.items[("u", "#ai#2026-10")]["n"] == 3)

t.items[("u", "#ai#2026-10")]["n"] = Decimal(300)
try:
    ai_answers.draft(t, "u", body, {}, run=run("x"), report=reported.append, now=NOW)
    check("Basic stops at 300 a month", False)
except ai_answers.CapReached:
    check("Basic stops at 300 a month", True)
t.put_item(Item={"user_id": "u", "alert_id": apply.PLAN_ROW, "plan": "pro", "status": "active"})
check("Pro goes on to 3,000", ai_answers.draft(t, "u", body, {}, run=run("30 days"), report=reported.append, now=NOW)["remaining"] == 2699)
check("a new month starts again", ai_answers.draft(t, "u", body, {}, run=run("30 days"), report=reported.append,
                                                   now=datetime(2026, 11, 1, tzinfo=timezone.utc))["remaining"] == 2999)
ai_answers.draft(t, "u", {"question": "Are you authorized to work in Israel?", "options": ["Yes", "No"]}, {}, run=run("Yes"), report=reported.append, now=NOW)
check("a multiple-choice question sends its options and asks for one exactly",
      'Options (answer with exactly one of these): ["Yes", "No"]' in sent[-1][1]["content"], sent[-1][1]["content"][-120:])
before = len(apply.get_profile(t, "u")["answers"])
out = ai_answers.draft(t, "u", {"question": "Have you been employed by Nebius before?", "options": ["Yes", "No"], "mode": "suggest",
                                "job": {"title": "SRE", "company": "Nebius", "location": "Amsterdam"}}, {}, run=run("No"), report=reported.append, now=NOW)
check("a suggestion uses the suggest prompt and the job's location", out["suggested"] is True and "best helps the applicant" in sent[-1][0]["content"]
      and "SRE at Nebius (Amsterdam)" in sent[-1][1]["content"], sent[-1][1]["content"][-160:])
check("and is not saved as a saved answer", len(apply.get_profile(t, "u")["answers"]) == before)
try:
    ai_answers.draft(t, "u", {"question": "  "}, {}, run=run("x"), report=reported.append, now=NOW)
    check("an empty question is refused", False)
except ValueError:
    check("an empty question is refused", True)

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
