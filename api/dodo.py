"""Dodo Payments: checkout, the customer portal, and the notifications
that give an account its paid plan.

POST /api/me/checkout {"plan": "basic"|"pro"}: a hosted checkout for the
signed-in account (frontend/checkout.html sends the buyer there). Each
account has one Dodo customer, made here on the first checkout and
remembered both ways: on the account (#billing) and under
CUSTOMERS/<customer id>, so a notification finds its account from the
customer even when the checkout's metadata isn't copied onto the
subscription.

POST /api/me/billing: a customer portal link, where the buyer cancels,
changes card and sees invoices.

POST /api/dodo/webhook: Dodo's Standard Webhooks. webhook-signature holds
"v1,<base64>" entries, each HMAC-SHA256 over "<id>.<timestamp>.<raw
body>" keyed with the base64-decoded secret after "whsec_". Subscription
events keep one #plan row per user (apply.plan_of reads it), with Dodo's
statuses in the words that row has always used. A succeeded refund
cancels its subscription now, as the refund policy says. Events can
arrive out of order: one older than the event the row was written from
is ignored.

Configured by environment: DODO_API_KEY, DODO_WEBHOOK_SECRET (unset
means every notification is refused), DODO_ENV ("live" or "test"),
DODO_PRODUCTS ("pdt_x=basic,pdt_y=pro") and DODO_DISCOUNT (a code applied
to every checkout, optional).
"""

import base64
import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.request

PLAN_ROW = "#plan"
BILLING_ROW = "#billing"
# Not a user: the partition that maps a Dodo customer to its account.
CUSTOMERS = "#dodo-customers"
MAX_SKEW_S = 300
SITE = "https://oceanofjobs.com"
# Dodo's statuses in the words the #plan row, apply.plan_of and the CRM
# use. past_due is Dodo's grace period, so the plan stays; on_hold has no
# grace left.
STATUS = {"active": "active", "past_due": "past_due", "on_hold": "on_hold", "paused": "paused",
          "cancelled": "canceled", "expired": "expired", "failed": "failed", "pending": "pending"}


class DodoError(Exception):
    def __init__(self, message: str, status: int = 0):
        super().__init__(message)
        self.status = status


def _host() -> str:
    return "https://live.dodopayments.com" if os.environ.get("DODO_ENV") == "live" else "https://test.dodopayments.com"


def products() -> dict:
    """{product id: plan} from DODO_PRODUCTS."""
    pairs = (p.split("=", 1) for p in os.environ.get("DODO_PRODUCTS", "").split(",") if "=" in p)
    return {k.strip(): v.strip() for k, v in pairs}


