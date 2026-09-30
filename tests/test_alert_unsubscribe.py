"""POST /api/alerts/unsubscribe: one-click, from the mail's header.

Run directly, no framework:  python tests/test_alert_unsubscribe.py
"""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "api"))
os.environ.setdefault("ALERTS_TABLE", "test-alerts")
os.environ.setdefault("DATA_BUCKET", "test-bucket")
os.environ.setdefault("DATA_KEY", "jobs.db")
os.environ.setdefault("AWS_DEFAULT_REGION", "il-central-1")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "testing")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "testing")

import alerts  # noqa: E402
import handler  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failures.append(name)


class Cond(Exception):
    pass


class FakeTable:
    def __init__(self, keys):
        self.keys, self.updates = set(keys), []
        self.meta = type("m", (), {"client": type("c", (), {"exceptions": type("e", (), {"ConditionalCheckFailedException": Cond})()})()})()

    def update_item(self, **kw):
        key = (kw["Key"]["user_id"], kw["Key"]["alert_id"])
        if key not in self.keys:
            raise Cond()
        self.updates.append(kw)
        return {"Attributes": {}}


def event(method, query):
    return {"rawPath": "/api/alerts/unsubscribe", "rawQueryString": query,
            "requestContext": {"http": {"method": method}}}


handler._alerts_table = FakeTable({("user-1", "alert-1")})

r = handler.lambda_handler(event("POST", "u=user-1&a=alert-1&t=abc"), None)
check("with no secret the route is closed", r["statusCode"] == 404, repr(r))

alerts.UNSUBSCRIBE_SECRET = "s3cret"
try:
    good = alerts.unsubscribe_token("user-1", "alert-1")
    r = handler.lambda_handler(event("POST", f"u=user-1&a=alert-1&t={good}"), None)
    check("a signed POST turns the alert off",
          r["statusCode"] == 200 and json.loads(r["body"]) == {"unsubscribed": True}
          and handler._alerts_table.updates[-1]["UpdateExpression"] == "SET active = :f"
          and handler._alerts_table.updates[-1]["ExpressionAttributeValues"] == {":f": False}, repr(r))
    r = handler.lambda_handler(event("POST", "u=user-1&a=alert-1&t=" + "0" * 32), None)
    check("a wrong token is refused", r["statusCode"] == 403 and len(handler._alerts_table.updates) == 1)
    r = handler.lambda_handler(event("POST", f"u=user-1&a=alert-9&t={alerts.unsubscribe_token('user-1', 'alert-9')}"), None)
    check("an alert that is gone is a 404, nothing written", r["statusCode"] == 404 and len(handler._alerts_table.updates) == 1)
    r = handler.lambda_handler(event("POST", "u=user-1"), None)
    check("missing parameters are a 400", r["statusCode"] == 400)
    r = handler.lambda_handler(event("GET", f"u=user-1&a=alert-1&t={good}"), None)
    check("a GET is a page with a form that POSTs, and unsubscribes nothing",
          r["statusCode"] == 200 and "text/html" in r["headers"]["Content-Type"]
          and 'method="post"' in r["body"] and f"t={good}" in r["body"]
          and len(handler._alerts_table.updates) == 1, repr(r)[:200])
    r = handler.lambda_handler(event("DELETE", ""), None)
    check("other methods are refused", r["statusCode"] == 405)
finally:
    alerts.UNSUBSCRIBE_SECRET = ""

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
