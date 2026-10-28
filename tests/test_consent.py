"""Agreeing to the terms, the newsletter choice, paid plan waitlists, no
lock on accounts that haven't agreed, and the newsletter's unsubscribe link
(api/consent.py and its routes in api/handler.py).

Needs moto (test only):    python -m pip install "moto[dynamodb]==5.1.4"
Run directly, no framework:  python tests/test_consent.py
"""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))
for k, v in {"ALERTS_TABLE": "consent-test", "DATA_BUCKET": "test-bucket", "DATA_KEY": "jobs.db", "AWS_DEFAULT_REGION": "il-central-1",
             "AWS_ACCESS_KEY_ID": "testing", "AWS_SECRET_ACCESS_KEY": "testing", "ALERTS_UNSUBSCRIBE_SECRET": "s3cret"}.items():
    os.environ[k] = v

import boto3  # noqa: E402
from moto import mock_aws  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + str(detail)))
    if not ok:
        failures.append(name)


with mock_aws():
    ddb = boto3.resource("dynamodb", region_name="il-central-1")
    table = ddb.create_table(TableName="consent-test", KeySchema=[{"AttributeName": "user_id", "KeyType": "HASH"},
                                                                  {"AttributeName": "alert_id", "KeyType": "RANGE"}],
                             AttributeDefinitions=[{"AttributeName": "user_id", "AttributeType": "S"},
                                                   {"AttributeName": "alert_id", "AttributeType": "S"}],
                             BillingMode="PAY_PER_REQUEST")
    import consent  # noqa: E402
    import handler  # noqa: E402
    import unsubscribe_token  # noqa: E402
    handler._alerts_table = table

    def call(user, method, path, body=None, email="dana@example.com", query=""):
        claims = {"sub": user, "email": email, "email_verified": "true"} if user else {}
        event = {"rawPath": "/api" + path, "rawQueryString": query, "body": json.dumps(body) if body is not None else "",
                 "headers": {}, "requestContext": {"http": {"method": method}, "authorizer": {"jwt": {"claims": claims}}}}
        r = handler.lambda_handler(event, None)
        try:
            return r["statusCode"], json.loads(r["body"] or "null")
        except json.JSONDecodeError:
            return r["statusCode"], r["body"]

    def row(user, key):
        return table.get_item(Key={"user_id": user, "alert_id": key}).get("Item") or {}

    # Agreeing.
    s, out = call("ann", "GET", "/me/consent")
    check("a member who never agreed reads as not agreed", s == 200 and out["agreed"] is False and out["newsletter"] is False, out)
    s, out = call("ann", "POST", "/me/consent", {"newsletter": False})
    check("agreeing records the current version", out["agreed"] is True and row("ann", "#consent")["version"] == consent.VERSION, out)
    check("an unticked newsletter box subscribes nobody", out["newsletter"] is False and not row("ann", "#email"), row("ann", "#email"))
    s, out = call("ben", "POST", "/me/consent", {"newsletter": True})
    e = row("ben", "#email")
    check("a ticked box subscribes, from sign-up, with the address", out["newsletter"] and e.get("newsletter_source") == "signup"
          and e.get("email") == "dana@example.com", e)
    call("ben", "POST", "/me/consent", {"newsletter": False})
    check("signing in again with the box unticked doesn't unsubscribe", row("ben", "#email").get("newsletter") is True, row("ben", "#email"))
    table.put_item(Item={"user_id": "old", "alert_id": "#consent", "version": "2020-01-01", "agreed_at": "2020-01-01"})
    s, out = call("old", "GET", "/me/consent")
    check("agreeing to an older version isn't agreeing", out["agreed"] is False and out["agreed_version"] == "2020-01-01", out)

    # The newsletter switch.
    s, out = call("ann", "PUT", "/me/email", {"newsletter": True})
    check("the switch subscribes", s == 200 and out["newsletter"] is True and row("ann", "#email")["newsletter_source"] == "settings", out)
    s, out = call("ann", "PUT", "/me/email", {"newsletter": False})
    check("and unsubscribes, keeping when", out["newsletter"] is False and row("ann", "#email").get("unsubscribed_at"), row("ann", "#email"))
    s, out = call("ann", "PUT", "/me/email", {"newsletter": "yes"})
    check("only true or false", s == 400, (s, out))

    # Waitlists: closed, then opened for the rest of these checks.
    s, out = call("cy", "POST", "/me/waitlist", {"plan": "pro"})
    check("a closed waitlist takes no one", s == 403 and out.get("code") == "waitlist_closed" and not row("cy", "#waitlist#pro"), (s, out))
    handler.WAITLIST_OPEN = True
    s, out = call("cy", "POST", "/me/waitlist", {"plan": "pro"})
    first = row("cy", "#waitlist#pro").get("joined_at")
    check("joining a waitlist records the plan", s == 200 and out["waitlist"] == ["pro"] and first, out)
    check("and subscribes to the newsletter, from the waitlist", out["newsletter"] is True
          and row("cy", "#email")["newsletter_source"] == "waitlist", row("cy", "#email"))
    call("cy", "POST", "/me/waitlist", {"plan": "pro"})
    check("joining twice keeps the first date", row("cy", "#waitlist#pro")["joined_at"] == first)
    s, out = call("cy", "POST", "/me/waitlist", {"plan": "enterprise"})
    check("only the paid plans", s == 400, (s, out))
    s, out = call("cy", "POST", "/me/waitlist", {"plan": "basic"})
    check("both plans can be joined", out["waitlist"] == ["basic", "pro"], out)
    check("none of these rows looks like an alert to the evaluator",
          not any("active" in i for i in table.scan()["Items"]))
    check("nor to the alerts list", all(not a["alert_id"].startswith("#") for a in handler.route_list_alerts("cy")["alerts"]))

    # The newsletter's unsubscribe link.
    tok = unsubscribe_token.unsubscribe_token("cy", "#email", secret="s3cret")
    s, page = call(None, "GET", "/alerts/unsubscribe", query=f"u=cy&a=%23email&t={tok}")
    check("the link opens a page with one button, nothing changed yet", s == 200 and "product updates" in page
          and row("cy", "#email")["newsletter"] is True)
    s, out = call(None, "POST", "/alerts/unsubscribe", query=f"u=cy&a=%23email&t={tok}")
    check("its POST unsubscribes without a session", s == 200 and out.get("newsletter") and row("cy", "#email")["newsletter"] is False, out)
    check("and keeps the waitlist", row("cy", "#waitlist#pro").get("plan") == "pro")
    s, out = call(None, "POST", "/alerts/unsubscribe", query="u=cy&a=%23email&t=" + "0" * 32)
    check("a wrong signature changes nothing", s == 403, (s, out))

    # No lock: a change to the terms is announced by email, not agreed again.
    s, out = call("nobody", "POST", "/me/alerts", {"name": "x", "filter": {}})
    check("an account that never agreed can still start something new", s != 403 and out.get("code") != "consent_required", (s, out))
    check("and the state no longer carries a lock date", "lock_from" not in call("nobody", "GET", "/me/consent")[1])

    # The Pro waitlist's cap: counted in the same transaction as the join.
    consent.CAPS["pro"] = 3
    table.delete_item(Key=consent.COUNTER)
    for u in ("p1", "p2"):
        call(u, "POST", "/me/waitlist", {"plan": "pro"})
    s, out = call(None, "GET", "/waitlist")
    check("the public count shows places taken, numbers only", s == 200 and out["pro"] == {"cap": 3, "taken": 2} and out["basic"]["cap"] is None, out)
    call("p1", "POST", "/me/waitlist", {"plan": "pro"})
    check("joining twice counts once", consent.counts(table)["pro"]["taken"] == 2)
    s, _ = call("p3", "POST", "/me/waitlist", {"plan": "pro"})
    s, out = call("p4", "POST", "/me/waitlist", {"plan": "pro"})
    check("the place after the cap is refused", s == 409 and out.get("code") == "waitlist_full", (s, out))
    check("and leaves no row behind", not row("p4", "#waitlist#pro") and consent.counts(table)["pro"]["taken"] == 3)
    s, _ = call("p4", "POST", "/me/waitlist", {"plan": "basic"})
    check("Basic has no cap", s == 200 and row("p4", "#waitlist#basic"))
    call("p2", "DELETE", "/me/consent")
    check("deleting an account gives its Pro place back", consent.counts(table)["pro"]["taken"] == 2)
    s, _ = call("p4", "POST", "/me/waitlist", {"plan": "pro"})
    check("and someone else can take it", s == 200 and row("p4", "#waitlist#pro"))
    consent.CAPS["pro"] = 100

    # The CRM's changes: only with its signature, and the cap still holds.
    import hashlib, hmac, time  # noqa: E401
    def admin(payload, sig=None, ts=None):
        body = json.dumps(payload)
        ts = int(time.time()) if ts is None else ts
        key = hmac.new(b"s3cret", b"ooj-crm-admin-v1", hashlib.sha256).digest()
        good = hmac.new(key, f"{ts}\n{body}".encode(), hashlib.sha256).hexdigest()
        event = {"rawPath": "/api/admin/waitlist", "rawQueryString": "", "body": body,
                 "headers": {"X-OOJ-Time": str(ts), "X-OOJ-Sig": good if sig is None else sig},
                 "requestContext": {"http": {"method": "POST"}, "authorizer": {"jwt": {"claims": {}}}}}
        r = handler.lambda_handler(event, None)
        return r["statusCode"], json.loads(r["body"] or "null")
    check("unsigned admin requests are not found", admin({"op": "cap", "cap": 5}, sig="0" * 64)[0] == 404)
    check("old signatures are not accepted", admin({"op": "cap", "cap": 5}, ts=int(time.time()) - 600)[0] == 404)
    taken = consent.counts(table)["pro"]["taken"]
    s, out = admin({"op": "cap", "cap": taken})
    check("the owner can change the Pro limit", s == 200 and out["counts"]["pro"] == {"cap": taken, "taken": taken}, out)
    s, out = admin({"op": "move", "user_id": "p4", "plan": "pro"})
    check("moving to a full Pro waitlist is refused", s in (400, 409), (s, out))
    s, out = admin({"op": "move", "user_id": "p1", "plan": "basic"})
    check("moving Pro to Basic gives the place back, keeping the join date",
          s == 200 and out["counts"]["pro"]["taken"] == taken - 1 and not row("p1", "#waitlist#pro")
          and row("p1", "#waitlist#basic").get("joined_at"), out)
    s, out = admin({"op": "move", "user_id": "p1", "plan": "pro"})
    check("and back again takes it", s == 200 and out["counts"]["pro"]["taken"] == taken and row("p1", "#waitlist#pro"), out)
    s, _ = admin({"op": "mark", "user_id": "p1", "plan": "pro", "status": "approved"})
    check("approving marks the row", s == 200 and row("p1", "#waitlist#pro").get("status") == "approved")
    s, _ = admin({"op": "mark", "user_id": "nobody", "plan": "pro", "status": "approved"})
    check("but not someone who isn't waiting", s == 400 and not row("nobody", "#waitlist#pro"))
    s, out = admin({"op": "remove", "user_id": "p1", "plan": "pro"})
    check("removing frees the place", s == 200 and out["counts"]["pro"]["taken"] == taken - 1 and not row("p1", "#waitlist#pro"), out)
    s, out = admin({"op": "remove", "user_id": "p1", "plan": "pro"})
    check("removing twice frees it once", out["counts"]["pro"]["taken"] == taken - 1, out)
    admin({"op": "cap", "cap": 100})

    # Deleting the account takes these rows too.
    s, _ = call("cy", "DELETE", "/me/consent")
    left = [i["alert_id"] for i in table.scan()["Items"] if i["user_id"] == "cy"]
    check("deleting the account clears the agreement, the newsletter and the waitlists", s == 204 and not left, left)

print()
print("all passed" if not failures else f"{len(failures)} failed")
sys.exit(1 if failures else 0)
