"""Sign-in for MCP apps (api/oauth.py) and its routes in handler.py.

Run directly, no framework:  python tests/test_oauth.py
"""
import base64
import hashlib
import json
import os
import sys
import time
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))
for k, v in {"ALERTS_TABLE": "test-alerts", "DATA_BUCKET": "test-bucket", "DATA_KEY": "jobs.db", "AWS_DEFAULT_REGION": "il-central-1",
             "AWS_ACCESS_KEY_ID": "testing", "AWS_SECRET_ACCESS_KEY": "testing"}.items():
    os.environ.setdefault(k, v)

import handler  # noqa: E402
import oauth  # noqa: E402
import tokens  # noqa: E402
import unsubscribe_token  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + str(detail)))
    if not ok:
        failures.append(name)


class Conflict(Exception):
    pass


class Table:
    """The alerts table, as much of it as tokens.py uses, with
    attribute_not_exists honoured on put."""

    class meta:  # noqa: N801
        class client:  # noqa: N801
            class exceptions:  # noqa: N801
                ConditionalCheckFailedException = Conflict

    def __init__(self):
        self.items = {}

    def query(self, KeyConditionExpression=None, **kw):
        expr = KeyConditionExpression.get_expression()
        user = expr["values"][0].get_expression()["values"][1]
        return {"Items": [dict(v) for (u, _), v in self.items.items() if u == user]}

    def get_item(self, Key=None, **kw):
        item = self.items.get((Key["user_id"], Key["alert_id"]))
        return {"Item": dict(item)} if item else {}

    def put_item(self, Item=None, ConditionExpression=None):
        k = (Item["user_id"], Item["alert_id"])
        if ConditionExpression and "attribute_not_exists" in str(ConditionExpression) and k in self.items:
            raise Conflict
        self.items[k] = dict(Item)

    def update_item(self, Key=None, ExpressionAttributeValues=None, **kw):
        self.items[(Key["user_id"], Key["alert_id"])]["last_used_at"] = ExpressionAttributeValues[":t"]

    def delete_item(self, Key=None):
        self.items.pop((Key["user_id"], Key["alert_id"]), None)


def raises(fn, error):
    try:
        fn()
    except oauth.OAuthError as e:
        return e.error == error
    return False


def pkce():
    verifier = base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


unsubscribe_token.SECRET = "test-secret"
CLAUDE = "https://claude.ai/api/mcp/auth_callback"
READ = {a: "read" for a in tokens.AREAS}

# Registration
reg = oauth.register({"redirect_uris": [CLAUDE], "client_name": "Claude", "token_endpoint_auth_method": "none",
                      "grant_types": ["authorization_code", "refresh_token"]})
cid = reg["client_id"]
check("register returns a client_id and echoes the metadata", cid and reg["redirect_uris"] == [CLAUDE] and reg["client_name"] == "Claude")
for bad in (["http://evil.com/cb"], ["javascript:alert(1)"], ["https://a.com/cb#x"], ["https://user@a.com/cb"], [], ["https://a.com/" + "x" * 600], "https://a.com"):
    check(f"register refuses redirect_uris {str(bad)[:40]}", raises(lambda: oauth.register({"redirect_uris": bad}), "invalid_redirect_uri"))
check("a client that asks for a secret is registered as public",
      oauth.register({"redirect_uris": [CLAUDE], "token_endpoint_auth_method": "client_secret_basic"})["token_endpoint_auth_method"] == "none")
check("loopback and app schemes register", all(oauth.register({"redirect_uris": [u]}) for u in
      ("http://localhost:3118/callback", "http://127.0.0.1/callback", "cursor://anysphere.cursor-retrieval/oauth/callback")))
check("a nameless client is named after its redirect host", oauth.register({"redirect_uris": [CLAUDE]})["client_name"] == "claude.ai")

