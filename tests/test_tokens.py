"""Personal access tokens (api/tokens.py) and what serve.py lets one do.

Run directly, no framework:  python tests/test_tokens.py
"""
import io
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))
for k, v in {"ALERTS_TABLE": "test-alerts", "DATA_BUCKET": "test-bucket", "DATA_KEY": "jobs.db", "AWS_DEFAULT_REGION": "il-central-1",
             "AWS_ACCESS_KEY_ID": "testing", "AWS_SECRET_ACCESS_KEY": "testing"}.items():
    os.environ.setdefault(k, v)

import handler  # noqa: E402
import serve  # noqa: E402
import tokens  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failures.append(name)


class FakeTable:
    """The alerts table, keyed (user_id, alert_id), reading its key
    conditions the way DynamoDB does for the two shapes used here."""

    def __init__(self):
        self.items = {}
        self.updates = 0

    @staticmethod
    def _terms(cond):
        expr = cond.get_expression()
        if expr["operator"] == "AND":
            return [t for c in expr["values"] for t in FakeTable._terms(c)]
        return [(expr["operator"], expr["values"][0].name, expr["values"][1])]

    def query(self, KeyConditionExpression=None):
        rows = list(self.items.values())
        for op, name, value in self._terms(KeyConditionExpression):
            rows = [r for r in rows if (r[name] == value if op == "=" else str(r[name]).startswith(value))]
        return {"Items": rows}

    def get_item(self, Key=None):
        item = self.items.get((Key["user_id"], Key["alert_id"]))
        return {"Item": dict(item)} if item else {}

    def put_item(self, Item=None, ConditionExpression=None):
        self.items[(Item["user_id"], Item["alert_id"])] = dict(Item)

    def update_item(self, Key=None, ExpressionAttributeValues=None, **kw):
        self.updates += 1
        self.items[(Key["user_id"], Key["alert_id"])]["last_used_at"] = ExpressionAttributeValues[":t"]

    def delete_item(self, Key=None):
        self.items.pop((Key["user_id"], Key["alert_id"]), None)


table = FakeTable()
handler._alerts_table = table
NOW = datetime(2026, 10, 20, 12, 0, tzinfo=timezone.utc)
USER = "0f1e2d3c-aaaa-bbbb-cccc-1234567890ab"

made = tokens.create(table, USER, "Claude Code laptop", 90, NOW)
tok = made["token"]
check("a token reads ooj_ and names its user", tok.startswith("ooj_") and tokens.parse(tok) == (USER, made["id"]), tok)
stored = list(table.items.values())[0]
check("only the hash is stored, never the token",
      stored["hash"] == tokens.digest(tok) and tok not in json.dumps(stored), repr(stored))
listed = tokens.list_tokens(table, USER)
check("the list shows name, last four and expiry, and no secret",
      len(listed) == 1 and listed[0]["name"] == "Claude Code laptop" and listed[0]["hint"] == tok[-4:]
      and "token" not in listed[0] and "hash" not in listed[0] and listed[0]["expires_at"].startswith("2027-01-18"), repr(listed))

check("a good token is its user", tokens.verify(table, tok, NOW) == USER)
check("the first use stamps last_used, a second within the hour does not",
      table.updates == 1 and tokens.verify(table, tok, NOW + timedelta(minutes=5)) == USER and table.updates == 1, str(table.updates))
check("a token with one character of its secret changed is refused", tokens.verify(table, tok[:-1] + ("A" if tok[-1] != "A" else "B"), NOW) is None)
other = tokens._b64("someone-else")
check("the same id and secret under another user is refused",
      tokens.verify(table, "ooj_" + other + tok[tok.index("."):], NOW) is None)
check("malformed tokens are refused", all(tokens.verify(table, t, NOW) is None
      for t in ("", "ooj_", "ooj_a.b.c", "Bearer x", "ooj_" + "a" * 400, None)))
check("an expired token is refused", tokens.verify(table, tok, NOW + timedelta(days=91)) is None)

forever = tokens.create(table, USER, "", None, NOW)
check("an empty name becomes Token, and no expiry means none", forever["name"] == "Token" and forever["expires_at"] is None, repr(forever))
for bad in (7, "90", 365):
    try:
        tokens.create(table, USER, "x", bad, NOW)
        check(f"expiry {bad!r} is refused", False)
    except ValueError:
        pass
for i in range(3):
    tokens.create(table, USER, f"t{i}", 30, NOW)
try:
    tokens.create(table, USER, "sixth", 30, NOW)
    check("a sixth token is refused", False)
except ValueError:
    check("a sixth token is refused", True)

tokens.revoke(table, USER, made["id"])
check("a revoked token stops working at once", tokens.verify(table, tok, NOW) is None)
try:
    tokens.revoke(table, USER, "../x")
    check("revoke refuses an id that is not one", False)
except ValueError:
    check("revoke refuses an id that is not one", True)

# serve.py: where a token may go.
live = tokens.create(table, "u-serve", "mcp", 30)["token"]


def call(path, method="GET", auth=None):
    environ = {"PATH_INFO": path, "REQUEST_METHOD": method, "wsgi.input": io.BytesIO(b"")}
    if auth:
        environ["HTTP_AUTHORIZATION"] = "Bearer " + auth
    got = {}
    body = serve.app(environ, lambda status, headers: got.update(status=status))
    return got["status"], b"".join(body)


status, body = call("/api/me/saved", auth=live)
check("a token reads its own saved list", status.startswith("200") and b'"saved"' in body, status)
status, _ = call("/api/me/saved/0123456789abcdef", "PUT", auth=live)
check("a token can save a job", status.startswith("204"), status)
check("and the row lands under its own user", ("u-serve", "#saved#0123456789abcdef") in table.items)
for path, method in (("/api/me/profile", "GET"), ("/api/me/alerts", "GET"), ("/api/me/tokens", "GET"),
                     ("/api/me/tokens", "POST"), ("/api/me/dashboard", "GET"), ("/api/me/savedx", "GET")):
    status, _ = call(path, method, auth=live)
    check(f"a token is refused at {method} {path}", status.startswith("403"), status)
status, _ = call("/api/me/saved", auth=live[:-2] + "zz")
check("a wrong token is 401", status.startswith("401"), status)

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
