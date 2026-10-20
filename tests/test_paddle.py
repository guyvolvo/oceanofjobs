"""Paddle's notifications (api/paddle.py): only a correctly signed,
recent request from Paddle's addresses changes a plan, and an older
event never overwrites a newer one.

Run directly, no framework:  python tests/test_paddle.py
"""
import hashlib
import hmac
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))

import paddle  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failures.append(name)


class CondFailed(Exception):
    pass


class FakeTable:
    def __init__(self):
        self.items = {}
        self.meta = type("M", (), {"client": type("C", (), {"exceptions": type("E", (), {"ConditionalCheckFailedException": CondFailed})})})

    def put_item(self, Item=None, ConditionExpression=None, ExpressionAttributeValues=None):
        key = (Item["user_id"], Item["alert_id"])
        old = self.items.get(key)
        if old and old.get("event_at") and old["event_at"] > ExpressionAttributeValues[":at"]:
            raise CondFailed()
        self.items[key] = dict(Item)


SECRET = "pdl_ntfset_test_secret"
os.environ["PADDLE_WEBHOOK_SECRET"] = SECRET
PADDLE_IPS = json.dumps({"data": {"ipv4_cidrs": ["34.232.58.13/32", "34.195.105.136/32"]}}).encode()


def sign(body, ts=None, secret=SECRET):
    ts = str(ts or int(time.time()))
    return f"ts={ts};h1=" + hmac.new(secret.encode(), f"{ts}:{body}".encode(), hashlib.sha256).hexdigest()


def sub_event(status="active", price="pri_01m5c6nb2wc9df6hk0hqkwdr1r", at="2026-10-20T10:00:00Z", user="u1"):
    return json.dumps({"event_id": "evt_1", "event_type": f"subscription.{'created' if status == 'active' else 'updated'}",
                       "occurred_at": at, "data": {"id": "sub_1", "status": status, "customer_id": "ctm_1",
                                                   "custom_data": {"user_id": user} if user else None,
                                                   "items": [{"price": {"id": price}}],
                                                   "current_billing_period": {"ends_at": "2026-11-20T10:00:00Z"}}})


t = FakeTable()
body = sub_event()
check("a signed request is accepted", paddle.verify(sign(body), body, SECRET))
check("a changed body is refused", not paddle.verify(sign(body), body.replace("active", "canceled"), SECRET))
check("another secret is refused", not paddle.verify(sign(body, secret="other"), body, SECRET))
check("an old timestamp is refused (replay)", not paddle.verify(sign(body, ts=int(time.time()) - 3600), body, SECRET))
check("a second h1 during a secret rotation is accepted", paddle.verify(sign(body) + ";h1=deadbeef", body, SECRET))
check("no header or no secret is refused", not paddle.verify("", body, SECRET) and not paddle.verify(sign(body), body, ""))

fetch = lambda: PADDLE_IPS  # noqa: E731
paddle._ips.update(at=0.0, nets=None)
check("Paddle's own address is let through", paddle.from_paddle("34.232.58.13", fetch))
check("any other address is not", not paddle.from_paddle("1.2.3.4", fetch) and not paddle.from_paddle("not-an-ip", fetch))
paddle._ips.update(at=0.0, nets=None)
check("if Paddle's list can't be fetched, the signature alone decides",
      paddle.from_paddle("1.2.3.4", lambda: (_ for _ in ()).throw(OSError("down"))))
paddle._ips.update(at=0.0, nets=None)

status, _ = paddle.handle(t, {"paddle-signature": sign(body)}, body, "34.232.58.13", fetch)
row = t.items.get(("u1", "#plan"))
check("a subscription makes its user Basic", status == 200 and row and row["plan"] == "basic" and row["status"] == "active"
      and row["subscription_id"] == "sub_1" and row["customer_id"] == "ctm_1", repr(row))

status, _ = paddle.handle(t, {"paddle-signature": sign(body)}, body, "9.9.9.9", fetch)
check("a correctly signed request from elsewhere is refused", status == 403)
status, _ = paddle.handle(t, {"paddle-signature": "ts=1;h1=00"}, body, "34.232.58.13", fetch)
check("an unsigned request from Paddle's address is refused", status == 401)

newer = sub_event(status="canceled", at="2026-10-21T10:00:00Z")
paddle.handle(t, {"paddle-signature": sign(newer)}, newer, "34.232.58.13", fetch)
check("a cancel takes effect", t.items[("u1", "#plan")]["status"] == "canceled")
older = sub_event(status="active", at="2026-10-20T11:00:00Z")
paddle.handle(t, {"paddle-signature": sign(older)}, older, "34.232.58.13", fetch)
check("an older event arriving late does not undo it", t.items[("u1", "#plan")]["status"] == "canceled")

pro = sub_event(price="pri_01m5c6q394qkj6pfxekj6t37sh", user="u2")
paddle.handle(t, {"paddle-signature": sign(pro)}, pro, "34.232.58.13", fetch)
check("the Pro price makes its user Pro", t.items[("u2", "#plan")]["plan"] == "pro")
os.environ["PADDLE_PRICES"] = "pri_live_basic=basic"
live = sub_event(price="pri_live_basic", user="u3")
paddle.handle(t, {"paddle-signature": sign(live)}, live, "34.232.58.13", fetch)
check("PADDLE_PRICES adds live price ids", t.items[("u3", "#plan")]["plan"] == "basic")
anon = sub_event(user=None)
check("a subscription with no user_id changes nothing", "no user_id" in paddle.apply_event(t, json.loads(anon)))
refund = {"event_type": "adjustment.created", "data": {"action": "refund", "status": "approved", "subscription_id": "sub_1"}}
check("an approved refund is logged for a manual cancel", "cancel it in Paddle" in paddle.apply_event(t, refund))
import os  # noqa: E402
sent = []
os.environ["PADDLE_API_KEY"] = "pdl_test_key"
out = paddle.apply_event(t, refund, post=sent.append)
check("with an API key, an approved refund cancels the subscription in Paddle at once",
      "canceled in Paddle" in out and sent and sent[0].full_url.endswith("/subscriptions/sub_1/cancel")
      and json.loads(sent[0].data) == {"effective_from": "immediately"}
      and sent[0].get_header("Authorization") == "Bearer pdl_test_key", out)
def boom(req):
    raise OSError("network down")
check("and falls back to the manual cancel when Paddle can't be reached",
      "cancel it in Paddle" in paddle.apply_event(t, refund, post=boom))
del os.environ["PADDLE_API_KEY"]

del os.environ["PADDLE_WEBHOOK_SECRET"]
check("with no secret configured every request is refused", paddle.handle(t, {}, body, "34.232.58.13", fetch)[0] == 503)

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