# The client behind a client_id
check("client names the app and its host", oauth.client(cid, CLAUDE) == {"name": "Claude", "host": "claude.ai", "known": True})
check("a redirect the client didn't register is refused", raises(lambda: oauth.client(cid, "https://evil.com/cb"), "invalid_request"))
tampered = cid[:-3] + ("AAA" if not cid.endswith("AAA") else "BBB")
check("a tampered client_id is refused", raises(lambda: oauth.client(tampered, CLAUDE), "invalid_client"))
local = oauth.register({"redirect_uris": ["http://localhost/callback"], "client_name": "Claude Code"})["client_id"]
check("a loopback redirect may use any port", oauth.client(local, "http://localhost:51234/callback")["known"])
check("but not another path", raises(lambda: oauth.client(local, "http://localhost:51234/other"), "invalid_request"))
other = oauth.register({"redirect_uris": ["https://agent.example/cb"], "client_name": "Claude"})["client_id"]
check("an unknown host is flagged", oauth.client(other, "https://agent.example/cb")["known"] is False)

# Authorize, then trade the code
table = Table()
verifier, challenge = pkce()
ask = {"client_id": cid, "redirect_uri": CLAUDE, "response_type": "code", "code_challenge": challenge, "code_challenge_method": "S256",
       "state": "xyz", "resource": oauth.RESOURCE, "permissions": {**READ, "saved": "write"}}
out = oauth.authorize("user-1", "me@example.com", ask)
q = parse_qs(urlsplit(out["redirect"]).query)
check("authorize sends the browser back with code, state and iss", out["redirect"].startswith(CLAUDE + "?")
      and q["state"] == ["xyz"] and q["iss"] == [oauth.ISSUER] and q["code"])
code = q["code"][0]
check("authorize needs PKCE S256", raises(lambda: oauth.authorize("user-1", None, {**ask, "code_challenge_method": "plain"}), "invalid_request"))
check("authorize refuses another resource", raises(lambda: oauth.authorize("user-1", None, {**ask, "resource": "https://x.com/mcp"}), "invalid_target"))
check("authorize needs some permission", raises(lambda: oauth.authorize("user-1", None, {**ask, "permissions": {a: "none" for a in tokens.AREAS}}),
                                                "invalid_request"))
form = {"grant_type": "authorization_code", "code": code, "code_verifier": verifier, "client_id": cid, "redirect_uri": CLAUDE}
check("a wrong verifier is refused", raises(lambda: oauth.token(table, {**form, "code_verifier": pkce()[0]}), "invalid_grant"))
check("another client can't use the code", raises(lambda: oauth.token(table, {**form, "client_id": other}), "invalid_grant"))
check("another redirect can't use the code", raises(lambda: oauth.token(table, {**form, "redirect_uri": "https://claude.ai/x"}), "invalid_grant"))
got = oauth.token(table, form)
found = tokens.verify(table, got["access_token"])
check("the code becomes a working mcp token", got["token_type"] == "Bearer" and got["expires_in"] == 90 * 86400 and found
      and found["user_id"] == "user-1" and found["scope"] == "mcp" and found.get("email") == "me@example.com", got)
check("with the permissions the user chose", found and found["permissions"] == {**READ, "saved": "write"})
listed = tokens.list_tokens(table, "user-1")
check("listed as the app's, named after it", len(listed) == 1 and listed[0]["name"] == "Claude" and listed[0].get("app") is True, listed)
check("a code works once", raises(lambda: oauth.token(table, form), "invalid_grant"))
check("only authorization_code", raises(lambda: oauth.token(table, {**form, "grant_type": "refresh_token"}), "unsupported_grant_type"))
real_time = time.time
v3, c3 = pkce()
old = parse_qs(urlsplit(oauth.authorize("user-1", None, {**ask, "code_challenge": c3})["redirect"]).query)["code"][0]
time.time = lambda: real_time() + oauth.CODE_TTL_S + 1
try:
    check("an expired code is refused", raises(lambda: oauth.token(table, {**form, "code": old, "code_verifier": v3}), "invalid_grant"))
finally:
    time.time = real_time

# Apps are counted apart from the user's own tokens
t2 = Table()
for i in range(3):
    tokens.create(t2, "u", f"mine {i}", None)
