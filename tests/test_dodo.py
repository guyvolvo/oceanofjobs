"""Dodo Payments (api/dodo.py): only a correctly signed, recent
notification changes a plan, an older event never overwrites a newer one,
a subscription finds its account by metadata or by customer, a refund
cancels its subscription, and checkout makes one customer per account.

Run directly, no framework:  python tests/test_dodo.py
"""
import base64
import hashlib
import hmac
import io
import json
import os
import sys
import time
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))

import dodo  # noqa: E402

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
        if ConditionExpression and old and old.get("event_at") and old["event_at"] > ExpressionAttributeValues[":at"]:
            raise CondFailed()
        self.items[key] = dict(Item)

    def get_item(self, Key=None):
        item = self.items.get((Key["user_id"], Key["alert_id"]))
        return {"Item": dict(item)} if item else {}


class FakeDodo:
    """Answers dodo._call's requests and keeps them."""
    def __init__(self, answers):
        self.answers, self.calls = answers, []

    def __call__(self, req):
        path = req.full_url.split(".com", 1)[1]
        self.calls.append((req.get_method(), path, json.loads(req.data) if req.data else None))
        return json.dumps(self.answers.get((req.get_method(), path), {})).encode()


SECRET = "whsec_" + base64.b64encode(b"a test signing key of 24b").decode()
os.environ.update(DODO_WEBHOOK_SECRET=SECRET, DODO_API_KEY="test_key", DODO_ENV="test",
                  DODO_PRODUCTS="pdt_basic=basic,pdt_pro=pro", DODO_DISCOUNT="LAUNCH50")


def signed(body, ts=None, wid="msg_1", secret=SECRET):
    ts = str(ts or int(time.time()))
    key = base64.b64decode(secret.removeprefix("whsec_"))
    sig = base64.b64encode(hmac.new(key, f"{wid}.{ts}.{body}".encode(), hashlib.sha256).digest()).decode()
    return {"Webhook-Id": wid, "Webhook-Timestamp": ts, "Webhook-Signature": f"v1,{sig}"}


def sub_event(status="active", product="pdt_basic", at="2026-10-27T10:00:00Z", user="u1", customer="cus_1", kind=None):
    return json.dumps({"business_id": "bus_1", "type": kind or f"subscription.{status}", "timestamp": at,
                       "data": {"payload_type": "Subscription", "subscription_id": "sub_1", "status": status, "product_id": product,
                                "customer": {"customer_id": customer, "email": "a@b.c"},
                                "metadata": {"user_id": user} if user else {}, "next_billing_date": "2026-11-27T10:00:00Z"}})


# Signatures.
t = FakeTable()
body = sub_event()
check("a signed notification is taken", dodo.handle(t, signed(body), body)[0] == 200)
check("it gives the plan", t.items[("u1", "#plan")]["plan"] == "basic" and t.items[("u1", "#plan")]["status"] == "active")
check("an unsigned one is refused", dodo.handle(FakeTable(), {}, body)[0] == 401)
check("a changed body is refused", dodo.handle(FakeTable(), signed(body), body.replace("pdt_basic", "pdt_pro"))[0] == 401)
check("another secret's signature is refused",
      dodo.handle(FakeTable(), signed(body, secret="whsec_" + base64.b64encode(b"other").decode()), body)[0] == 401)
check("an old timestamp is refused", dodo.handle(FakeTable(), signed(body, ts=int(time.time()) - 3600), body)[0] == 401)
h = signed(body)
h["Webhook-Signature"] = "v1,bm90IGl0 " + h["Webhook-Signature"]
check("one good signature among several is enough (secret rotation)", dodo.handle(FakeTable(), h, body)[0] == 200)
os.environ["DODO_WEBHOOK_SECRET"] = ""
check("no secret configured refuses everything", dodo.handle(FakeTable(), signed(body), body)[0] == 503)
os.environ["DODO_WEBHOOK_SECRET"] = SECRET

# Plans and statuses.
t = FakeTable()
dodo.apply_event(t, json.loads(sub_event(product="pdt_pro")))
check("the pro product gives pro", t.items[("u1", "#plan")]["plan"] == "pro")
dodo.apply_event(t, json.loads(sub_event(status="cancelled", at="2026-10-28T10:00:00Z")))
check("cancelled is stored as canceled, the row's word", t.items[("u1", "#plan")]["status"] == "canceled")
out = dodo.apply_event(t, json.loads(sub_event(status="active", at="2026-10-27T11:00:00Z")))
check("an older event doesn't overwrite a newer one", "older" in out and t.items[("u1", "#plan")]["status"] == "canceled", out)
dodo.apply_event(t, json.loads(sub_event(status="past_due", at="2026-10-29T10:00:00Z")))
check("past_due keeps its name, so the plan stays through Dodo's grace period", t.items[("u1", "#plan")]["status"] == "past_due")
dodo.apply_event(t, json.loads(sub_event(product="pdt_unknown", at="2026-10-30T10:00:00Z")))
check("an unknown product gives no paid plan", t.items[("u1", "#plan")]["plan"] == "free")

