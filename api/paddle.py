"""Paddle's notifications: what gives an account its paid plan.

POST /api/paddle/webhook. Paddle sends subscription and refund events;
this keeps one #plan row per user (apply.py reads it). The checkout
page passes custom_data.user_id (frontend/checkout.html), and Paddle
copies it onto the subscription, so every subscription event names its
user.

Trust comes from the signature: Paddle-Signature is "ts=<unix>;h1=<hex>"
with h1 = HMAC-SHA256(secret, "<ts>:<raw body>"). Requests also have to
come from one of Paddle's published addresses (fetched, never
hard-coded); if that list can't be fetched the signature alone decides.
Events can arrive out of order, so an event older than the one the row
was written from is ignored.

Configured by environment: PADDLE_WEBHOOK_SECRET (the notification
destination's endpoint_secret_key; unset means every request is
refused), PADDLE_ENV ("live" or "sandbox") and optionally PADDLE_PRICES
("pri_x=basic,pri_y=pro") when the live price ids differ from these.
"""

import hashlib
import hmac
import ipaddress
import json
import os
import time
import urllib.request

PRICES = {"pri_01m5c6nb2wc9df6hk0hqkwdr1r": "basic", "pri_01m5c6q394qkj6pfxekj6t37sh": "pro"}
MAX_SKEW_S = 300
IPS_TTL_S = 86400
PLAN_ROW = "#plan"

_ips = {"at": 0.0, "nets": None}


def prices() -> dict:
    extra = os.environ.get("PADDLE_PRICES", "")
    pairs = dict(p.split("=", 1) for p in extra.split(",") if "=" in p)
    return {**PRICES, **{k.strip(): v.strip() for k, v in pairs.items()}}


def verify(header: str, body: str, secret: str, now: float | None = None) -> bool:
    """Whether Paddle signed this body with our secret, recently."""
    if not header or not secret:
        return False
    parts = dict(p.split("=", 1) for p in header.split(";") if "=" in p)
    ts = parts.get("ts", "")
    if not ts.isdigit() or abs((now or time.time()) - int(ts)) > MAX_SKEW_S:
        return False
    want = hmac.new(secret.encode(), f"{ts}:{body}".encode(), hashlib.sha256).hexdigest()
    # During a secret rotation Paddle sends one h1 per secret.
    return any(hmac.compare_digest(want, v) for k, v in (p.split("=", 1) for p in header.split(";") if "=" in p) if k == "h1")


def _paddle_nets(fetch=None) -> list | None:
    if _ips["nets"] is not None and time.time() - _ips["at"] < IPS_TTL_S:
        return _ips["nets"]
    host = "sandbox-api.paddle.com" if os.environ.get("PADDLE_ENV") == "sandbox" else "api.paddle.com"
    try:
        raw = fetch() if fetch else urllib.request.urlopen(f"https://{host}/ips", timeout=5).read()
        nets = [ipaddress.ip_network(c) for c in json.loads(raw)["data"]["ipv4_cidrs"]]
    except Exception as e:  # noqa: BLE001 -- the signature still decides
        print(f"paddle ips not fetched: {e!r}")
        return None
    _ips.update(at=time.time(), nets=nets)
    return nets


def from_paddle(source_ip: str, fetch=None) -> bool:
    nets = _paddle_nets(fetch)
    if nets is None:
        return True
    try:
        ip = ipaddress.ip_address(source_ip)
    except ValueError:
        return False
    return any(ip in n for n in nets)


def cancel_subscription(subscription_id: str, post=None) -> bool:
    """Cancels a subscription in Paddle now. Paddle then sends
    subscription.canceled, which is what moves the user to free. Needs
    PADDLE_API_KEY (scripts/set_box_secret.sh); without it, False."""
    key = os.environ.get("PADDLE_API_KEY", "")
    if not key or not subscription_id:
        return False
    host = "sandbox-api.paddle.com" if os.environ.get("PADDLE_ENV") == "sandbox" else "api.paddle.com"
    req = urllib.request.Request(f"https://{host}/subscriptions/{subscription_id}/cancel",
                                 data=json.dumps({"effective_from": "immediately"}).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    try:
        (post or (lambda r: urllib.request.urlopen(r, timeout=10).read()))(req)
        return True
    except Exception as e:  # noqa: BLE001 -- falls back to the manual cancel the log asks for
        print(f"paddle cancel of {subscription_id} failed: {e!r}")
        return False


def apply_event(table, event: dict, post=None) -> str:
    """Updates the user's #plan row from one event. Returns what it did,
    for the log and the tests."""
    kind = event.get("event_type") or ""
    data = event.get("data") or {}
    at = event.get("occurred_at") or ""
    if kind.startswith("subscription."):
        user_id = (data.get("custom_data") or {}).get("user_id")
        if not user_id:
            return f"{kind}: no user_id in custom_data, ignored"
        plan = next((prices().get((i.get("price") or {}).get("id")) for i in data.get("items") or []
                     if prices().get((i.get("price") or {}).get("id"))), None)
        row = {"user_id": user_id, "alert_id": PLAN_ROW, "plan": plan or "free",
               "status": data.get("status") or "", "subscription_id": data.get("id") or "",
               "customer_id": data.get("customer_id") or "",
               "period_end": ((data.get("current_billing_period") or {}).get("ends_at") or ""), "event_at": at}
        try:
            table.put_item(Item=row, ConditionExpression="attribute_not_exists(event_at) OR event_at <= :at",
                           ExpressionAttributeValues={":at": at})
        except table.meta.client.exceptions.ConditionalCheckFailedException:
            return f"{kind}: older than the stored event, ignored"
        return f"{kind}: {user_id} is {row['plan']} ({row['status']})"
    if kind in ("adjustment.created", "adjustment.updated"):
        if data.get("action") == "refund" and data.get("status") == "approved":
            # The refund policy says a refund ends the plan, but Paddle refunds
            # and cancels separately: left alone, a refunded customer keeps
            # the plan and is charged again at renewal.
            sub = data.get("subscription_id") or ""
            if cancel_subscription(sub, post):
                return f"{kind}: refund for {sub}, canceled in Paddle"
            print(f"REFUND: cancel subscription {sub} in Paddle by hand")
            return f"{kind}: refund for {sub}, cancel it in Paddle"
        return f"{kind}: not a refund"
    return f"{kind}: not handled"


def handle(table, headers: dict, body: str, source_ip: str, fetch=None) -> tuple[int, dict]:
    secret = os.environ.get("PADDLE_WEBHOOK_SECRET", "")
    if not secret:
        return 503, {"error": "payments are not configured"}
    if not from_paddle(source_ip, fetch):
        return 403, {"error": "not from Paddle"}
    if not verify(headers.get("paddle-signature", ""), body, secret):
        return 401, {"error": "bad signature"}
    try:
        event = json.loads(body)
    except ValueError:
        return 400, {"error": "not JSON"}
    done = apply_event(table, event)
    print(f"paddle {event.get('event_id', '')}: {done}")
    return 200, {"ok": True}