for i in range(7):
    v, c = pkce()
    code_i = parse_qs(urlsplit(oauth.authorize("u", None, {**ask, "code_challenge": c})["redirect"]).query)["code"][0]
    oauth.token(t2, {**form, "code": code_i, "code_verifier": v})
rows = tokens.list_tokens(t2, "u")
check("connecting apps keeps at most MAX_APPS and never touches the user's tokens",
      sum(1 for r in rows if r.get("app")) == tokens.MAX_APPS and sum(1 for r in rows if not r.get("app")) == 3, rows)
tokens.create(t2, "u", "mine 4", None)
tokens.create(t2, "u", "mine 5", None)
check("apps don't count toward the user's five tokens", sum(1 for r in tokens.list_tokens(t2, "u") if not r.get("app")) == 5)

# The routes
handler._alerts_table = Table()
v, c = pkce()


def call(path, method="POST", body="", headers=None, claims=None, query=""):
    ev = {"rawPath": path, "rawQueryString": query, "headers": headers or {}, "body": body,
          "requestContext": {"http": {"method": method}}}
    if claims:
        ev["requestContext"]["authorizer"] = {"jwt": {"claims": claims}}
    r = handler.lambda_handler(ev, None)
    return r["statusCode"], json.loads(r["body"] or "null"), r["headers"]


s, b, h = call("/api/oauth/register", body=json.dumps({"redirect_uris": [CLAUDE], "client_name": "Claude"}))
check("POST /api/oauth/register answers 201", s == 201 and b["client_id"] and h.get("Cache-Control") == "no-store", (s, b))
rcid = b["client_id"]
s, b, _ = call("/api/oauth/client", "GET", query=urlencode({"client_id": rcid, "redirect_uri": CLAUDE}))
check("GET /api/oauth/client names the app", s == 200 and b["name"] == "Claude", (s, b))
signed_in = {"sub": "user-2", "token_use": "id", "email": "a@b.co", "email_verified": "true"}
body = json.dumps({**ask, "client_id": rcid, "code_challenge": c})
s, b, _ = call("/api/me/oauth/authorize", body=body, claims={"sub": "user-2", "token_use": "ooj", "scope": "mcp"})
check("a token can't connect an app", s == 403 and b["error"] == "access_denied", (s, b))
s, b, _ = call("/api/me/oauth/authorize", body=body, claims=signed_in)
check("a signed-in user can", s == 200 and b["redirect"].startswith(CLAUDE), (s, b))
rcode = parse_qs(urlsplit(b["redirect"]).query)["code"][0]
s, b, h = call("/api/oauth/token", headers={"content-type": "application/x-www-form-urlencoded"},
               body=urlencode({"grant_type": "authorization_code", "code": rcode, "code_verifier": v, "client_id": rcid, "redirect_uri": CLAUDE}))
check("POST /api/oauth/token takes a form and returns the token", s == 200 and b["access_token"].startswith("ooj_")
      and h.get("Cache-Control") == "no-store", (s, b))
s, b, _ = call("/api/oauth/token", headers={"content-type": "application/x-www-form-urlencoded"},
               body=urlencode({"grant_type": "authorization_code", "code": rcode, "code_verifier": v, "client_id": rcid}))
check("and the second try is invalid_grant", s == 400 and b["error"] == "invalid_grant", (s, b))
s, b, _ = call("/api/oauth/token", body="not json", headers={"content-type": "application/json"})
check("a bad body is invalid_request", s == 400 and b["error"] == "invalid_request", (s, b))
unsubscribe_token.SECRET = ""
s, b, _ = call("/api/oauth/register", body=json.dumps({"redirect_uris": [CLAUDE]}))
check("without the secret the routes answer 503", s == 503, (s, b))
unsubscribe_token.SECRET = "test-secret"

import serve  # noqa: E402
check("serve.py keeps tokens off /api/me/oauth", not any("/api/me/oauth".startswith(p) for p in serve.TOKEN_PATHS["mcp"] + serve.TOKEN_PATHS["extension"]))

print(f"\n{'FAILED: ' + ', '.join(failures) if failures else 'all passed'}")
sys.exit(1 if failures else 0)
