"""The custom AI agent's settings and saved-answer provenance
(api/agent.py, api/apply.py; api/AI_AGENT_DESIGN.md step 1).

Needs moto (test only). Run directly:  python tests/test_agent.py
"""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))
for k, v in {"ALERTS_TABLE": "agent-test", "DATA_BUCKET": "test-bucket", "DATA_KEY": "jobs.db", "AWS_DEFAULT_REGION": "il-central-1",
             "AWS_ACCESS_KEY_ID": "testing", "AWS_SECRET_ACCESS_KEY": "testing"}.items():
    os.environ[k] = v

import boto3  # noqa: E402
from moto import mock_aws  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failures.append(name)


def refused(fn, exc=ValueError, says=""):
    try:
        fn()
    except exc as e:
        return says in str(e)
    return False


with mock_aws():
    ddb = boto3.resource("dynamodb", region_name="il-central-1")
    table = ddb.create_table(TableName="agent-test", KeySchema=[{"AttributeName": "user_id", "KeyType": "HASH"},
                                                                {"AttributeName": "alert_id", "KeyType": "RANGE"}],
                             AttributeDefinitions=[{"AttributeName": "user_id", "AttributeType": "S"},
                                                   {"AttributeName": "alert_id", "AttributeType": "S"}],
                             BillingMode="PAY_PER_REQUEST")
    import agent  # noqa: E402
    import apply  # noqa: E402
    import handler  # noqa: E402
    handler._alerts_table = table

    # Defaults and the plan gate.
    a = agent.get(table, "free")
    check("a new agent is the defaults at version 0", a["version"] == 0 and a["review"] == "pause" and a["style"]["tone"] == "plain"
          and set(a["topics"]) == set(agent.TOPICS) and all(t["action"] == "ai" for t in a["topics"].values()))
    check("and can't be changed on Free", a["editable"] is False and refused(lambda: agent.put(table, "free", {"version": 0}), agent.NotIncluded))
    table.put_item(Item={"user_id": "u", "alert_id": apply.PLAN_ROW, "plan": "basic", "status": "active"})
    check("on Basic it can", agent.get(table, "u")["editable"] is True)

    # Versioned saves.
    body = {"version": 0, "style": {"tone": "warm", "length": "medium", "language": "en", "notes": "No exclamation marks."},
            "facts": [{"id": "f1", "text": "I led a team of five at Acme from 2021 to 2024."},
                      {"id": "f2", "text": "I worked on Visa's payments team."}],
            "topics": {"referral_source": {"action": "answer", "value": "LinkedIn"}, "relocation": {"action": "ask"}},
            "never_claim": ["security clearance", "  ", "a PhD"], "review": "use"}
    saved = agent.put(table, "u", body)
    check("a save is stored as sent, cleaned, at version 1", saved["version"] == 1 and saved["style"]["tone"] == "warm"
          and saved["topics"]["referral_source"] == {"action": "answer", "value": "LinkedIn"}
          and saved["topics"]["relocation"] == {"action": "ask", "value": ""} and saved["never_claim"] == ["security clearance", "a PhD"]
          and saved["review"] == "use" and len(saved["facts"]) == 2, repr(saved))
    check("a fact about work at a company named Visa isn't mistaken for a visa", saved["facts"][1]["text"] == "I worked on Visa's payments team.")
    check("a second tab saving the version it loaded gets a conflict", refused(lambda: agent.put(table, "u", body), agent.Conflict))
    check("so does a tab that never loaded it", refused(lambda: agent.put(table, "u", {"version": 0}), agent.Conflict))
    check("a save at the current version goes through, to version 2", agent.put(table, "u", {**body, "version": 1})["version"] == 2)
    check("and the stored row is what reads back", agent.get(table, "u")["version"] == 2)
    check("a save without a version is refused", refused(lambda: agent.put(table, "u", {"style": {}}), says="version is required"))

    # Validation: each bad field is named.
    v = 2
    for name, patch, says in (
            ("an unknown tone", {"style": {"tone": "sarcastic"}}, "style.tone"),
            ("notes over 500 characters", {"style": {"notes": "x" * 501}}, "style.notes"),
            ("more than 20 facts", {"facts": [{"text": f"fact {i}"} for i in range(21)]}, "facts"),
            ("a fact over 300 characters", {"facts": [{"text": "x" * 301}]}, "facts[0]"),
            ("a salary in the facts", {"facts": [{"text": "My salary expectation is 30k"}]}, "belong in your profile"),
            ("work authorization in the facts", {"facts": [{"text": "I'm authorized to work in the US"}]}, "belong in your profile"),
            ("where they live in the facts", {"facts": [{"text": "I'm based in Berlin"}]}, "belong in your profile"),
            ("an unknown topic", {"topics": {"favourite_colour": {"action": "ai"}}}, "unknown topic"),
            ("a fixed answer to why this company", {"topics": {"why_company": {"action": "answer", "value": "I love it"}}}, "one company or role"),
            ("a fixed answer with nothing in it", {"topics": {"start_date": {"action": "answer", "value": ""}}}, "value is required"),
            ("an unknown action", {"topics": {"start_date": {"action": "guess"}}}, "action"),
            ("more than 30 never-claim phrases", {"never_claim": ["x"] * 31}, "never_claim"),
            ("a never-claim phrase over 100 characters", {"never_claim": ["x" * 101]}, "never_claim[0]"),
            ("an unknown review setting", {"review": "never"}, "review")):
        check(f"refused: {name}", refused(lambda: agent.put(table, "u", {"version": v, **patch}), says=says))
    check("and nothing refused was saved", agent.get(table, "u")["version"] == 2)

    # Through the routes.
    def call(method, sub, body=None, token_use="id", user="u"):
        event = {"body": json.dumps(body or {}), "requestContext": {"authorizer": {"jwt": {"claims": {"sub": user, "token_use": token_use}}}}}
        resp = handler.route_apply(user, method, sub, event, {})
        return resp["statusCode"], json.loads(resp["body"] or "null")

    s, b = call("GET", "agent", token_use="ooj")
    check("the extension can read the agent", s == 200 and b["agent"]["version"] == 2)
    s, b = call("PUT", "agent", {"version": 2}, token_use="ooj")
    check("but not change it", s == 403 and b["code"] == "forbidden" and agent.get(table, "u")["version"] == 2)
    s, b = call("PUT", "agent", {"version": 1})
    check("a stale version is 409 conflict", s == 409 and b["code"] == "conflict")
    s, b = call("PUT", "agent", {"version": 2, "review": "never"})
    check("a bad field is 400 naming it", s == 400 and b["code"] == "invalid" and "review" in b["error"])
    s, b = call("PUT", "agent", {"version": 0}, user="free")
    check("Free is 402 not_included", s == 402 and b["code"] == "not_included")
    s, b = call("PUT", "agent", {"version": 2, "review": "pause"})
    check("a good save is 200 with the new version", s == 200 and b["agent"]["version"] == 3 and b["agent"]["review"] == "pause")

    # Who wrote a saved answer, and whether the user approved that text.
    apply.add_answer(table, "u", "How did you hear about us?", "LinkedIn", source="ai")
    apply.add_answer(table, "u", "Notice period?", "30 days")
    by_q = lambda: {a["question"]: a for a in apply.get_profile(table, "u")["answers"]}  # noqa: E731
    check("an AI answer is saved pending review", by_q()["How did you hear about us?"]["approval"] == "pending"
          and by_q()["How did you hear about us?"]["source"] == "ai")
    check("the user's own is approved", by_q()["Notice period?"] == {"question": "Notice period?", "answer": "30 days", "source": "user", "approval": "approved"})
    profile = apply.get_profile(table, "u")
    apply.put_profile(table, "u", profile)
    check("saving the settings unchanged keeps the AI answer pending", by_q()["How did you hear about us?"]["approval"] == "pending")
    for a in profile["answers"]:
        if a["question"] == "Notice period?":
            a.update(source="ai", approval="pending")  # a client claiming the AI wrote it
    apply.put_profile(table, "u", profile)
    check("what the client says about who wrote an answer is ignored", by_q()["Notice period?"]["source"] == "user")
    for a in profile["answers"]:
        if a["question"].startswith("How did"):
            a["answer"] = "A friend told me"
    apply.put_profile(table, "u", profile)
    check("editing an AI answer's text makes it the user's own, approved",
          by_q()["How did you hear about us?"] == {"question": "How did you hear about us?", "answer": "A friend told me", "source": "user", "approval": "approved"})

    apply.add_answer(table, "u", "Years of Python?", "5", source="ai")
    s, b = call("POST", "answers/approve", {"question": "years of python", "answer": "5", "decision": "approved"})
    check("approving the same text keeps it the AI's, approved", s == 200 and b["answer"]["source"] == "ai" and b["answer"]["approval"] == "approved")
    apply.add_answer(table, "u", "Years of Go?", "7", source="ai")
    s, b = call("POST", "answers/approve", {"question": "Years of Go?", "answer": "2", "decision": "approved"})
    check("approving an edited text makes it the user's", s == 200 and b["answer"] == {"question": "Years of Go?", "answer": "2", "source": "user", "approval": "approved"})
    apply.add_answer(table, "u", "Do you have a security clearance?", "Yes", source="ai")
    s, b = call("POST", "answers/approve", {"question": "Do you have a security clearance?", "decision": "rejected"})
    check("a rejected answer is kept, marked rejected", s == 200 and by_q()["Do you have a security clearance?"]["approval"] == "rejected")
    check("and is never used to fill a form", not any(a["question"].startswith("Do you have a security") for a in apply.reusable_answers(apply.get_profile(table, "u")["answers"])))
    s, b = call("GET", "profile", token_use="ooj")
    check("so the extension never receives it", s == 200 and not any(a["question"].startswith("Do you have a security") for a in b["profile"]["answers"]))
    s, b = call("POST", "answers/approve", {"question": "Never asked?", "decision": "approved"})
    check("approving an answer that doesn't exist is 404", s == 404 and b["code"] == "not_found")
    s, b = call("POST", "answers/approve", {"question": "Years of Go?", "decision": "maybe"})
    check("a decision other than approved or rejected is 400", s == 400 and b["code"] == "invalid")
    apply.add_answer(table, "u", "Why do you want to work here?", "Acme's mission", job_id="a1a1a1a1a1a1a1a1", source="ai")
    s, b = call("POST", "answers/approve", {"question": "Why do you want to work here?", "job_id": "a1a1a1a1a1a1a1a1", "decision": "approved"})
    check("a job-specific answer is approved for its own job", s == 200 and b["answer"]["job_id"] == "a1a1a1a1a1a1a1a1" and b["answer"]["approval"] == "approved")

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
