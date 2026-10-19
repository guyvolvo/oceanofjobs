"""Deploy the MCP Worker (infra/mcp-worker.mjs) as otj-mcp, or roll it back.

    python scripts/deploy_mcp_worker.py             # upload, secret, route
    python scripts/deploy_mcp_worker.py --rollback  # delete the route only

A deploy uploads the script with its bindings, sets ORIGIN_KEY, turns
the workers.dev address off and makes sure oceanofjobs.com/mcp* points
at the script, failing open.

ORIGIN_KEY comes from .env (OTJ_ORIGIN_SECRET), which
scripts/rotate_origin_key.py keeps current. Neither it nor the API token
is ever printed.

Rollback deletes the route and leaves the script in place. /mcp then
falls through to CloudFront, whose mcp_unavailable function answers a
JSON-RPC 503 (infra/cloudfront.tf). The same thing happens on its own
when the account's free daily Workers allowance runs out, because the
route fails open. Deploying again brings the route back.
"""

import json
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import cf  # noqa: E402

ACCOUNT = "2f08a903f97b2824af964b0d4a85a1ed"
SCRIPT = "otj-mcp"
PATTERN = "oceanofjobs.com/mcp*"
SOURCE = ROOT / "infra" / "mcp-worker.mjs"
METADATA = {
    "main_module": SOURCE.name,
    "compatibility_date": "2026-09-01",
    "bindings": [
        {"type": "analytics_engine", "name": "MCP_EVENTS", "dataset": "otj_mcp"},
        # Cache misses that may reach the box, per minute per Cloudflare
        # location, whoever is asking. Not keyed on the caller's address.
        {"type": "ratelimit", "name": "ORIGIN_LIMIT", "namespace_id": "1001",
         "simple": {"limit": 120, "period": 60}},
    ],
    "keep_bindings": ["secret_text"],
    "observability": {"enabled": True},
}


def ok(resp: dict, what: str) -> dict:
    if not resp.get("success"):
        sys.exit(f"{what} failed: {json.dumps(resp.get('errors'))}")
    return resp


def upload(metadata: dict = METADATA) -> None:
    boundary = uuid.uuid4().hex
    parts = [
        ("metadata", "metadata.json", "application/json", json.dumps(metadata).encode()),
        (SOURCE.name, SOURCE.name, "application/javascript+module", SOURCE.read_bytes()),
    ]
    body = b""
    for name, filename, ctype, data in parts:
        body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\n"
                 f"Content-Type: {ctype}\r\n\r\n").encode() + data + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/workers/scripts/{SCRIPT}",
        method="PUT", data=body,
        headers={"Authorization": f"Bearer {cf.token()}", "Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            resp = json.load(r)
    except urllib.error.HTTPError as e:
        resp = json.load(e)
    # Analytics Engine needs a one-time opt-in in the dashboard. Until
    # then the Worker runs without it (it skips the write when the binding
    # is missing) and the adoption numbers are not being recorded.
    if not resp.get("success") and any(e.get("code") == 10089 for e in resp.get("errors", [])):
        print("WARNING: Analytics Engine is not enabled on the account, so MCP usage is NOT being recorded.")
        print(f"  Enable it at https://dash.cloudflare.com/{ACCOUNT}/workers/analytics-engine and deploy again.")
        return upload({**metadata, "bindings": [b for b in metadata["bindings"] if b["type"] != "analytics_engine"]})
    ok(resp, "upload")
    print(f"uploaded {SCRIPT} ({SOURCE.stat().st_size} bytes)")


def origin_key() -> str:
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        if line.startswith("OTJ_ORIGIN_SECRET="):
            return line.split("=", 1)[1].strip().strip('"')
    sys.exit("no OTJ_ORIGIN_SECRET in .env")


def routes() -> list[dict]:
    return ok(cf.call("GET", "/zones/{oceanofjobs.com}/workers/routes"), "listing routes")["result"]


def deploy() -> None:
    upload()
    ok(cf.call("PUT", f"/accounts/{ACCOUNT}/workers/scripts/{SCRIPT}/secrets",
               {"name": "ORIGIN_KEY", "text": origin_key(), "type": "secret_text"}), "setting ORIGIN_KEY")
    print("ORIGIN_KEY set from .env")
    ok(cf.call("POST", f"/accounts/{ACCOUNT}/workers/scripts/{SCRIPT}/subdomain", {"enabled": False}),
       "turning off workers.dev")
    print("workers.dev address off")
    want = {"pattern": PATTERN, "script": SCRIPT, "request_limit_fail_open": True}
    existing = next((r for r in routes() if r["pattern"] == PATTERN), None)
    if existing is None:
        ok(cf.call("POST", "/zones/{oceanofjobs.com}/workers/routes", want), "adding the route")
        print(f"route {PATTERN} added, failing open")
    elif existing.get("script") != SCRIPT or not existing.get("request_limit_fail_open"):
        ok(cf.call("PUT", f"/zones/{{oceanofjobs.com}}/workers/routes/{existing['id']}", want), "updating the route")
        print(f"route {PATTERN} updated, failing open")
    else:
        print(f"route {PATTERN} already in place")


def rollback() -> None:
    gone = [r for r in routes() if r["pattern"] == PATTERN]
    for r in gone:
        ok(cf.call("DELETE", f"/zones/{{oceanofjobs.com}}/workers/routes/{r['id']}"), "deleting the route")
    print(f"route {PATTERN} deleted; /mcp now answers CloudFront's 503" if gone else "no route to delete")


if __name__ == "__main__":
    rollback() if "--rollback" in sys.argv[1:] else deploy()
