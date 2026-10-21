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
        row = self.items[(Key["user_id"], Key["alert_id"])]
        v = ExpressionAttributeValues
        if ":s" in v:  # apply.result
            row.update(status=v[":s"], reason=v[":r"], done_at=v[":t"])
            return
        self.updates += 1
        row["last_used_at"] = v[":t"]

    def delete_item(self, Key=None):
        self.items.pop((Key["user_id"], Key["alert_id"]), None)


table = FakeTable()
handler._alerts_table = table
# The queue checks each job's site, so the routes need a jobs table.
import sqlite3  # noqa: E402
_jobs = sqlite3.connect(":memory:", check_same_thread=False)
_jobs.execute("CREATE TABLE jobs (id TEXT PRIMARY KEY, ats TEXT)")
_jobs.executemany("INSERT INTO jobs VALUES (?, ?)", [("0123456789abcdef", "greenhouse"), ("fedcba9876543210", "greenhouse"),
                                                     ("97602f3e8d77ca9a", "workday")])
handler.get_connection = lambda: _jobs
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

check("a good token is its user, scoped to MCP by default", tokens.verify(table, tok, NOW) == {"user_id": USER, "scope": "mcp"})
check("the first use stamps last_used, a second within the hour does not",
      table.updates == 1 and tokens.verify(table, tok, NOW + timedelta(minutes=5))["user_id"] == USER and table.updates == 1, str(table.updates))
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
try:
    tokens.create(table, USER, "x", 30, NOW, scope="admin")
    check("an unknown scope is refused", False)
except ValueError:
    check("an unknown scope is refused", True)
for i in range(3):
    tokens.create(table, USER, f"t{i}", 30, NOW)
try:
    tokens.create(table, USER, "sixth", 30, NOW)
    check("a sixth token is refused", False)
except ValueError:
    check("a sixth token is refused", True)

for _ in range(3):
    last = tokens.create(table, "u-reconnect", "Chrome extension", None, NOW, scope="extension")
mine = tokens.list_tokens(table, "u-reconnect")
check("connecting the extension again replaces its token instead of adding one",
      len(mine) == 1 and mine[0]["id"] == last["id"] and tokens.verify(table, last["token"], NOW)["scope"] == "extension", repr(mine))
tokens.revoke(table, USER, made["id"])
check("a revoked token stops working at once", tokens.verify(table, tok, NOW) is None)
try:
    tokens.revoke(table, USER, "../x")
    check("revoke refuses an id that is not one", False)
except ValueError:
    check("revoke refuses an id that is not one", True)

# serve.py: where a token may go.
live = tokens.create(table, "u-serve", "mcp", 30)["token"]


def call(path, method="GET", auth=None, body=None):
    raw = json.dumps(body).encode() if body is not None else b""
    environ = {"PATH_INFO": path, "REQUEST_METHOD": method, "wsgi.input": io.BytesIO(raw), "CONTENT_LENGTH": str(len(raw))}
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
status, _ = call("/api/me/apply/usage", auth=live)
check("an MCP token cannot reach the auto-apply routes", status.startswith("403"), status)
status, body = call("/api/me/apply/queue", auth=live)
check("an MCP token reads the auto-apply queue", status.startswith("200") and b'"queue"' in body, status)
for path in ("/api/me/apply/profile", "/api/me/apply/queuex"):
    status, _ = call(path, auth=live)
    check(f"but not {path}", status.startswith("403"), status)
status, body = call("/api/me/apply/queue/0123456789abcdef", "PUT", live)
check("an MCP token cannot queue a job until the user turns on the MCP source",
      status.startswith("403") and b"aa-settings" in body, status + body.decode()[:200])
handler.apply.put_profile(table, "u-serve", {"settings": {"sources": ["board", "mcp"]}})
status, _ = call("/api/me/apply/queue/0123456789abcdef", "PUT", live)
check("and can once it is on", status.startswith("204") and ("u-serve", "#queue#0123456789abcdef") in table.items, status)
status, body = call("/api/me/apply/queue/97602f3e8d77ca9a", "PUT", live)
check("a job on a site the extension can't fill is refused, with the reason",
      status.startswith("422") and b"through Workday yet" in body and ("u-serve", "#queue#97602f3e8d77ca9a") not in table.items, status + body.decode()[:200])
status, _ = call("/api/me/apply/queue/aaaaaaaaaaaaaaaa", "PUT", live)
check("and an unknown job is 404", status.startswith("404"), status)
status, _ = call("/api/me/apply/queue/0123456789abcdef", "DELETE", live)
check("and can take it off again", status.startswith("204") and ("u-serve", "#queue#0123456789abcdef") not in table.items, status)
ext = tokens.create(table, "u-ext", "Chrome extension", None, scope="extension")["token"]
status, body = call("/api/me/apply/usage", auth=ext)
check("an extension token reaches the auto-apply routes", status.startswith("200") and b'"plan": "free"' in body, status + body.decode()[:120])
status, _ = call("/api/me/saved", auth=ext)
check("and saved jobs", status.startswith("200"), status)
for path in ("/api/me/profile", "/api/me/tokens", "/api/me/alerts"):
    status, _ = call(path, auth=ext)
    check(f"but not {path}", status.startswith("403"), status)

# The extension's whole round trip through serve.py and handler.route_apply.
status, body = call("/api/me/apply/profile", "PUT", ext, {"profile": {"contact": {"first_name": "Ada"}, "settings": {"mode": "auto"}}})
check("the extension token saves the application profile", status.startswith("200") and json.loads(body)["profile"]["settings"]["mode"] == "auto", status)
status, body = call("/api/me/apply/profile", auth=ext)
got = json.loads(body)
check("and reads it back with the search preferences", got["profile"]["contact"]["first_name"] == "Ada" and "preferences" in got, repr(got)[:200])
status, _ = call("/api/me/apply/answers", "POST", ext, {"question": "Why us?", "answer": "Because"})
check("saves an answer", status.startswith("204"), status)
status, body = call("/api/me/apply/claim", "POST", ext, {"job_id": "0123456789abcdef", "company": "Acme"})
check("claims a credit", status.startswith("200") and json.loads(body)["remaining"] == 29, status + body.decode())
status, _ = call("/api/me/apply/claim", "POST", ext, {"job_id": "0123456789abcdef"})
check("a second claim on the same job is 409", status.startswith("409"), status)
status, _ = call("/api/me/apply/result", "POST", ext, {"job_id": "0123456789abcdef", "status": "submitted"})
check("reports the result", status.startswith("204"), status)
status, body = call("/api/me/apply/history", auth=ext)
check("the history shows it submitted", json.loads(body)["applied"][0]["status"] == "submitted", body.decode()[:200])
status, _ = call("/api/me/apply/queue/fedcba9876543210", "PUT", ext)
status2, body = call("/api/me/apply/queue", auth=ext)
check("queues and lists a job", status.startswith("204") and json.loads(body)["queue"][0]["job_id"] == "fedcba9876543210", status + status2)
status, _ = call("/api/me/apply", "DELETE", ext)
check("an extension token cannot wipe the auto-apply record", status.startswith("403"), status)
resp = handler.route_apply("u-ext", "DELETE", "", {}, {})
check("the signed-in account's delete removes the profile, history and queue",
      resp["statusCode"] == 204 and not any(k[0] == "u-ext" and k[1].startswith(("#apply_profile", "#applied#", "#queue#")) for k in table.items))

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
