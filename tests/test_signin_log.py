"""The sign-in Lambda (github_auth_handler.py) records each email sign-in
code asked for in the CRM's table, for its Sign-in codes log, and a
failed write never fails the sign-in.

Run directly, no framework:  python tests/test_signin_log.py
"""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
for k, v in {"GITHUB_CLIENT_ID": "x", "GITHUB_CLIENT_SECRET": "x", "POOL_NAME": "pool", "SITE_ORIGIN": "https://example.com",
             "AWS_DEFAULT_REGION": "il-central-1", "AWS_ACCESS_KEY_ID": "testing", "AWS_SECRET_ACCESS_KEY": "testing"}.items():
    os.environ.setdefault(k, v)

import github_auth_handler as g  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failures.append(name)


class Table:
    def __init__(self, fail=False):
        self.puts, self.fail = [], fail

    def put_item(self, **kw):
        if self.fail:
            raise RuntimeError("AccessDenied")
        self.puts.append(kw)


g._pool_and_client_ids = lambda: ("pool", "client")
g._ensure_cognito_user = lambda *a: None
start = lambda email: g._handle_email_start({"body": json.dumps({"email": email})})  # noqa: E731

g.dynamodb = t = Table()
r = start(" A@B.co ")
item = t.puts[0]["Item"] if t.puts else {}
check("a code request writes one row to the CRM's table",
      r["statusCode"] == 200 and t.puts and t.puts[0]["TableName"] == "ooj-crm" and item["pk"]["S"] == "signin", repr((r, t.puts)))
check("with the address as typed, lowercased, and the time", item.get("email", {}).get("S") == "a@b.co" and item["sk"]["S"].startswith(item["at"]["S"]))
g.dynamodb = Table(fail=True)
check("a failed write never fails the sign-in", start("a@b.co")["statusCode"] == 200)
g.dynamodb = t = Table()
check("a bad address writes nothing", start("nope")["statusCode"] == 400 and not t.puts)

print("\n%d failed" % len(failures) if failures else "\nall passed")
sys.exit(1 if failures else 0)
