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

The terms are agreed in the sign-in window when an account is made. A later
change is announced by email (the CRM's account notice) and accepted by
using the service after it takes effect (terms section 13), so nobody is
asked to agree again and no route waits on it.

The newsletter is opt-in: the sign-in window's box, the account switch, or
joining a waitlist. Only the account switch and a mail's unsubscribe link
turn it off; signing in again with the box unticked changes nothing.
"""
from datetime import datetime, timezone

# The terms and privacy policy members agree to; bump it with the policy.
VERSION = "2026-10-25"
PLANS = ("basic", "pro")
CONSENT, EMAIL = "#consent", "#email"
WAITLIST = "#waitlist#"
# Places on each plan's waitlist (None: no limit). Pro's are the beta licenses.
CAPS = {"basic": None, "pro": 100}
COUNTER = {"user_id": "#waitlist", "alert_id": "#count#pro"}


class WaitlistFull(Exception):
    pass
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
        "newsletter": bool(rows[EMAIL].get("newsletter")),
        "waitlist": sorted(str(w["plan"]) for w in waiting),
    }


def agree(table, user_id: str, newsletter=None, via: str = "signin", email=None, now=None) -> dict:
    """Records the agreement to the current terms. A ticked newsletter box
    subscribes; an unticked one is left alone (it isn't an unsubscribe)."""
    via = via if via in ("signin", "prompt") else "signin"
    table.put_item(Item={"user_id": user_id, "alert_id": CONSENT, "version": VERSION, "agreed_at": _now(now), "via": via})
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
        try:
            table.meta.client.transact_write_items(TransactItems=[{"Put": put}, {"Update": _take(table)}])
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


def _take(table) -> dict:
    """Counts one more Pro place, refused at the cap: the owner's own cap
    on the counter row (set_cap) when there is one, else CAPS."""
    return {"TableName": table.name, "Key": COUNTER, "UpdateExpression": "SET n = if_not_exists(n, :z) + :one",
            "ConditionExpression": "attribute_not_exists(n) OR (attribute_not_exists(cap) AND n < :cap) OR n < cap",
            "ExpressionAttributeValues": {":z": 0, ":one": 1, ":cap": CAPS["pro"]}}


def _give_back(table) -> dict:
    return {"TableName": table.name, "Key": COUNTER, "UpdateExpression": "SET n = n - :one", "ConditionExpression": "n > :z",
            "ExpressionAttributeValues": {":one": 1, ":z": 0}}


def counts(table) -> dict:
    """Places taken on each capped waitlist, for the website's counter."""
    row = table.get_item(Key=COUNTER).get("Item") or {}
    out = {plan: {"cap": cap, "taken": None} for plan, cap in CAPS.items()}
    out["pro"] = {"cap": int(row.get("cap", CAPS["pro"])), "taken": int(row.get("n", 0))}
    return out


# The owner's changes, from the CRM through the signed /admin/waitlist
# route (api/handler.py): the CRM can't write members' rows itself.

def _tx(table, items: list) -> list | None:
    """Runs the writes; on a failed condition, each item's cancellation code."""
    try:
        table.meta.client.transact_write_items(TransactItems=items)
        return None
    except table.meta.client.exceptions.TransactionCanceledException as e:
        return [r.get("Code") for r in e.response.get("CancellationReasons") or []]


def remove_from_waitlist(table, user_id: str, plan: str) -> None:
    if plan not in PLANS:
        raise ValueError("Pick the Basic or Pro plan.")
    key = {"user_id": user_id, "alert_id": WAITLIST + plan}
    if CAPS[plan] is None:
        table.delete_item(Key=key)
        return
    # Not on it: nothing to delete, nothing to give back.
    _tx(table, [{"Delete": {"TableName": table.name, "Key": key, "ConditionExpression": "attribute_exists(alert_id)"}},
                {"Update": _give_back(table)}])


def move_waitlist(table, user_id: str, to: str, now=None) -> None:
    """Moves a member between the two waitlists, keeping their join date;
    onto Pro only while there is a place."""
    if to not in PLANS:
        raise ValueError("Pick the Basic or Pro plan.")
    frm = "basic" if to == "pro" else "pro"
    old = table.get_item(Key={"user_id": user_id, "alert_id": WAITLIST + frm}).get("Item")
    if not old:
        raise ValueError(f"They aren't on the {frm.title()} waitlist.")
    new = {**old, "alert_id": WAITLIST + to, "plan": to, "moved_at": _now(now)}
    gone = {"Delete": {"TableName": table.name, "Key": {"user_id": user_id, "alert_id": WAITLIST + frm},
                       "ConditionExpression": "attribute_exists(alert_id)"}}
    if to == "pro":
        reasons = _tx(table, [{"Put": {"TableName": table.name, "Item": new, "ConditionExpression": "attribute_not_exists(alert_id)"}},
                              {"Update": _take(table)}, gone])
        if reasons and reasons[0] == "ConditionalCheckFailed":
            raise ValueError("They're already on the Pro waitlist.")
        if reasons and len(reasons) > 1 and reasons[1] == "ConditionalCheckFailed":
            raise WaitlistFull("The Pro waitlist is full.")
    else:
        reasons = _tx(table, [{"Put": {"TableName": table.name, "Item": new}}, {"Update": _give_back(table)}, gone])
    if reasons and "ConditionalCheckFailed" not in reasons:
        raise RuntimeError(f"moving the waitlist failed: {reasons}")


STATUSES = ("waiting", "approved")


def mark_waitlist(table, user_id: str, plan: str, status: str, now=None) -> None:
    if plan not in PLANS or status not in STATUSES:
        raise ValueError("Unknown plan or status.")
    try:
        table.update_item(Key={"user_id": user_id, "alert_id": WAITLIST + plan}, UpdateExpression="SET #s = :s, status_at = :t",
                          ConditionExpression="attribute_exists(alert_id)", ExpressionAttributeNames={"#s": "status"},
                          ExpressionAttributeValues={":s": status, ":t": _now(now)})
    except table.meta.client.exceptions.ConditionalCheckFailedException:
        raise ValueError(f"They aren't on the {plan.title()} waitlist.") from None


def set_cap(table, cap) -> None:
    if not isinstance(cap, int) or isinstance(cap, bool) or not 0 <= cap <= 100000:
        raise ValueError("The limit must be a whole number from 0.")
    table.update_item(Key=COUNTER, UpdateExpression="SET cap = :c", ExpressionAttributeValues={":c": cap})


def forget(table, user_id: str) -> None:
    """Deleting the account: the agreement, the newsletter choice and the
    waitlists go with everything else, and a Pro place is given back."""
    remove_from_waitlist(table, user_id, "pro")
    keys = [CONSENT, EMAIL] + [WAITLIST + plan for plan in PLANS]
    with table.batch_writer() as batch:
        for key in keys:
            batch.delete_item(Key={"user_id": user_id, "alert_id": key})

