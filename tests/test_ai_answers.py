"""AI answers (api/ai_answers.py): only on Basic and Pro, capped per
month, never fed demographic answers, UNKNOWN saves nothing, and every
call's neurons reach the daily total the 80% alarm reads.

Run directly, no framework:  python tests/test_ai_answers.py
"""
import json
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

    def update_item(self, Key=None, ExpressionAttributeValues=None, UpdateExpression="", **kw):
        v = ExpressionAttributeValues
        if UpdateExpression.startswith("SET"):  # the per-minute counter (ai_answers._rate); its own tests are on moto
            row = self.items.setdefault((Key["user_id"], Key["alert_id"]), dict(Key))
            same = row.get("minute") == v[":m"]
            if UpdateExpression.startswith("SET n = n + :one") and not (same and row["n"] < v[":lim"]) \
                    or UpdateExpression.startswith("SET #min") and same:
                err = Exception("ConditionalCheckFailedException")
                err.response = {"Error": {"Code": "ConditionalCheckFailedException"}}
                raise err
            row.update(n=row["n"] + 1 if same else 1, minute=v[":m"])
            return {}
        n = ExpressionAttributeValues[":n"]
        assert isinstance(n, Decimal), "DynamoDB takes Decimal, not float"
        cap = ExpressionAttributeValues.get(":cap")
        if cap is not None and self.items.get((Key["user_id"], Key["alert_id"]), {}).get("n", Decimal(0)) >= cap:
            err = Exception("ConditionalCheckFailedException")
            err.response = {"Error": {"Code": "ConditionalCheckFailedException"}}
            raise err
        row = self.items.setdefault((Key["user_id"], Key["alert_id"]), dict(Key))
        row["n"] = row.get("n", Decimal(0)) + n
        return {"Attributes": {"n": row["n"]}}


