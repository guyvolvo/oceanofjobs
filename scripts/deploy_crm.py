"""Deploy the CRM Worker (crm/) as ooj-crm on crm.oceanofjobs.com.

    python scripts/deploy_crm.py             # build, upload, secrets, DNS, route
    python scripts/deploy_crm.py --check     # say what's missing, change nothing
    python scripts/deploy_crm.py --rollback  # delete the route: the host answers nothing

Refuses to add the route until a Cloudflare Access application covers
crm.oceanofjobs.com and its audience tag is the one in .env (CRM_ACCESS_AUD):
the route never exists without Access in front of it. The Worker checks
Access's token itself as well (crm/lib/access.mjs), so a missing Access app
would still serve nothing, but this keeps the order right.

Reads from .env, never prints: CLOUDFLARE_API_TOKEN, CRM_AWS_ACCESS_KEY_ID,
CRM_AWS_SECRET_ACCESS_KEY (scripts/setup_crm_aws.py), ALERTS_UNSUBSCRIBE_SECRET
(the same one the box signs alert unsubscribe links with), CRM_ACCESS_TEAM,
CRM_ACCESS_AUD, and optionally CRM_GITHUB_TOKEN (changelog publishing) and
CRM_SENDING ("on" lets the CRM email members; anything else, only tests).
"""
import base64
import json
import subprocess
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import cf  # noqa: E402

ACCOUNT = "2f08a903f97b2824af964b0d4a85a1ed"
SCRIPT, HOST = "ooj-crm", "crm.oceanofjobs.com"
PATTERN = HOST + "/*"
OWNER = "guyvoloshin@gmail.com"
VARS = {"OWNER_EMAIL": OWNER, "USER_POOL_ID": "il-central-1_0vIcqqXyg", "ALERTS_TABLE": "iljobs-alerts", "CRM_TABLE": "ooj-crm",
        "AWS_REGION": "il-central-1", "MAIL_FROM": "Ocean of Jobs <info@oceanofjobs.com>", "SES_CONFIGURATION_SET": "ooj-marketing",
        "DAILY_CAP": "500"}
SECRETS = {"AWS_ACCESS_KEY_ID": "CRM_AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY": "CRM_AWS_SECRET_ACCESS_KEY",
           "UNSUBSCRIBE_SECRET": "ALERTS_UNSUBSCRIBE_SECRET", "GITHUB_TOKEN": "CRM_GITHUB_TOKEN"}
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml"}


def env() -> dict:
    out = {}
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"')
    return out


def ok(resp: dict, what: str) -> dict:
    if not resp.get("success"):
        sys.exit(f"{what} failed: {json.dumps(resp.get('errors'))}")
    return resp


def access_app(e: dict):
    """The Access application in front of the host, or the reason it isn't ready."""
    if not (e.get("CRM_ACCESS_TEAM") and e.get("CRM_ACCESS_AUD")):
        return None, "CRM_ACCESS_TEAM and CRM_ACCESS_AUD aren't in .env yet"
    apps = cf.call("GET", f"/accounts/{ACCOUNT}/access/apps")
    if not apps.get("success"):
        return None, "the Cloudflare token can't read Access applications"
    for app in apps["result"] or []:
        domains = [app.get("domain", "")] + [d.get("uri", "") if isinstance(d, dict) else d for d in app.get("self_hosted_domains") or []]
        if any(d.split("/")[0] == HOST for d in domains if d):
            if app.get("aud") != e["CRM_ACCESS_AUD"]:
                return None, f"the Access app for {HOST} has a different audience tag than CRM_ACCESS_AUD"
            return app, ""
    return None, f"no Cloudflare Access application covers {HOST}"


def build() -> dict:
    subprocess.run("npx vite build --config vite.crm.config.ts", cwd=ROOT / "apply", shell=True, check=True, capture_output=True)
    dist = ROOT / "crm" / "dist"
    files = {}
    for f in sorted(dist.rglob("*")):
        if not f.is_file():
            continue
        path = "/" + f.relative_to(dist).as_posix()
        if path == "/crm.html":
            path = "/index.html"
        ctype = TYPES.get(f.suffix, "application/octet-stream")
        if ctype.startswith("text/") or ctype == "image/svg+xml":
            files[path] = {"type": ctype, "body": f.read_text(encoding="utf-8")}
        else:
            files[path] = {"type": ctype, "body": base64.b64encode(f.read_bytes()).decode(), "base64": True}
    assert "/index.html" in files, "the build has no page"
    return files


