"""A member's agreement to the terms, their newsletter choice, and the paid
plans they wait for.

Three kinds of row in the alerts table, beside the profile and the saved
jobs, so deleting an account (one Query, one BatchWrite) takes them too:

  #consent           version, agreed_at, via
  #email             newsletter, newsletter_at, newsletter_source, unsubscribed_at, email
  #waitlist#<plan>   plan, joined_at, email

and one shared row, user_id "#waitlist", alert_id "#count#pro": how many
of the Pro waitlist's CAPS["pro"] places are taken. A Pro join adds its
row and counts it in one transaction, so the cap holds however many join
at once; deleting an account gives its place back.

None of them carries `active`, so the alert evaluator, which scans for
that attribute, never sees them.

The terms are agreed in the sign-in window or, for members who signed up
before it asked, in a window on their next visit. Until LOCK_FROM they are
only asked; after it, the routes that start something new (BLOCKED) answer
"agreement required" until they agree. Reading, deleting and leaving stay
open, so nobody is held in an account they can't close.

The newsletter is opt-in: the sign-in window's box, the account switch, or
joining a waitlist. Only the account switch and a mail's unsubscribe link
turn it off; signing in again with the box unticked changes nothing.
"""
import os
import time
from datetime import datetime, timezone

# The terms and privacy policy members agree to; bump it with the policy.
VERSION = "2026-10-25"
# When members who haven't agreed lose the routes in BLOCKED. Off (far
# future) until the website's agreement window ships; then set the date,
# seven days after that release, here or in the box's environment.
LOCK_FROM = os.environ.get("OOJ_CONSENT_LOCK_FROM", "9999-12-31")
PLANS = ("basic", "pro")
CONSENT, EMAIL = "#consent", "#email"
WAITLIST = "#waitlist#"
# Places on each plan's waitlist (None: no limit). Pro's are the beta licenses.
CAPS = {"basic": None, "pro": 100}
COUNTER = {"user_id": "#waitlist", "alert_id": "#count#pro"}


class WaitlistFull(Exception):
    pass
REQUIRED = "Agree to the updated Terms of Service and Privacy Policy on oceanofjobs.com to keep using this."

# (method, path prefix): what an account that hasn't agreed can't start.
BLOCKED = (
    ("POST", "/me/apply"), ("PUT", "/me/apply"), ("PATCH", "/me/apply"),
    ("POST", "/me/alerts"), ("PATCH", "/me/alerts/"),
    ("PUT", "/me/saved/"),
    ("POST", "/me/tokens"),
)

# Finishing what already started stays open: an attempt in flight is
# settled, or its credit would never come back, and a refund can be asked.
FINISHING = ("/settle", "/sent", "/result", "/dispute")

_seen: dict[str, float] = {}  # user_id -> when their agreement was last read as current
_SEEN_FOR = 300


def _now(now=None) -> str:
    return (now or datetime.now(timezone.utc)).isoformat()


def _email(claims_email) -> str | None:
    e = str(claims_email or "").strip().lower()
    return e if "@" in e and len(e) <= 254 else None


def state(table, user_id: str) -> dict:
    """What the website needs: has this member agreed to the current
    terms, their newsletter choice, and their waitlists."""
    rows = {}
    for key in (CONSENT, EMAIL):
        rows[key] = table.get_item(Key={"user_id": user_id, "alert_id": key}).get("Item") or {}
    waiting = table.query(KeyConditionExpression="user_id = :u AND begins_with(alert_id, :w)",
                          ExpressionAttributeValues={":u": user_id, ":w": WAITLIST}).get("Items") or []
    c = rows[CONSENT]
    return {
        "agreed": c.get("version") == VERSION,
        "agreed_version": c.get("version"),
        "agreed_at": c.get("agreed_at"),
        "version": VERSION,
        "lock_from": LOCK_FROM,
        "newsletter": bool(rows[EMAIL].get("newsletter")),
        "waitlist": sorted(str(w["plan"]) for w in waiting),
    }


def agree(table, user_id: str, newsletter=None, via: str = "signin", email=None, now=None) -> dict:
    """Records the agreement to the current terms. A ticked newsletter box
    subscribes; an unticked one is left alone (it isn't an unsubscribe)."""
    via = via if via in ("signin", "prompt") else "signin"
    table.put_item(Item={"user_id": user_id, "alert_id": CONSENT, "version": VERSION, "agreed_at": _now(now), "via": via})
    _seen[user_id] = time.time()
    if newsletter is True:
        set_newsletter(table, user_id, True, source="signup" if via == "signin" else "prompt", email=email, now=now)
    return state(table, user_id)


