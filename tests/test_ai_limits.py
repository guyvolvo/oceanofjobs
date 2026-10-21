"""The two service-wide limits on AI answers (api/ai_answers.py): 20 model
calls a minute per user, and a daily neuron budget for the whole service
that the server enforces itself, in the same conditional write that
counts, and that fails closed when it can't count.

Needs moto (test only). Run directly:  python tests/test_ai_limits.py
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from moto import mock_aws

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))
for k, v in {"ALERTS_TABLE": "ai-limits", "DATA_BUCKET": "test-bucket", "DATA_KEY": "jobs.db", "AWS_DEFAULT_REGION": "il-central-1",
             "AWS_ACCESS_KEY_ID": "testing", "AWS_SECRET_ACCESS_KEY": "testing"}.items():
    os.environ[k] = v

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failures.append(name)


def raises(fn, exc):
    try:
        fn()
    except exc:
        return True
    return False


NOW = datetime(2026, 10, 21, 12, 0, 5, tzinfo=timezone.utc)
DAY = "#ai_neurons#2026-10-21"

with mock_aws():
    import ai_answers  # noqa: E402
    import apply  # noqa: E402
    import handler  # noqa: E402

    ddb = boto3.resource("dynamodb", region_name="il-central-1")
    table = ddb.create_table(TableName="ai-limits", KeySchema=[{"AttributeName": "user_id", "KeyType": "HASH"},
                                                               {"AttributeName": "alert_id", "KeyType": "RANGE"}],
                             AttributeDefinitions=[{"AttributeName": "user_id", "AttributeType": "S"},
                                                   {"AttributeName": "alert_id", "AttributeType": "S"}],
                             BillingMode="PAY_PER_REQUEST")
    for u in ("u", "v", "w"):
        table.put_item(Item={"user_id": u, "alert_id": apply.PLAN_ROW, "plan": "pro", "status": "active"})
    calls = []

    def run(answer="5", p=600, c=20):
        def call(messages):
            calls.append(messages)
            return answer, p, c
        return call

    def draft(user, now=NOW, question=None, **kw):
        return ai_answers.draft(table, user, {"question": question or f"Years of Python? {len(calls)}"}, {}, run=kw.get("model", run()),
                                report=lambda total: None, now=now)

    def day_total():
        return float((table.get_item(Key={"user_id": ai_answers.SYSTEM_USER, "alert_id": DAY}).get("Item") or {}).get("n", 0))

    # Per user, per minute.
    for _ in range(ai_answers.PER_MINUTE):
        draft("u")
    try:
        draft("u")
        check("the 21st call in a minute is refused", False)
    except ai_answers.RateLimited as e:
        check("the 21st call in a minute is refused, saying when to try again", e.retry_after == 55, repr(e.retry_after))
    check("without reaching the model", len(calls) == ai_answers.PER_MINUTE)
    check("another user isn't affected", draft("v")["answer"] == "5")
    check("the next minute starts again", draft("u", now=NOW + timedelta(minutes=1))["answer"] == "5")
    check("and the counter is one row per user, not one per minute",
          len([i for i in table.scan()["Items"] if i["alert_id"].startswith("#ai_rate")]) == 2)

    # The daily budget: each call holds its worst case first, then settles
    # to what it used.
    total = day_total()
    used = ai_answers.neurons(600, 20)
    check("after a call the day's total is what it really used, not the hold",
          abs(total - round(used, 2) * len(calls)) < 0.05 * len(calls), repr((total, used, len(calls))))

    # The hold for the exact prompt the two racing calls send, measured with a
    # model that fails (which also shows a failed call gives its hold back).
    probe = {}

    def capture(messages):
        probe["held"] = round(ai_answers.neurons(sum(len(m["content"]) for m in messages), ai_answers.MAX_OUT), 2)
        raise ai_answers.NotConfigured("probe")
    raises(lambda: draft("w", now=NOW + timedelta(minutes=2), question="Years of Rust?", model=capture), ai_answers.NotConfigured)
    held = probe["held"]
    table.put_item(Item={"user_id": ai_answers.SYSTEM_USER, "alert_id": DAY, "n": Decimal(str(ai_answers.DAILY_NEURONS - held * 1.5))})
    before = len(calls)
    second = {}

    def first_model(messages):
        # While the first call holds its worst case, a second one arrives.
        try:
            draft("w", now=NOW + timedelta(minutes=2), question="Years of Rust?")
            second["result"] = "answered"
        except ai_answers.BudgetExhausted as e:
            second["result"] = e
        return run()(messages)
    draft("w", now=NOW + timedelta(minutes=2), question="Years of Rust?", model=first_model)
    e = second.get("result")
    check("near the budget, a second call while the first holds its share is refused, until midnight UTC",
          isinstance(e, ai_answers.BudgetExhausted) and e.retry_after == 86400 - (12 * 3600 + 2 * 60 + 5), repr(e))
    check("only the first reached the model", len(calls) == before + 1, repr(len(calls) - before))
    check("the budget is never passed", day_total() <= ai_answers.DAILY_NEURONS, repr(day_total()))
    month = float(table.get_item(Key={"user_id": "w", "alert_id": "#ai#2026-10"})["Item"]["n"])
    check("and the refused call costs the user nothing", month == 1, repr(month))
    table.put_item(Item={"user_id": ai_answers.SYSTEM_USER, "alert_id": DAY, "n": Decimal(0)})

    # A failed model call gives its hold back.
    def broken(messages):
        raise ai_answers.NotConfigured("AI answers are unavailable right now (URLError)")
    check("a model that fails raises", raises(lambda: draft("w", now=NOW + timedelta(minutes=3), model=broken), ai_answers.NotConfigured))
    check("and leaves no hold on the day", day_total() == 0, repr(day_total()))

    # Fails closed: if a limit can't be counted, the call is refused and the
    # model never runs. Monitoring plays no part: report is a no-op here.
    class Broken:
        def __init__(self, inner, row):
            self.inner, self.row = inner, row

        def __getattr__(self, name):
            return getattr(self.inner, name)

        def update_item(self, **kw):
            if kw["Key"]["alert_id"].startswith(self.row):
                raise ClientError({"Error": {"Code": "ProvisionedThroughputExceededException", "Message": "slow down"}}, "UpdateItem")
            return self.inner.update_item(**kw)

    for row, what in (("#ai_rate", "the per-minute counter"), ("#ai_neurons#", "the daily budget")):
        before = len(calls)
        refused = raises(lambda: ai_answers.draft(Broken(table, row), "v", {"question": "Years of Go?"}, {}, run=run(),
                                                  report=lambda total: None, now=NOW + timedelta(minutes=4)), ai_answers.NotConfigured)
        check(f"when {what} can't be written, the call is refused", refused and len(calls) == before)

    # The replies tell the two limits apart.
    real = ai_answers.draft
    handler.route_get_profile = lambda user_id: {"profile": {}}
    for exc, status, code in ((ai_answers.RateLimited("too many", 42), 429, "rate_limited"),
                              (ai_answers.BudgetExhausted("today's limit", 3600), 503, "daily_budget"),
                              (ai_answers.NotConfigured("down"), 503, "unavailable")):
        def fake(*a, exc=exc, **kw):
            raise exc
        ai_answers.draft = fake
        resp = handler.route_apply("u", "POST", "draft", {"body": json.dumps({"question": "x"})}, {})
        body = json.loads(resp["body"])
        check(f"{code} answers {status} with its own code", resp["statusCode"] == status and body["code"] == code and body["retryable"] is True,
              repr((resp["statusCode"], body)))
        if code != "unavailable":
            check(f"and says when to try again ({code})", resp["headers"].get("Retry-After") == str(exc.retry_after) == str(body["retry_after"]))
    ai_answers.draft = real

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
