"""Rotate x-otj-origin-key, the header the box's WAF rule requires.

    python scripts/rotate_origin_key.py start    # new key; WAF takes old or new; senders switch
    python scripts/rotate_origin_key.py verify   # what passes and what is blocked, now
    python scripts/rotate_origin_key.py finish   # WAF takes the new key only; old one dropped

Four places hold the key. The WAF rule on box.oceanofjobs.com is the
only one that checks it. Three send it: the otj-box-router Worker's
ORIGIN_KEY secret, CloudFront's origin header (Terraform, from the
OTJ_ORIGIN_SECRET repository secret) and the MCP Worker, whose deploy
reads it from .env.

Between start and finish the rule accepts either key, so each sender
can switch on its own schedule without a request being refused. After
start, run deploy-infra (workflow_dispatch) so CloudFront picks up the
new repository secret, check verify, then finish.

The new key lives in .env (gitignored) as OTJ_ORIGIN_SECRET, the old
one as OTJ_ORIGIN_SECRET_OLD until finish removes it. No key is ever
printed: verify reports lengths and status codes only.
"""

import json
import re
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import cf  # noqa: E402

ACCOUNT = "2f08a903f97b2824af964b0d4a85a1ed"
ENV = ROOT / ".env"
HEADER = "x-otj-origin-key"
BOX = "https://box.oceanofjobs.com/api/health"
RULE_TEMPLATE = 'http.host eq "box.oceanofjobs.com" and not any(http.request.headers["x-otj-origin-key"][*] in {%s})'


def env_get(name: str) -> str:
    for line in ENV.read_text(encoding="utf-8").splitlines():
        if line.startswith(name + "="):
            return line.split("=", 1)[1].strip().strip('"')
    return ""


def env_set(values: dict[str, str | None]) -> None:
    """Set (or, with None, remove) keys in .env, keeping every other line."""
    lines = ENV.read_text(encoding="utf-8").splitlines()
    out, done = [], set()
    for line in lines:
        name = line.split("=", 1)[0]
        if name in values:
            done.add(name)
            if values[name] is not None:
                out.append(f"{name}={values[name]}")
        else:
            out.append(line)
    out += [f"{k}={v}" for k, v in values.items() if k not in done and v is not None]
    ENV.write_text("\n".join(out) + "\n", encoding="utf-8")


def ok(resp: dict, what: str) -> dict:
    if not resp.get("success"):
        sys.exit(f"{what} failed: {resp.get('errors')}")
    return resp


def waf_rule() -> tuple[str, dict]:
    rs = ok(cf.call("GET", "/zones/{oceanofjobs.com}/rulesets/phases/http_request_firewall_custom/entrypoint"),
            "reading the WAF rules")["result"]
    for rule in rs["rules"]:
        if HEADER in rule.get("expression", ""):
            return rs["id"], rule
    sys.exit("no x-otj-origin-key rule on the zone")


def keys_in_rule(rule: dict) -> list[str]:
    return re.findall(r'"([A-Za-z0-9_-]{32,})"', rule["expression"])


def set_rule(keys: list[str]) -> None:
    rs_id, rule = waf_rule()
    body = {"action": rule["action"], "description": rule.get("description", ""), "enabled": True,
            "expression": RULE_TEMPLATE % " ".join(f'"{k}"' for k in keys)}
    ok(cf.call("PATCH", f"/zones/{{oceanofjobs.com}}/rulesets/{rs_id}/rules/{rule['id']}", body), "updating the WAF rule")


def status(url: str, key: str | None) -> tuple[int, str]:
    req = urllib.request.Request(url, headers={"User-Agent": "otj-key-rotation", **({HEADER: key} if key else {})})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.headers.get("x-otj-origin", "")
    except urllib.error.HTTPError as e:
        return e.code, ""