def set_newsletter(table, user_id: str, on: bool, source: str = "settings", email=None, now=None) -> None:
    when = _now(now)
    names, values = {"#n": "newsletter"}, {":n": bool(on)}
    sets = ["#n = :n"]
    if on:
        sets += ["newsletter_at = :t", "newsletter_source = :s"]
        values.update({":t": when, ":s": source})
    else:
        sets.append("unsubscribed_at = :t")
        values[":t"] = when
    mail = _email(email)
    if mail:
        sets.append("email = :e")
        values[":e"] = mail
    table.update_item(Key={"user_id": user_id, "alert_id": EMAIL}, UpdateExpression="SET " + ", ".join(sets),
                      ExpressionAttributeNames=names, ExpressionAttributeValues=values)


def join_waitlist(table, user_id: str, plan: str, email=None, now=None) -> dict:
    """Puts the member on a paid plan's waitlist. Joining also subscribes
    them to the newsletter (the privacy policy says so)."""
    if plan not in PLANS:
        raise ValueError("Pick the Basic or Pro plan.")
    item = {"user_id": user_id, "alert_id": WAITLIST + plan, "plan": plan, "joined_at": _now(now)}
    mail = _email(email)
    if mail:
        item["email"] = mail
    put = {"TableName": table.name, "Item": item, "ConditionExpression": "attribute_not_exists(alert_id)"}
    if CAPS[plan] is None:
        try:
            table.put_item(**{k: v for k, v in put.items() if k != "TableName"})
        except table.meta.client.exceptions.ConditionalCheckFailedException:
            pass  # already waiting: joining twice keeps the first date
    else:
        count = {"TableName": table.name, "Key": COUNTER, "UpdateExpression": "SET n = if_not_exists(n, :z) + :one",
                 "ConditionExpression": "attribute_not_exists(n) OR n < :cap",
                 "ExpressionAttributeValues": {":z": 0, ":one": 1, ":cap": CAPS[plan]}}
        try:
            table.meta.client.transact_write_items(TransactItems=[{"Put": put}, {"Update": count}])
        except table.meta.client.exceptions.TransactionCanceledException as e:
            reasons = [r.get("Code") for r in e.response.get("CancellationReasons") or []]
            if reasons and reasons[0] == "ConditionalCheckFailed":
                pass  # already waiting: not counted twice
            elif len(reasons) > 1 and reasons[1] == "ConditionalCheckFailed":
                raise WaitlistFull(f"The {plan.title()} waitlist is full.") from None
            else:
                raise
    set_newsletter(table, user_id, True, source="waitlist", email=email, now=now)
    return state(table, user_id)


def counts(table) -> dict:
    """Places taken on each capped waitlist, for the website's counter."""
    n = int((table.get_item(Key=COUNTER).get("Item") or {}).get("n", 0))
    return {plan: {"cap": cap, "taken": n if cap else None} for plan, cap in CAPS.items()}


def forget(table, user_id: str) -> None:
    """Deleting the account: the agreement, the newsletter choice and the
    waitlists go with everything else, and a Pro place is given back."""
    gone = table.delete_item(Key={"user_id": user_id, "alert_id": WAITLIST + "pro"}, ReturnValues="ALL_OLD").get("Attributes")
    if gone:
        try:
            table.update_item(Key=COUNTER, UpdateExpression="SET n = n - :one", ConditionExpression="n > :z",
                              ExpressionAttributeValues={":one": 1, ":z": 0})
        except table.meta.client.exceptions.ConditionalCheckFailedException:
            pass
    keys = [CONSENT, EMAIL] + [WAITLIST + plan for plan in PLANS]
    with table.batch_writer() as batch:
        for key in keys:
            batch.delete_item(Key={"user_id": user_id, "alert_id": key})
    _seen.pop(user_id, None)


def blocked(table, user_id: str, method: str, path: str, today=None) -> bool:
    """True when this request starts something new on an account that
    hasn't agreed to the current terms, after LOCK_FROM."""
    if (today or datetime.now(timezone.utc).date().isoformat()) < LOCK_FROM:
        return False
    if not any(method == m and (path == p.rstrip("/") or path.startswith(p)) for m, p in BLOCKED):
        return False
    if path.endswith(FINISHING):
        return False
    if time.time() - _seen.get(user_id, 0) < _SEEN_FOR:
        return False
    c = table.get_item(Key={"user_id": user_id, "alert_id": CONSENT}).get("Item") or {}
    if c.get("version") == VERSION:
        _seen[user_id] = time.time()
        return False
    return True