# Finding the account.
t = FakeTable()
t.put_item(Item={"user_id": dodo.CUSTOMERS, "alert_id": "cus_9", "owner": "u9"})
dodo.apply_event(t, json.loads(sub_event(user=None, customer="cus_9")))
check("without metadata, the customer names the account", t.items[("u9", "#plan")]["plan"] == "basic")
out = dodo.apply_event(t, json.loads(sub_event(user=None, customer="cus_unknown")))
check("no metadata and an unknown customer changes nothing", "no account" in out and len(t.items) == 2, out)

# Refunds cancel.
t = FakeTable()
fake = FakeDodo({("GET", "/payments/pay_1"): {"payment_id": "pay_1", "subscription_id": "sub_1"}})
out = dodo.apply_event(t, {"type": "refund.succeeded", "timestamp": "2026-10-27T10:00:00Z", "data": {"payment_id": "pay_1", "status": "succeeded"}}, fake)
check("a refund cancels its subscription now", ("PATCH", "/subscriptions/sub_1", {"status": "cancelled"}) in fake.calls, out)
out = dodo.apply_event(t, {"type": "refund.succeeded", "data": {"payment_id": "pay_2"}}, FakeDodo({("GET", "/payments/pay_2"): {"payment_id": "pay_2"}}))
check("a refund of a one-time payment cancels nothing", "no subscription" in out, out)

# Checkout and portal.
t = FakeTable()
fake = FakeDodo({("POST", "/customers"): {"customer_id": "cus_new"}, ("POST", "/checkouts"): {"checkout_url": "https://checkout.example/s1"},
                 ("POST", "/customers/cus_new/customer-portal/session"): {"link": "https://portal.example/p"}})
out = dodo.checkout(t, "u1", "a@b.c", "pro", fake)
check("checkout answers Dodo's link", out == {"url": "https://checkout.example/s1"}, str(out))
sent = [c for c in fake.calls if c[1] == "/checkouts"][0][2]
check("the checkout names the pro product, the customer, the account and the discount",
      sent["product_cart"] == [{"product_id": "pdt_pro", "quantity": 1}] and sent["customer"] == {"customer_id": "cus_new"}
      and sent["metadata"] == {"user_id": "u1"} and sent["discount_codes"] == ["LAUNCH50"], json.dumps(sent))
check("the buyer can change the name and email on the checkout",
      sent["feature_flags"] == {"allow_customer_editing_name": True, "allow_customer_editing_email": True}, json.dumps(sent))
check("the customer is remembered both ways", t.items[("u1", "#billing")]["customer_id"] == "cus_new"
      and t.items[(dodo.CUSTOMERS, "cus_new")]["owner"] == "u1")
dodo.checkout(t, "u1", "a@b.c", "basic", fake)
check("a second checkout reuses the customer", [c[1] for c in fake.calls].count("/customers") == 1)
check("an unknown plan isn't sold", dodo.checkout(t, "u1", "a@b.c", "gold", fake).get("code") == "unknown_plan")
check("no confirmed email, no checkout", dodo.checkout(FakeTable(), "u2", None, "pro", fake).get("code") == "no_email")
class Refusing(FakeDodo):
    """Refuses every checkout that carries a discount code with status."""
    def __init__(self, answers, status):
        super().__init__(answers)
        self.status = status

    def __call__(self, req):
        body = json.loads(req.data) if req.data else {}
        if req.full_url.endswith("/checkouts") and (body.get("discount_codes") or self.status >= 500):
            self.calls.append(("POST", "/checkouts", body))
            raise urllib.error.HTTPError(req.full_url, self.status, "refused", {}, io.BytesIO(b'{"message":"discount expired"}'))
        return super().__call__(req)


late = Refusing({("POST", "/checkouts"): {"checkout_url": "https://checkout.example/full"}}, 422)
out = dodo.checkout(t, "u1", "a@b.c", "pro", late)
check("an expired code still sells, at the full price", out == {"url": "https://checkout.example/full"}
      and "discount_codes" not in late.calls[-1][2], str(late.calls))
try:
    dodo.checkout(t, "u1", "a@b.c", "pro", Refusing({}, 502))
    check("Dodo being down isn't hidden by the retry", False)
except dodo.DodoError as e:
    check("Dodo being down isn't hidden by the retry", e.status == 502)
check("the portal opens for a customer", dodo.portal(t, "u1", fake) == {"url": "https://portal.example/p"})
check("no customer, no portal", dodo.portal(FakeTable(), "u2", fake).get("code") == "no_customer")

print("\n%d failed" % len(failures) if failures else "\nall passed")
sys.exit(1 if failures else 0)