def start() -> None:
    if env_get("OTJ_ORIGIN_SECRET_OLD"):
        sys.exit("a rotation is already under way (OTJ_ORIGIN_SECRET_OLD is set); run verify, then finish")
    old = keys_in_rule(waf_rule()[1])
    if len(old) != 1 or old[0] != env_get("OTJ_ORIGIN_SECRET"):
        sys.exit("the WAF rule and .env disagree about the current key; sort that out first")
    new = secrets.token_urlsafe(32)
    env_set({"OTJ_ORIGIN_SECRET_OLD": old[0], "OTJ_ORIGIN_SECRET": new})
    print("new key generated and saved to .env")
    set_rule([old[0], new])
    print("WAF rule accepts the old key or the new one")
    ok(cf.call("PUT", f"/accounts/{ACCOUNT}/workers/scripts/otj-box-router/secrets",
               {"name": "ORIGIN_KEY", "text": new, "type": "secret_text"}), "setting otj-box-router's ORIGIN_KEY")
    print("otj-box-router sends the new key")
    subprocess.run(["gh", "secret", "set", "OTJ_ORIGIN_SECRET"], input=new, text=True, check=True,
                   cwd=ROOT, stdout=subprocess.DEVNULL)
    print("OTJ_ORIGIN_SECRET repository secret updated")
    print("next: run deploy-infra so CloudFront sends the new key, then verify, then finish")


def verify() -> None:
    new, old = env_get("OTJ_ORIGIN_SECRET"), env_get("OTJ_ORIGIN_SECRET_OLD")
    accepted = keys_in_rule(waf_rule()[1])
    print(f"WAF accepts {len(accepted)} key(s); new key accepted: {new in accepted}; old key accepted: {bool(old) and old in accepted}")
    bust = secrets.token_hex(4)
    checks = [
        ("box, no key (want 403)", status(BOX, None)),
        ("box, wrong key (want 403)", status(BOX, "x" * 43)),
        ("box, new key (want 200)", status(BOX, new)),
    ]
    if old:
        checks.append(("box, old key (200 until finish, then 403)", status(BOX, old)))
    # A fresh query string each time, so the edge cannot answer from cache.
    checks.append(("API through otj-box-router (want 200, origin box)", status(f"https://oceanofjobs.com/api/health?r={bust}", None)))
    checks.append(("API through CloudFront (want 200)", status(f"https://d1zdv0hf0bu0ia.cloudfront.net/api/geo?r={bust}", None)))
    for name, (code, origin) in checks:
        print(f"  {code}  {name}{'  x-otj-origin=' + origin if origin else ''}")


def gh_json(*args: str) -> list[dict]:
    out = subprocess.run(["gh", *args], capture_output=True, text=True, check=True, cwd=ROOT).stdout
    return json.loads(out)


def paths_ok() -> bool:
    bust = secrets.token_hex(4)
    return (status(f"https://oceanofjobs.com/api/health?r={bust}", None)[0] == 200
            and status(f"https://d1zdv0hf0bu0ia.cloudfront.net/api/geo?r={bust}", None)[0] == 200)


def finish() -> None:
    new, old = env_get("OTJ_ORIGIN_SECRET"), env_get("OTJ_ORIGIN_SECRET_OLD")
    if not old:
        sys.exit("no rotation under way")
    # While both keys pass, CloudFront answering proves nothing about
    # which one it sends. What proves it is an apply that ran after the
    # repository secret changed.
    changed = next(s["updatedAt"] for s in gh_json("secret", "list", "--json", "name,updatedAt") if s["name"] == "OTJ_ORIGIN_SECRET")
    applied = gh_json("run", "list", "--workflow", "deploy-infra.yml", "--status", "success", "--json", "createdAt", "-L", "1")
    if not applied or applied[0]["createdAt"] < changed:
        sys.exit("no successful deploy-infra run since the secret changed, so CloudFront may still send the old key")
    if status(BOX, new)[0] != 200 or not paths_ok():
        sys.exit("the new key or one of the API paths is not getting through; the old key stays accepted")
    set_rule([new])
    print("WAF rule narrowed to the new key; checking both API paths")
    for _ in range(6):
        time.sleep(10)
        if not paths_ok():
            set_rule([old, new])
            sys.exit("an API path failed with the new key alone; the rule accepts both keys again")
    env_set({"OTJ_ORIGIN_SECRET_OLD": None})
    print("both API paths still answer; old key removed from .env")
    print(f"old key now gets {status(BOX, old)[0]} (want 403)")


if __name__ == "__main__":
    {"start": start, "verify": verify, "finish": finish}[sys.argv[1] if len(sys.argv) > 1 else "verify"]()