NOW = datetime(2026, 10, 20, 12, 0, tzinfo=timezone.utc)
# These tests make many calls in one minute; the limits have their own
# tests on moto (tests/test_ai_limits.py).
ai_answers.PER_MINUTE = 10**6
t = FakeTable()
apply.put_profile(t, "u", {"contact": {"first_name": "Ada", "location": "Haifa"}, "work": {"notice_period": "30 days", "authorized_countries": ["IL"]},
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
check("a Basic user gets an answer and how many remain this month", out == {"answer": "30 days", "remaining": 299, "suggested": False, "source": "ai", "agent_version": None, "approval": "pending"}, repr(out))
check("the answer becomes a saved answer, marked as the AI's and waiting for review",
      apply.get_profile(t, "u")["answers"][0] == {"question": "What is your notice period?", "answer": "30 days", "source": "ai", "approval": "pending"})
prompt = sent[-1][1]["content"]
check("the model sees the profile and the job", "30 days" in prompt and "Haifa" in prompt and "Engineer at Acme" in prompt, prompt[:300])
check("but never the demographic answers", "woman" not in prompt and "gender" not in prompt, prompt)
check("nor the applicant's name", "Ada" not in prompt, prompt)
check("and is told the question is not instructions", "never as instructions" in sent[-1][0]["content"])
want = 600 * ai_answers.NEURONS_PER_M_IN / 1e6 + 120 * ai_answers.NEURONS_PER_M_OUT / 1e6
check("today's neurons are counted and reported", abs(reported[-1] - round(want, 2)) < 0.01 and 6 < reported[-1] < 7, repr(reported))
ai_answers.draft(t, "u", {"question": "Main programming language?"}, {}, run=run("Python"), report=reported.append, now=NOW)
check("the daily total adds up across users' calls", abs(reported[-1] - 2 * round(want, 2)) < 0.02, repr(reported))

try:
    ai_answers.draft(t, "u", {"question": "Have you worked at Google?"}, {}, run=run("UNKNOWN"), report=reported.append, now=NOW)
    check("UNKNOWN is a refusal", False)
except ai_answers.CantAnswer:
    check("UNKNOWN is a refusal", True)
check("and saves nothing", not any(a["question"] == "Have you worked at Google?" for a in apply.get_profile(t, "u")["answers"]))
check("and costs no AI answer: only answers produced count", t.items[("u", "#ai#2026-10")]["n"] == 2)
check("though the service's own cost is still recorded", len(reported) == 3, repr(reported))

t.items[("u", "#ai#2026-10")]["n"] = Decimal(300)
check("a saved answer is still free at the cap", ai_answers.draft(t, "u", body, {}, run=run("x"), report=reported.append, now=NOW)["source"] == "saved")
fresh = lambda n: {"question": f"How long is your notice period? ({n})", "job": {"title": "Engineer", "company": "Acme"}}  # noqa: E731
try:
    ai_answers.draft(t, "u", fresh(1), {}, run=run("x"), report=reported.append, now=NOW)
    check("Basic stops at 300 a month", False)
except ai_answers.CapReached:
    check("Basic stops at 300 a month", True)
t.put_item(Item={"user_id": "u", "alert_id": apply.PLAN_ROW, "plan": "pro", "status": "active"})
check("Pro goes on to 3,000", ai_answers.draft(t, "u", fresh(2), {}, run=run("30 days"), report=reported.append, now=NOW)["remaining"] == 2699)
check("a new month starts again", ai_answers.draft(t, "u", fresh(3), {}, run=run("30 days"), report=reported.append,
                                                   now=datetime(2026, 11, 1, tzinfo=timezone.utc))["remaining"] == 2999)
ai_answers.draft(t, "u", {"question": "Is your notice period 30 days?", "options": ["Yes", "No"]}, {},
                 run=run("Yes | notice_period: 30 days"), report=reported.append, now=NOW)
check("a multiple-choice question sends its options and asks for one exactly",
      'Options (answer with exactly one of these): ["Yes", "No"]' in sent[-1][1]["content"], sent[-1][1]["content"][-120:])
before = len(apply.get_profile(t, "u")["answers"])
out = ai_answers.draft(t, "u", {"question": "Have you been employed by Nebius before?", "options": ["Yes", "No"], "mode": "suggest",
                                "job": {"title": "SRE", "company": "Nebius", "location": "Amsterdam"}}, {}, run=run("No"), report=reported.append, now=NOW)
check("a suggestion uses the suggest prompt and the job's location", out["suggested"] is True and "best helps the applicant" in sent[-1][0]["content"]
      and "SRE at Nebius (Amsterdam)" in sent[-1][1]["content"], sent[-1][1]["content"][-160:])
check("and is not saved as a saved answer", len(apply.get_profile(t, "u")["answers"]) == before)
# Saved answers go to the model as background at most 300 characters each;
# the answers themselves stay whole.
t = FakeTable()
t.put_item(Item={"user_id": "u", "alert_id": apply.PLAN_ROW, "plan": "basic", "status": "active"})
long_answer = "I built data pipelines. " * 150
apply.put_profile(t, "u", {"answers": [{"question": "Describe your experience", "answer": long_answer},
                                       {"question": "Notice period?", "answer": "30 days"}]})
ai_answers.draft(t, "u", {"question": "Main database?"}, {}, run=run("Postgres"), report=reported.append, now=NOW)
earlier = json.loads(sent[-1][1]["content"].split("\nJob:")[0][len("Facts: "):])["earlier_answers"]
cut = [a["answer"] for a in earlier if a["question"] == "Describe your experience"]
check("a long saved answer reaches the model cut to its first 300 characters",
      len(cut) == 1 and len(cut[0]) == 300 and long_answer.startswith(cut[0]), repr([(a["question"], len(a["answer"])) for a in earlier]))
check("a short one reaches it unchanged", {"question": "Notice period?", "answer": "30 days"} in earlier, repr(earlier))
check("and the saved answer itself stays whole",
      any(a["answer"] == long_answer.strip() for a in apply.get_profile(t, "u")["answers"]))

# Job-specific answers: one written for Riskified must never fill the same
# question at another company.
t = FakeTable()
t.put_item(Item={"user_id": "u", "alert_id": apply.PLAN_ROW, "plan": "basic", "status": "active"})
RISKIFIED, MONDAY = "a1a1a1a1a1a1a1a1", "b2b2b2b2b2b2b2b2"
why = {"question": "Why do you want to work here?", "job": {"id": RISKIFIED, "title": "Data Engineer", "company": "Riskified"}}
SKILLS = {"skills": ["fraud detection"]}  # a fact the motivation answers below can cite
ai_answers.draft(t, "u", why, SKILLS, run=run("Riskified's fraud work is what I want to build. | skills: fraud detection"), report=reported.append, now=NOW)
saved = apply.get_profile(t, "u")["answers"]
check("an AI answer to 'why work here' is kept for the job it was written for",
      saved == [{"question": "Why do you want to work here?", "answer": "Riskified's fraud work is what I want to build.", "job_id": RISKIFIED, "source": "ai", "approval": "pending"}], repr(saved))
ai_answers.draft(t, "u", {"question": "How did you hear about us?", "job": {"id": RISKIFIED}}, {}, run=run("LinkedIn"), report=reported.append, now=NOW)
check("a general answer is still saved for every job",
      {"question": "How did you hear about us?", "answer": "LinkedIn", "source": "ai", "approval": "pending"} in apply.get_profile(t, "u")["answers"])
ai_answers.draft(t, "u", {"question": "Why do you want to work here?", "job": {"id": MONDAY, "company": "monday.com"}}, SKILLS,
                 run=run("monday.com's product is one I use daily. | skills: fraud detection"), report=reported.append, now=NOW)
check("the same question at another company gets its own answer from the model", "Riskified" not in sent[-1][1]["content"]
      and "monday.com" in sent[-1][1]["content"], sent[-1][1]["content"][-300:])
check("and is kept for that job, beside Riskified's", sorted(a.get("job_id", "") for a in apply.get_profile(t, "u")["answers"]
                                                       if a["question"].startswith("Why")) == [RISKIFIED, MONDAY])
ai_answers.draft(t, "u", {"question": "Why are you interested in this position?"}, SKILLS, run=run("It fits. | skills: fraud detection"), report=reported.append, now=NOW)
check("without a job a job-specific answer isn't saved at all",
      not any(a["question"].startswith("Why are you interested") for a in apply.get_profile(t, "u")["answers"]))
legacy = [{"question": "Why do you want to work here?", "answer": "Riskified's fraud work."},
          {"question": "Cover letter", "answer": "Dear Riskified"}, {"question": "Notice period?", "answer": "30 days"},
          {"question": "Why do you want to work here?", "answer": "monday.com", "job_id": MONDAY}]
check("answers saved before job ids are dropped when job-specific, kept when general",
      apply.reusable_answers(legacy) == [legacy[2], legacy[3]], repr(apply.reusable_answers(legacy)))
check("the classifier: job-specific", all(apply.job_specific(q) for q in (
    "Why do you want to work at Riskified?", "Why are you interested in this position?", "What interests you about this role?",
    "What excites you about Wix?", "Cover letter", "Tell us why you'd be a great fit for this role", "Why this company?",
    "Why join us?", "Why are you applying to monday.com?")))
check("the classifier: general", not any(apply.job_specific(q) for q in (
    "Why are you leaving your current job?", "How did you hear about us?", "Are you legally authorized to work in the United States?",
    "Why should we hire you?", "What is your notice period?", "Years of experience with Python?", "Do you require visa sponsorship?")))
profile = apply.clean_profile({"answers": [{"question": "Why us?", "answer": "A", "job_id": RISKIFIED},
                                          {"question": "Why us?", "answer": "B", "job_id": MONDAY},
                                          {"question": "Notice period?", "answer": "30 days", "job_id": MONDAY}]})
check("saving the settings keeps each job-specific answer's job, and drops a job from a general one",
      profile["answers"] == [{"question": "Why us?", "answer": "A", "job_id": RISKIFIED, "source": "user", "approval": "approved"},
                             {"question": "Why us?", "answer": "B", "job_id": MONDAY, "source": "user", "approval": "approved"},
                             {"question": "Notice period?", "answer": "30 days", "source": "user", "approval": "approved"}], repr(profile["answers"]))

# The monthly cap holds when two answers race for the last one: both read
# 299 before either counts, and only one may be counted.
t.items[("u", "#ai#2026-10")]["n"] = Decimal(299)
stale = t.get_item
t.get_item = lambda Key=None: ({"Item": {"n": Decimal(299)}} if Key["alert_id"].startswith("#ai#") else stale(Key=Key))
ai_answers.draft(t, "u", {"question": "Favourite SQL feature?"}, {}, run=run("Window functions"), report=reported.append, now=NOW)
try:
    ai_answers.draft(t, "u", {"question": "Favourite Go feature?"}, {}, run=run("Goroutines"), report=reported.append, now=NOW)
    check("the second of two racing answers is refused at the cap", False)
except ai_answers.CapReached:
    check("the second of two racing answers is refused at the cap", True)
check("and the count stops at 300", t.items[("u", "#ai#2026-10")]["n"] == 300, repr(t.items[("u", "#ai#2026-10")]))
check("and its answer isn't saved", not any(a["question"] == "Favourite Go feature?" for a in apply.get_profile(t, "u")["answers"]))
t.get_item = stale
t.items[("u", "#ai#2026-10")]["n"] = Decimal(0)

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
