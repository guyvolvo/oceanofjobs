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
    check("the old claim still answers as before", s == 200 and b == {"remaining": 29}, repr((s, b)))
    s, _ = call("frank", "POST", "result", {"job_id": job(20)["job_id"], "status": "submitted"})
    s2, b2 = call("frank", "GET", "usage")
    check("the old result and usage still work", s == 204 and b2["used"] == 1, repr((s, b2)))
    check("and the old flow creates no attempts, ledgers or job locks",
          not rows("frank", attempts.ATTEMPT) and not rows("frank", "#ledger#") and not rows("frank", attempts.JOBLOCK))
    s, b = call("frank", "POST", "attempts", {"attempt_id": "frank-0001", **job(20)})
    check("a job submitted the old way can't be reserved the new way", s == 409 and b["code"] == "job_taken", repr((s, b)))

    # Account deletion removes the new rows too.
    s, _ = call("bob", "DELETE", "")
    check("deleting the account's auto apply data removes attempts, ledgers and locks",
          s == 204 and not rows("bob", "#attempt#") and not rows("bob", "#ledger#") and not rows("bob", "#joblock#"))

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
