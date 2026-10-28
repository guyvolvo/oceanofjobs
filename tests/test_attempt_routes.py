"""Step 1 of the attempts migration: the /api/me/apply/attempts routes and
the expiry sweep, against the acceptance criteria. Ownership, idempotency,
submit authorization, the sweep under repeats, overlap and partial
failure, the old claim and result routes unchanged, and logs without
user data.

Needs moto (test only):    python -m pip install "moto[dynamodb]==5.1.4"
Run directly, no framework:  python tests/test_attempt_routes.py
"""
import contextlib
import io
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))
for k, v in {"ALERTS_TABLE": "routes-test", "DATA_BUCKET": "test-bucket", "DATA_KEY": "jobs.db", "AWS_DEFAULT_REGION": "il-central-1",
             "AWS_ACCESS_KEY_ID": "testing", "AWS_SECRET_ACCESS_KEY": "testing"}.items():
    os.environ[k] = v

import boto3  # noqa: E402
from moto import mock_aws  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failures.append(name)


GH = "https://job-boards.greenhouse.io/embed/job_app?for=acme&token={}"


def job(n):
    return {"job_id": f"{n:016x}", "url": GH.format(5000 + n), "title": "Engineer", "company": "acme.com"}


with mock_aws():
    ddb = boto3.resource("dynamodb", region_name="il-central-1")
    table = ddb.create_table(TableName="routes-test", KeySchema=[{"AttributeName": "user_id", "KeyType": "HASH"},
                                                                {"AttributeName": "alert_id", "KeyType": "RANGE"}],
                             AttributeDefinitions=[{"AttributeName": "user_id", "AttributeType": "S"},
                                                   {"AttributeName": "alert_id", "AttributeType": "S"}],
                             BillingMode="PAY_PER_REQUEST")
    import attempts  # noqa: E402
    import handler  # noqa: E402
    handler._alerts_table = table
    A = attempts.Attempts(table)

    def call(user, method, sub, body=None):
        resp = handler.route_apply(user, method, sub, {"body": json.dumps(body or {})}, {})
        return resp["statusCode"], json.loads(resp["body"] or "null")

    def rows(user, prefix):
        return [i for i in table.scan()["Items"] if i["user_id"] == user and i["alert_id"].startswith(prefix)]

    # 0. Saved answers: the extension never gets another company's "why us".
    import apply  # noqa: E402
    route_get_profile = handler.route_get_profile
    handler.route_get_profile = lambda user_id: {"profile": {}}
    apply.put_profile(table, "zoe", {"answers": [{"question": "Why do you want to work here?", "answer": "Riskified's fraud work."},
                                                 {"question": "Notice period?", "answer": "30 days"}]})

    def profile_as(token_use):
        event = {"requestContext": {"authorizer": {"jwt": {"claims": {"sub": "zoe", "token_use": token_use}}}}}
        return json.loads(handler.route_apply("zoe", "GET", "profile", event, {})["body"])["profile"]["answers"]
    check("an extension token gets general answers only, not an old answer that names a company",
          [a["question"] for a in profile_as("ooj")] == ["Notice period?"], repr(profile_as("ooj")))
    check("a signed-in session sees every answer, so it can remove them",
          [a["question"] for a in profile_as("id")] == ["Why do you want to work here?", "Notice period?"])

    # The setup guide: shown until finished or skipped, kept when the profile is saved, back on request.
    onboarded = lambda: json.loads(handler.route_apply("zoe", "GET", "profile", {}, {})["body"])["onboarded"]  # noqa: E731
    check("a new user sees the setup guide", onboarded() is False)
    s, _ = call("zoe", "POST", "onboarded", {"choice": "balance"})
    check("finishing it records the choice and hides it", s == 204 and onboarded() is True
          and table.get_item(Key={"user_id": "zoe", "alert_id": apply.ONBOARDED_ROW})["Item"]["choice"] == "balance")
    apply.put_profile(table, "zoe", {"settings": {"mode": "queue"}})
    check("saving the profile doesn't bring it back", onboarded() is True)
    call("zoe", "POST", "onboarded", {"choice": "whatever"})
    check("an unknown choice is recorded as skipped", table.get_item(Key={"user_id": "zoe", "alert_id": apply.ONBOARDED_ROW})["Item"]["choice"] == "skipped")
    s, _ = call("zoe", "DELETE", "onboarded")
    check("Run setup again shows it once more", s == 204 and onboarded() is False)
    call("zoe", "POST", "onboarded", {})
    call("zoe", "DELETE", "")
    check("deleting auto apply data takes the record too", not table.get_item(Key={"user_id": "zoe", "alert_id": apply.ONBOARDED_ROW}).get("Item"))
    s, _ = call("zoe", "POST", "answers", {"question": "Why do you want to work here?", "answer": "Monday's product.", "job_id": f"{7:016x}"})
    check("answering it for one job keeps it for that job", s == 204 and {"question": "Why do you want to work here?",
          "answer": "Monday's product.", "job_id": f"{7:016x}", "source": "user", "approval": "approved"} in profile_as("ooj"), repr(profile_as("ooj")))
    handler.route_get_profile = route_get_profile

    # 1. Ownership: another user's attempt reads as not found, for every operation.
    s, b = call("alice", "POST", "attempts", {"attempt_id": "alice-0001", **job(1)})
    check("a user reserves an attempt", s == 200 and b["attempt"]["state"] == "reserved", repr((s, b)))
    for method, sub in (("GET", "attempts/alice-0001"), ("POST", "attempts/alice-0001/submission-started"),
                        ("POST", "attempts/alice-0001/settle"), ("POST", "attempts/alice-0001/dispute")):
        s, b = call("mallory", method, sub, {"outcome": "failed"})
        check(f"another user gets not found: {method} {sub.split('/')[-1]}", s == 404 and b["code"] == "not_found", repr((s, b)))
    check("and alice's attempt is untouched", A._get("alice", attempts.ATTEMPT + "alice-0001")["state"] == "reserved")
    s, b = call("mallory", "POST", "attempts", {"attempt_id": "alice-0001", **job(1)})
    check("reusing alice's attempt id makes mallory's own attempt, not alice's", s == 200 and rows("mallory", attempts.ATTEMPT)
          and A.ledger("alice", attempts.LEDGER_MONTH + attempts.periods(datetime.now(timezone.utc), None)[0])["held"] == 1, repr((s, b)))

    # 2. Idempotency through the routes.
    s1, b1 = call("bob", "POST", "attempts", {"attempt_id": "bob-00001", **job(2)})
    s2, b2 = call("bob", "POST", "attempts", {"attempt_id": "bob-00001", **job(2)})
    month = attempts.periods(datetime.now(timezone.utc), None)[0]
    check("a repeated reserve returns the same attempt and holds one credit", b1 == b2
          and A.ledger("bob", attempts.LEDGER_MONTH + month)["held"] == 1, repr((b1, b2)))
    s, b = call("bob", "POST", "attempts", {"attempt_id": "bob-00001", **job(3)})
    check("the same id for another job is a conflict", s == 409 and b["code"] == "conflict" and b["retryable"] is False, repr((s, b)))
    s1, b1 = call("bob", "POST", "attempts/bob-00001/submission-started")
    s2, b2 = call("bob", "POST", "attempts/bob-00001/submission-started")
    check("a repeated submission start is acknowledged the same way", s1 == s2 == 200 and b1["submit"] is True and b2["submit"] is True)
    for _ in range(2):
        s, b = call("bob", "POST", "attempts/bob-00001/settle", {"outcome": "unconfirmed", "reason": "no confirmation"})
    check("a repeated settle charges once", s == 200 and A.ledger("bob", attempts.LEDGER_MONTH + month)["charged"] == 1)
    for _ in range(2):
        s, b = call("bob", "POST", "attempts/bob-00001/dispute")
    led = A.ledger("bob", attempts.LEDGER_MONTH + month)
    check("a repeated dispute refunds once and counts once", s == 200 and b["attempt"]["state"] == "not_sent_disputed"
          and led == {"held": 0, "charged": 0, "disputes": 1}, repr(led))

    # 3. Submit authorization.
    s, b = call("carol", "POST", "attempts", {"attempt_id": "carol-0001", **job(4)})
    table.update_item(Key={"user_id": "carol", "alert_id": attempts.ATTEMPT + "carol-0001"},
                      UpdateExpression="SET expires_at = :t", ExpressionAttributeValues={":t": "2000-01-01T00:00:00+00:00"})
    s, b = call("carol", "POST", "attempts/carol-0001/submission-started")
    check("an expired reservation is refused submission: 410 expired, not retryable",
          s == 410 and b["code"] == "expired" and b["retryable"] is False and "submit" not in b, repr((s, b)))
    check("and it is settled abandoned, releasing the credit", A._get("carol", attempts.ATTEMPT + "carol-0001")["state"] == "abandoned")
    s, b = call("carol", "POST", "attempts/carol-0001/submission-started")
    check("asking again is refused as not eligible", s == 409 and b["code"] == "not_eligible", repr((s, b)))
    call("carol", "POST", "attempts", {"attempt_id": "carol-0002", **job(5)})
    call("carol", "POST", "attempts/carol-0002/settle", {"outcome": "needs_input", "reason": "Needs your answer: Why us?"})
    s, b = call("carol", "POST", "attempts/carol-0002/submission-started")
    check("a settled attempt is refused submission", s == 409 and b["code"] == "not_eligible", repr((s, b)))
    s, b = call("carol", "POST", "attempts/nope-00001/submission-started")
    check("an unknown attempt is refused submission", s == 404 and b["code"] == "not_found")
    s, b = call("carol", "POST", "attempts/carol-0002/dispute")
    check("a dispute of a released attempt is refused, and uses no allowance", s == 409 and b["code"] == "not_disputable"
          and A.ledger("carol", attempts.LEDGER_MONTH + month)["disputes"] == 0, repr((s, b)))

    # A transient failure is retryable, distinct from an expired reservation.
    real = attempts.Attempts.reserve

    def boom(self, *a, **k):
        raise RuntimeError("throttled")

    attempts.Attempts.reserve = boom
    s, b = call("dave", "POST", "attempts", {"attempt_id": "dave-00001", **job(6)})
    attempts.Attempts.reserve = real
    check("a server-side failure is 503, retryable", s == 503 and b["code"] == "unavailable" and b["retryable"] is True, repr((s, b)))
    s, b = call("dave", "POST", "attempts", {"attempt_id": "dave-00001", **job(6)})
    check("and repeating the same request then succeeds once", s == 200 and len(rows("dave", attempts.ATTEMPT)) == 1)

    # 6. Logs: no raw user id, no reasons.
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        call("erin@example.com", "POST", "attempts/x-000000001/settle", {"outcome": "failed", "reason": "Needs your answer: secret"})
    logged = out.getvalue()
    check("a refusal is logged with the code", "code=not_found" in logged and "op=settle" in logged, logged)
    check("without the user's id, email or the reason", "erin" not in logged and "secret" not in logged, logged)

    # 4. The sweep: repeated, overlapping, partial failure.
    past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    for u in ("s1", "s2", "s3"):
        call(u, "POST", "attempts", {"attempt_id": f"{u}-sweep-01", **job(10)})
        call(u, "POST", f"attempts/{u}-sweep-01/submission-started")
        table.update_item(Key={"user_id": u, "alert_id": attempts.ATTEMPT + f"{u}-sweep-01"},
                          UpdateExpression="SET expires_at = :t", ExpressionAttributeValues={":t": past})
    real_settle = attempts.Attempts._settle
    calls = {"n": 0}

    def flaky(self, user_id, *a, **k):
        if user_id == "s2" and calls["n"] == 0:
            calls["n"] += 1
            raise RuntimeError("throttled")
        return real_settle(self, user_id, *a, **k)

    attempts.Attempts._settle = flaky
    with contextlib.redirect_stdout(io.StringIO()) as quiet:
        first = A.sweep()
    attempts.Attempts._settle = real_settle
    states = {u: A._get(u, attempts.ATTEMPT + f"{u}-sweep-01")["state"] for u in ("s1", "s2", "s3")}
    check("a sweep with one user's failure still settles the others", first == 2 and states["s1"] == states["s3"] == "unconfirmed"
          and states["s2"] == "submission_started", repr((first, states)))
    check("and logs the failure", "expire_failed" in quiet.getvalue(), quiet.getvalue())
    second = A.sweep()
    check("the next run settles what the failed one left", second == 1
          and A._get("s2", attempts.ATTEMPT + "s2-sweep-01")["state"] == "unconfirmed", repr(second))
    check("a repeated run finds nothing to do", A.sweep() == 0)
    for u in ("o1", "o2", "o3", "o4"):
        call(u, "POST", "attempts", {"attempt_id": f"{u}-sweep-01", **job(11)})
        table.update_item(Key={"user_id": u, "alert_id": attempts.ATTEMPT + f"{u}-sweep-01"},
                          UpdateExpression="SET expires_at = :t", ExpressionAttributeValues={":t": past})
    # Two overlapping runs, interleaved the worst way: the first reads the
    # expired attempts, the second settles them all, then the first goes on
    # with what it read. (moto applies a transaction's items without
    # isolation between threads, which DynamoDB never does, so this is
    # played out in order rather than with threads.)
    stale = {u: A._attempts(u) for u in ("o1", "o2", "o3", "o4")}
    second_run = A.sweep()
    real_attempts = attempts.Attempts._attempts
    attempts.Attempts._attempts = lambda self, user_id: stale[user_id]
    with contextlib.redirect_stdout(io.StringIO()) as quiet:
        first_run = sum(A.expire(u) for u in ("o1", "o2", "o3", "o4"))
    attempts.Attempts._attempts = real_attempts
    held = [A.ledger(u, attempts.LEDGER_MONTH + month)["held"] for u in ("o1", "o2", "o3", "o4")]
    done = [A._get(u, attempts.ATTEMPT + f"{u}-sweep-01")["state"] for u in ("o1", "o2", "o3", "o4")]
    check("an overlapping run settles every expired reservation once", second_run == 4 and done == ["abandoned"] * 4, repr((second_run, done)))
    check("and the stale run releases nothing again", first_run == 0 and held == [0, 0, 0, 0] and "failed" not in quiet.getvalue(),
          repr((first_run, held, quiet.getvalue())))

    # 5. The old routes are unchanged and make no reservations.
    s, b = call("frank", "POST", "claim", {"job_id": job(20)["job_id"], "url": job(20)["url"], "company": "acme.com"})
    check("the old claim still answers as before", s == 200 and b == {"remaining": handler.apply.LIMITS["free"][1] - 1}, repr((s, b)))
    s, _ = call("frank", "POST", "result", {"job_id": job(20)["job_id"], "status": "submitted"})
    s2, b2 = call("frank", "GET", "usage")
    check("the old result and usage still work", s == 204 and b2["used"] == 1, repr((s, b2)))
    check("and the old flow creates no attempts, ledgers or job locks",
          not rows("frank", attempts.ATTEMPT) and not rows("frank", "#ledger#") and not rows("frank", attempts.JOBLOCK))
    s, b = call("frank", "POST", "attempts", {"attempt_id": "frank-0001", **job(20)})
    check("a job submitted the old way can't be reserved the new way", s == 409 and b["code"] == "job_taken", repr((s, b)))

    # The shared summary, needs, Filled entries, one History and queue order.
    ok_ = call("gina", "POST", "attempts", {"attempt_id": "gina-00001", **job(30)})[0]
    call("gina", "POST", "attempts/gina-00001/submission-started")
    call("gina", "POST", "attempts/gina-00001/settle", {"outcome": "submitted"})
    call("gina", "POST", "attempts", {"attempt_id": "gina-00002", **job(31)})
    call("gina", "POST", "attempts/gina-00002/submission-started")
    call("gina", "POST", "attempts/gina-00002/settle", {"outcome": "unconfirmed", "reason": "no confirmation"})
    call("gina", "POST", "attempts", {"attempt_id": "gina-00003", **job(32)})
    call("gina", "POST", "attempts/gina-00003/settle", {"outcome": "needs_input", "reason": "Needs your answer: Why us?; Notice period?",
                                                         "questions": ["Why us?", "Notice period?"]})
    call("gina", "POST", "attempts", {"attempt_id": "gina-00004", **job(33)})  # still in progress
    s1, b1 = call("gina", "POST", "filled", {"attempt_id": "gina-00005", **job(34)})
    s2, b2 = call("gina", "POST", "filled", {"attempt_id": "gina-00005", **job(34)})
    check("a Filled entry is recorded, and recording it again changes nothing", s1 == s2 == 200 and b1 == b2 and b1["attempt"]["state"] == "filled")
    call("sender", "POST", "filled", {"attempt_id": "sender-0001", **job(34)})
    s, b = call("sender", "POST", "attempts/sender-0001/sent", {"how": "request"})
    s2, b2 = call("bob", "POST", "attempts/sender-0001/sent", {"how": "request"})
    check("the user's own send of a filled form is recorded, and not by another user", s == 200 and b["attempt"]["state"] == "sent"
          and s2 == 404, repr((s, b, s2)))
    call("gina", "POST", "claim", {"job_id": job(35)["job_id"], "url": job(35)["url"]})
    call("gina", "POST", "result", {"job_id": job(35)["job_id"], "status": "submitted"})  # one through the old path
    s, summ = call("gina", "GET", "summary")
    check("the summary counts submitted and unconfirmed as used, across both paths", s == 200 and summ["used"] == 3, repr(summ))
    check("and the open attempt as in progress, with the rest left", summ["in_progress"] == 1 and summ["remaining"] == handler.apply.LIMITS["free"][1] - 4, repr(summ))
    check("Filled costs nothing", summ["used"] + summ["in_progress"] + summ["remaining"] == handler.apply.LIMITS["free"][1])
    check("unconfirmed, needs and disputes are counted", summ["unconfirmed"] == 1 and summ["needs_input"] == 1 and summ["disputes_left"] == 5, repr(summ))
    s, use = call("gina", "GET", "usage")
    check("the old usage route gives the same numbers", use == {"plan": "free", "period": "month", "limit": handler.apply.LIMITS["free"][1], "used": 4, "remaining": handler.apply.LIMITS["free"][1] - 4}, repr(use))
    s, nd = call("gina", "GET", "needs")
    check("needs list the job and its questions", s == 200 and nd["needs"][0]["questions"] == ["Why us?", "Notice period?"]
          and nd["needs"][0]["job_id"] == job(32)["job_id"], repr(nd))
    table.put_item(Item={"user_id": "gina", "alert_id": "#queue#" + job(32)["job_id"], "job_id": job(32)["job_id"], "added_at": "2026-10-21T00:00:00+00:00"})
    check("once the job is queued again it no longer needs attention", call("gina", "GET", "needs")[1]["needs"] == [])
    s, hist = call("gina", "GET", "history")
    by = {r["job_id"]: r for r in hist["applied"]}
    check("History keeps every status distinct", [by[job(n)["job_id"]]["status"] for n in (30, 31, 32, 33, 34, 35)]
          == ["submitted", "unconfirmed", "needs_input", "in_progress", "filled", "submitted"], repr([r["status"] for r in hist["applied"]]))
    check("only the unconfirmed one is disputable", [r["job_id"] for r in hist["applied"] if r.get("disputable")] == [job(31)["job_id"]])
    for n in (40, 41, 42):
        table.put_item(Item={"user_id": "gina", "alert_id": "#queue#" + job(n)["job_id"], "job_id": job(n)["job_id"],
                             "added_at": f"2026-10-21T00:00:0{n - 40}+00:00"})
    s, _ = call("gina", "POST", "queue-order", {"job_ids": [job(42)["job_id"], job(40)["job_id"], job(41)["job_id"], job(32)["job_id"], "ffffffffffffffff"]})
    check("the queue keeps the order the user set, and ignores ids not in it", s == 204 and [r["job_id"] for r in handler.apply.queue(table, "gina")]
          == [job(42)["job_id"], job(40)["job_id"], job(41)["job_id"], job(32)["job_id"]] and not rows("gina", "#queue#ffffffffffffffff"))

    # A site's human check: filled, then handed to the user to send.
    call("ivy", "POST", "attempts", {"attempt_id": "ivy-000001", **job(50)})
    s, _ = call("ivy", "POST", "attempts/ivy-000001/settle", {"outcome": "needs_input",
        "reason": "Ready to submit. This site checks that a person sends the form, so open it and press Submit yourself.", "questions": []})
    nd = call("ivy", "GET", "needs")[1]["needs"]
    check("a job held back by a human check is listed as ready to submit, with no questions",
          s == 200 and len(nd) == 1 and nd[0].get("ready") is True and nd[0]["questions"] == [], repr(nd))
    s, summ = call("ivy", "GET", "summary")
    check("and costs nothing", summ["used"] == 0 and summ["in_progress"] == 0, repr(summ))
    call("ivy", "POST", "filled", {"attempt_id": "ivy-000002", **job(50)})
    check("once the user fills it in with the extension, it leaves the list", call("ivy", "GET", "needs")[1]["needs"] == [])

    # Credits used through the old path count against the new one.
    for n in range(handler.apply.LIMITS["free"][1]):
        handler.apply.claim(table, "hank", {"job_id": f"{100 + n:016x}"})
    s, b = call("hank", "POST", "attempts", {"attempt_id": "hank-00001", **job(60)})
    check("the free limit used the old way: a new reservation is refused", s == 402 and b["code"] == "limit_reached", repr((s, b)))

    # An answer the extension drafted with the user's own AI key waits for review.
    s, _ = call("ivy", "POST", "answers", {"question": "Years of Go?", "answer": "Four", "source": "ai"})
    got = apply.get_profile(table, "ivy")["answers"][0]
    check("an own-key AI answer is saved as the AI's, pending", s == 204 and (got["source"], got["approval"]) == ("ai", "pending"), repr(got))

    # A body of the wrong shape is a 400, not an internal error.
    def api(method, path, body):
        event = {"rawPath": "/api" + path, "body": body, "requestContext": {"http": {"method": method},
                 "authorizer": {"jwt": {"claims": {"sub": "ivy", "token_use": "id"}}}}}
        with contextlib.redirect_stderr(io.StringIO()):
            r = handler.lambda_handler(event, None)
        return r["statusCode"], json.loads(r["body"] or "null")
    table.put_item(Item={"user_id": "ivy", "alert_id": apply.PLAN_ROW, "plan": "pro", "status": "active"})
    for body in ('["x"]', '{"facts": ["x"]}', '{"facts": [], "topics": "x"}'):
        s, b = api("PUT", "/me/apply/agent", body)
        check(f"PUT agent {body} is a 400", s == 400, repr((s, b)))

    # Every query reads past DynamoDB's 1 MB page.
    for n in range(40):
        table.put_item(Item={"user_id": "jay", "alert_id": f"#attempt#jay-{n:05d}", "attempt_id": f"jay-{n:05d}", "pad": "x" * 40000})
    check("a partition over 1 MB is read in full", len(A._attempts("jay")) == 40, str(len(A._attempts("jay"))))

    # Account deletion removes the new rows too.
    table.put_item(Item={"user_id": "bob", "alert_id": "#ai#2026-10", "n": 3})
    s, _ = call("bob", "DELETE", "")
    check("deleting the account's auto apply data removes attempts, ledgers, locks and AI counts",
          s == 204 and not rows("bob", "#attempt#") and not rows("bob", "#ledger#") and not rows("bob", "#joblock#") and not rows("bob", "#ai#"))
    s, _ = call("jay", "DELETE", "")
    check("account deletion past 1 MB removes every row", s == 204 and not rows("jay", "#attempt#"))

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