def _call(method: str, path: str, body: dict | None = None, send=None) -> dict:
    key = os.environ.get("DODO_API_KEY", "")
    if not key:
        raise DodoError("payments are not configured")
    req = urllib.request.Request(_host() + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    try:
        raw = (send or (lambda r: urllib.request.urlopen(r, timeout=15).read()))(req)
    except urllib.error.HTTPError as e:
        raise DodoError(f"Dodo {method} {path}: {e.code} {e.read()[:300]!r}", e.code) from e
    except OSError as e:
        raise DodoError(f"Dodo {method} {path}: {e!r}") from e
    return json.loads(raw or b"{}")


def customer_for(table, user_id: str, email: str, send=None) -> str:
    """The account's Dodo customer, made on first use."""
    row = table.get_item(Key={"user_id": user_id, "alert_id": BILLING_ROW}).get("Item") or {}
    if row.get("customer_id"):
        return row["customer_id"]
    made = _call("POST", "/customers", {"email": email, "name": email.split("@")[0], "metadata": {"user_id": user_id}}, send)
    cid = made["customer_id"]
    table.put_item(Item={"user_id": CUSTOMERS, "alert_id": cid, "owner": user_id})
    table.put_item(Item={"user_id": user_id, "alert_id": BILLING_ROW, "customer_id": cid})
    return cid


def checkout(table, user_id: str, email: str | None, plan: str, send=None) -> dict:
    """{"url": hosted checkout} for plan, or {"error", "code"}."""
    product = next((p for p, name in products().items() if name == plan), None)
    if not product:
        return {"error": "That plan isn't for sale.", "code": "unknown_plan"}
    if not email:
        return {"error": "Your account needs a confirmed email address to buy a plan.", "code": "no_email"}
    body = {"product_cart": [{"product_id": product, "quantity": 1}],
            "customer": {"customer_id": customer_for(table, user_id, email, send)},
            "metadata": {"user_id": user_id},
            "return_url": f"{SITE}/apply?checkout=done", "cancel_url": f"{SITE}/pricing"}
    if os.environ.get("DODO_DISCOUNT"):
        try:
            return {"url": _call("POST", "/checkouts", {**body, "discount_codes": [os.environ["DODO_DISCOUNT"]]}, send)["checkout_url"]}
        except DodoError as e:
            # The code expired (LAUNCH50 ends 2026-12-31) or ran out: sell at
            # the full price rather than not at all.
            if not 400 <= e.status < 500:
                raise
            print(f"dodo: checkout without {os.environ['DODO_DISCOUNT']}: {e}")
    return {"url": _call("POST", "/checkouts", body, send)["checkout_url"]}


def portal(table, user_id: str, send=None) -> dict:
    """{"url": customer portal} for the account's Dodo customer, or
    {"error", "code"} when it never bought anything."""
    cid = (table.get_item(Key={"user_id": user_id, "alert_id": BILLING_ROW}).get("Item") or {}).get("customer_id")
    if not cid:
        return {"error": "You don't have a paid plan yet.", "code": "no_customer"}
    return {"url": _call("POST", f"/customers/{cid}/customer-portal/session", {}, send)["link"]}


def verify(headers: dict, body: str, secret: str, now: float | None = None) -> bool:
    """Whether Dodo signed this body with our secret, recently."""
    wid, ts, sigs = headers.get("webhook-id", ""), headers.get("webhook-timestamp", ""), headers.get("webhook-signature", "")
    if not (wid and ts.isdigit() and sigs and secret) or abs((now or time.time()) - int(ts)) > MAX_SKEW_S:
        return False
    try:
        key = base64.b64decode(secret.removeprefix("whsec_"))
    except ValueError:
        return False
    want = base64.b64encode(hmac.new(key, f"{wid}.{ts}.{body}".encode(), hashlib.sha256).digest()).decode()
    # Space-separated "v1,<sig>"; during a secret rotation there are two.
    return any(hmac.compare_digest(want, s.split(",", 1)[1]) for s in sigs.split() if s.startswith("v1,"))


def _owner(table, data: dict) -> str | None:
    uid = (data.get("metadata") or {}).get("user_id")
    if uid:
        return uid
    cid = (data.get("customer") or {}).get("customer_id")
    row = table.get_item(Key={"user_id": CUSTOMERS, "alert_id": cid}).get("Item") if cid else None
    return (row or {}).get("owner")


def cancel(subscription_id: str, send=None) -> bool:
    """Cancels a subscription now. Dodo then sends subscription.cancelled,
    which is what moves the user to free."""
    try:
        _call("PATCH", f"/subscriptions/{subscription_id}", {"status": "cancelled"}, send)
        return True
    except DodoError as e:
        print(f"dodo cancel of {subscription_id} failed: {e}")
        return False


def apply_event(table, event: dict, send=None) -> str:
    """Updates the user's #plan row from one event. Returns what it did,
    for the log and the tests."""
    kind = event.get("type") or ""
    data = event.get("data") or {}
    at = event.get("timestamp") or ""
    if kind.startswith("subscription."):
        user_id = _owner(table, data)
        if not user_id:
            return f"{kind}: no account for {data.get('subscription_id')}, ignored"
        plan = products().get(data.get("product_id") or "")
        row = {"user_id": user_id, "alert_id": PLAN_ROW, "plan": plan or "free",
               "status": STATUS.get(data.get("status") or "", data.get("status") or ""),
               "subscription_id": data.get("subscription_id") or "",
               "customer_id": (data.get("customer") or {}).get("customer_id") or "",
               "period_end": data.get("next_billing_date") or "", "event_at": at, "provider": "dodo"}
        try:
            table.put_item(Item=row, ConditionExpression="attribute_not_exists(event_at) OR event_at <= :at",
                           ExpressionAttributeValues={":at": at})
        except table.meta.client.exceptions.ConditionalCheckFailedException:
            return f"{kind}: older than the stored event, ignored"
        return f"{kind}: {user_id} is {row['plan']} ({row['status']})"
    if kind == "refund.succeeded":
        # Dodo refunds a payment and leaves its subscription running: left
        # alone, a refunded customer keeps the plan and is charged again.
        pay = data.get("payment_id") or ""
        try:
            sub = _call("GET", f"/payments/{pay}", None, send).get("subscription_id") or ""
        except DodoError as e:
            print(f"REFUND: payment {pay} not read ({e}); cancel its subscription in Dodo by hand")
            return f"{kind}: {pay} not read, cancel by hand"
        if not sub:
            return f"{kind}: {pay} has no subscription"
        if cancel(sub, send):
            return f"{kind}: refund for {sub}, canceled in Dodo"
        print(f"REFUND: cancel subscription {sub} in Dodo by hand")
        return f"{kind}: refund for {sub}, cancel it in Dodo"
    return f"{kind}: not handled"


def handle(table, headers: dict, body: str, send=None) -> tuple[int, dict]:
    secret = os.environ.get("DODO_WEBHOOK_SECRET", "")
    if not secret:
        return 503, {"error": "payments are not configured"}
    headers = {k.lower(): v for k, v in headers.items()}
    if not verify(headers, body, secret):
        return 401, {"error": "bad signature"}
    try:
        event = json.loads(body)
    except ValueError:
        return 400, {"error": "not JSON"}
    print(f"dodo {headers.get('webhook-id', '')}: {apply_event(table, event, send)}")
    return 200, {"ok": True}
