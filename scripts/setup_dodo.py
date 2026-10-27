"""Connects the box to Dodo Payments (api/dodo.py).

    python scripts/setup_dodo.py            # shows what it would do
    python scripts/setup_dodo.py --apply    # does it

Reads DODO_API_KEY (and DODO_ENV, "live" unless set) from the repo's
.env. Finds the Basic and Pro subscription products by name, makes the
LAUNCH50 code (50% off the first payment, once per customer) and the
webhook to https://oceanofjobs.com/api/dodo/webhook when they don't
exist yet, then writes DODO_API_KEY, DODO_WEBHOOK_SECRET, DODO_ENV,
DODO_PRODUCTS and DODO_DISCOUNT to the box's /etc/otj-api.env over SSM
and restarts the API. No secret is printed; the webhook secret is also
kept in .env.

Needs the openmarket-tf AWS profile and gh signed in to the repo.
"""
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ENV = Path(__file__).resolve().parent.parent / ".env"
HOOK_URL = "https://oceanofjobs.com/api/dodo/webhook"
DISCOUNT = "LAUNCH50"
EVENTS = ["subscription.active", "subscription.updated", "subscription.past_due", "subscription.on_hold", "subscription.paused",
          "subscription.unpaused", "subscription.renewed", "subscription.plan_changed", "subscription.cancelled",
          "subscription.failed", "subscription.expired", "refund.succeeded"]
AWS = ["--profile", "openmarket-tf", "--region", "il-central-1", "--output", "json"]


def read_env() -> dict:
    return {k.strip(): v.strip() for k, v in (l.split("=", 1) for l in ENV.read_text(encoding="utf-8").splitlines()
                                            if "=" in l and not l.startswith("#"))}


def set_env(name: str, value: str) -> None:
    lines = [l for l in ENV.read_text(encoding="utf-8").splitlines() if not l.startswith(name + "=")]
    ENV.write_text("\n".join(lines + [f"{name}={value}"]) + "\n", encoding="utf-8")


env = read_env()
KEY = env.get("DODO_API_KEY", "")
MODE = env.get("DODO_ENV", "live")
HOST = "https://live.dodopayments.com" if MODE == "live" else "https://test.dodopayments.com"


def call(method: str, path: str, body=None) -> dict:
    req = urllib.request.Request(HOST + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    try:
        return json.loads(urllib.request.urlopen(req, timeout=20).read() or b"{}")
    except urllib.error.HTTPError as e:
        sys.exit(f"Dodo {method} {path}: {e.code} {e.read()[:400].decode(errors='replace')}")


def rows(out: dict) -> list:
    return out.get("items") or out.get("data") or []


def main() -> None:
    apply = "--apply" in sys.argv
    if not KEY:
        sys.exit("Put DODO_API_KEY in .env first.")
    print(f"Dodo {MODE} mode")

    products = [p for p in rows(call("GET", "/products?page_size=100")) if p.get("is_recurring")]
    for p in products:
        print(f"  product {p['product_id']}: {p.get('name')} {p.get('price')} {p.get('currency')}")
    plans = {}
    for plan in ("basic", "pro"):
        hits = [p for p in products if plan in (p.get("name") or "").lower().split()]
        if len(hits) != 1:
            sys.exit(f"Expected one subscription product named with '{plan}', found {len(hits)}.")
        plans[plan] = hits[0]["product_id"]
    print(f"  plans: {plans}")

    found = [d for d in rows(call("GET", f"/discounts?code={DISCOUNT}")) if (d.get("code") or "").upper() == DISCOUNT]
    print(f"  discount {DISCOUNT}: {'exists' if found else 'to make'}")
    hooks = [h for h in rows(call("GET", "/webhooks")) if h.get("url") == HOOK_URL]
    print(f"  webhook {HOOK_URL}: {'exists' if hooks else 'to make'}")
    if not apply:
        print("Nothing changed. Run with --apply to make what's missing and configure the box.")
        return

    if not found:
        call("POST", "/discounts", {"type": "percentage", "amount": 5000, "code": DISCOUNT, "name": "50% off the first month",
                                    "subscription_cycles": 1, "per_customer_usage_limit": 1, "restricted_to": list(plans.values())})
        print(f"  made {DISCOUNT}")
    if not hooks:
        hooks = [call("POST", "/webhooks", {"url": HOOK_URL, "description": "Ocean of Jobs plans (api/dodo.py)", "filter_types": EVENTS})]
        print("  made the webhook")
    secret = call("GET", f"/webhooks/{hooks[0]['id']}/secret")["secret"]
    set_env("DODO_WEBHOOK_SECRET", secret)
    set_env("DODO_PRODUCTS", ",".join(f"{pid}={plan}" for plan, pid in plans.items()))

    values = {"DODO_API_KEY": KEY, "DODO_WEBHOOK_SECRET": secret, "DODO_ENV": MODE,
              "DODO_PRODUCTS": ",".join(f"{pid}={plan}" for plan, pid in plans.items()), "DODO_DISCOUNT": DISCOUNT}
    for v in values.values():
        if any(c in v for c in "'\"\\$`\n"):
            sys.exit("A value has a quote, backslash, $ or backtick; set it by hand.")
    # As scripts/set_box_secret.sh does: every DODO_ line replaced, the file's owner and mode kept.
    script = ("set -e\nf=/etc/otj-api.env\ngrep -v '^DODO_' $f > $f.new || true\n"
              + "".join(f"echo '{k}={v}' >> $f.new\n" for k, v in values.items())
              + "chmod --reference=$f $f.new && chown --reference=$f $f.new && mv $f.new $f\n")
    script += "systemctl restart otj-api\nsleep 3\nsystemctl is-active otj-api\ngrep -c '^DODO_' $f\n"
    inst = subprocess.run("gh variable get BOX_INSTANCE_ID", shell=True, capture_output=True, text=True).stdout.strip()
    cid = json.loads(subprocess.run(["aws", "ssm", "send-command", "--instance-ids", inst, "--document-name", "AWS-RunShellScript",
                                     "--comment", "set DODO_*", "--parameters", json.dumps({"commands": [script]}), *AWS],
                                    capture_output=True, text=True, check=True).stdout)["Command"]["CommandId"]
    for _ in range(30):
        time.sleep(3)
        r = subprocess.run(["aws", "ssm", "get-command-invocation", "--command-id", cid, "--instance-id", inst, *AWS],
                           capture_output=True, text=True)
        if r.returncode == 0 and json.loads(r.stdout)["Status"] not in ("Pending", "InProgress", "Delayed"):
            out = json.loads(r.stdout)
            print(f"  box: {out['Status']}, {out['StandardOutputContent'].strip()}")
            return
    print("  box: no answer after 90 seconds; check otj-api")


if __name__ == "__main__":
    main()