def upload(e: dict, assets: dict, app) -> None:
    modules = [("worker.mjs", (ROOT / "crm" / "worker.mjs").read_bytes())]
    modules += [(f"lib/{p.name}", p.read_bytes()) for p in sorted((ROOT / "crm" / "lib").glob("*.mjs"))]
    modules.append(("assets.mjs", ("export default " + json.dumps(assets) + ";\n").encode()))
    bindings = [{"type": "plain_text", "name": k, "text": v} for k, v in VARS.items()]
    bindings += [{"type": "plain_text", "name": "ACCESS_TEAM", "text": e["CRM_ACCESS_TEAM"]},
                 {"type": "plain_text", "name": "ACCESS_AUD", "text": app["aud"]},
                 {"type": "plain_text", "name": "SENDING", "text": "on" if e.get("CRM_SENDING") == "on" else "off"}]
    bindings += [{"type": "secret_text", "name": name, "text": e[key]} for name, key in SECRETS.items() if e.get(key)]
    metadata = {"main_module": "worker.mjs", "compatibility_date": "2026-09-01", "bindings": bindings, "observability": {"enabled": True}}
    boundary = uuid.uuid4().hex
    body = b""
    for name, data, ctype in [("metadata", json.dumps(metadata).encode(), "application/json")] + [(n, d, "application/javascript+module") for n, d in modules]:
        body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{name}\"\r\n"
                 f"Content-Type: {ctype}\r\n\r\n").encode() + data + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    req = urllib.request.Request(f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/workers/scripts/{SCRIPT}", method="PUT", data=body,
                                 headers={"Authorization": f"Bearer {cf.token()}", "Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            resp = json.load(r)
    except urllib.error.HTTPError as err:
        resp = json.load(err)
    ok(resp, "upload")
    print(f"uploaded {SCRIPT} ({len(body) // 1024} KB), sending to members {'ON' if e.get('CRM_SENDING') == 'on' else 'off'}")


def routes() -> list:
    return ok(cf.call("GET", "/zones/{oceanofjobs.com}/workers/routes"), "listing routes")["result"]


def dns() -> None:
    have = ok(cf.call("GET", f"/zones/{{oceanofjobs.com}}/dns_records?name={HOST}"), "reading DNS")["result"]
    if have:
        print(f"DNS for {HOST} already there")
        return
    # An address that goes nowhere: the Worker answers every request first.
    ok(cf.call("POST", "/zones/{oceanofjobs.com}/dns_records", {"type": "AAAA", "name": HOST, "content": "100::", "proxied": True, "ttl": 1,
                                                                 "comment": "CRM Worker, behind Cloudflare Access"}), "adding DNS")
    print(f"DNS {HOST} added (proxied)")


def check() -> int:
    e = env()
    missing = [k for k in ("CRM_AWS_ACCESS_KEY_ID", "CRM_AWS_SECRET_ACCESS_KEY", "ALERTS_UNSUBSCRIBE_SECRET") if not e.get(k)]
    app, why = access_app(e)
    print("AWS key and unsubscribe secret:", "missing " + ", ".join(missing) if missing else "in .env")
    print("Access:", "ready" if app else why)
    print("Changelog publishing:", "ready" if e.get("CRM_GITHUB_TOKEN") else "CRM_GITHUB_TOKEN not in .env (publishing will say it isn't set up)")
    return 0 if app and not missing else 1


def deploy() -> None:
    e = env()
    if check():
        sys.exit("not deploying: fix the items above first")
    app, _ = access_app(e)
    upload(e, build(), app)
    ok(cf.call("POST", f"/accounts/{ACCOUNT}/workers/scripts/{SCRIPT}/subdomain", {"enabled": False, "previews_enabled": False}), "turning off workers.dev")
    print("workers.dev and preview addresses off")
    dns()
    # Fail closed: over the free quota, the host answers an error, never an origin.
    want = {"pattern": PATTERN, "script": SCRIPT, "request_limit_fail_open": False}
    existing = next((r for r in routes() if r["pattern"] == PATTERN), None)
    if existing is None:
        ok(cf.call("POST", "/zones/{oceanofjobs.com}/workers/routes", want), "adding the route")
    elif existing.get("script") != SCRIPT or existing.get("request_limit_fail_open"):
        ok(cf.call("PUT", f"/zones/{{oceanofjobs.com}}/workers/routes/{existing['id']}", want), "updating the route")
    print(f"route {PATTERN} in place, failing closed")


def rollback() -> None:
    for r in [r for r in routes() if r["pattern"] == PATTERN]:
        ok(cf.call("DELETE", f"/zones/{{oceanofjobs.com}}/workers/routes/{r['id']}"), "deleting the route")
        print(f"route {PATTERN} deleted")


if __name__ == "__main__":
    args = sys.argv[1:]
    sys.exit(check()) if "--check" in args else rollback() if "--rollback" in args else deploy()
