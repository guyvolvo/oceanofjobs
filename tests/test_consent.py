"""Agreeing to the terms, the newsletter choice, paid plan waitlists, the
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
             "AWS_ACCESS_KEY_ID": "testing", "AWS_SECRET_ACCESS_KEY": "testing", "ALERTS_UNSUBSCRIBE_SECRET": "s3cret",
             "OOJ_CONSENT_LOCK_FROM": "2026-11-02"}.items():
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

    # Waitlists.
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

    # The lock.
    B = lambda user, m, p, today: consent.blocked(table, user, m, p, today=today)  # noqa: E731
    check("before the lock date nothing is blocked", not B("nobody", "POST", "/me/apply/attempts", "2026-11-01"))
    check("after it, a new attempt is blocked", B("nobody", "POST", "/me/apply/attempts", "2026-11-02"))
    check("and a new alert, a star and a token", all(B("nobody", m, p, "2026-12-01") for m, p in
                                                   [("POST", "/me/alerts"), ("PATCH", "/me/alerts/a1"), ("PUT", "/me/saved/abc"), ("POST", "/me/tokens")]))
    check("but reading, deleting and leaving are not", not any(B("nobody", m, p, "2026-12-01") for m, p in
                                                         [("GET", "/me/alerts"), ("DELETE", "/me/apply"), ("DELETE", "/me/saved/abc"),
                                                          ("GET", "/me/apply/history"), ("DELETE", "/me/tokens/t1"), ("POST", "/me/consent")]))
    check("nor finishing an attempt already in flight", not any(B("nobody", "POST", f"/me/apply/attempts/x/{a}", "2026-12-01")
                                                                for a in ("settle", "sent", "dispute")))
    check("an account that agreed is never blocked", not B("ann", "POST", "/me/apply/attempts", "2026-12-01"))
    check("nor one that agreed a moment ago", (call("old", "POST", "/me/consent", {}), not B("old", "POST", "/me/apply/attempts", "2026-12-01"))[1])

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

    # Deleting the account takes these rows too.
    s, _ = call("cy", "DELETE", "/me/consent")
    left = [i["alert_id"] for i in table.scan()["Items"] if i["user_id"] == "cy"]
    check("deleting the account clears the agreement, the newsletter and the waitlists", s == 204 and not left, left)

print()
print("all passed" if not failures else f"{len(failures)} failed")
sys.exit(1 if failures else 0)
