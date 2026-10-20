"""Deploy the Workers AI Worker (infra/ai-worker.mjs) as otj-ai and give
the box its key, without any secret being printed or typed.

    python scripts/deploy_ai_worker.py             # upload, key, route, box key file
    python scripts/deploy_ai_worker.py --rollback  # delete the route only

The key (OOJ_AI_KEY) is made once with secrets.token_urlsafe and kept in
.env (gitignored). The Worker gets it as a secret_text binding; the box
gets it as /var/lib/otj/ai-worker.key (mode 600, owner ubuntu, the API's
user), which api/ai_answers.py reads when it needs it, so the API needs
no restart. The key reaches the box over SSM, so it is in this AWS
account's command history and nowhere else.

Needs the Cloudflare token scripts/cf.py uses, the openmarket-tf AWS
profile and gh signed in to the repo.
"""

import json
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import cf  # noqa: E402

ACCOUNT = "2f08a903f97b2824af964b0d4a85a1ed"
SCRIPT = "otj-ai"
PATTERN = "oceanofjobs.com/__ai"
SOURCE = ROOT / "infra" / "ai-worker.mjs"
ENV = ROOT / ".env"
KEY_FILE = "/var/lib/otj/ai-worker.key"
METADATA = {
    "main_module": SOURCE.name,
    "compatibility_date": "2026-09-01",
    "bindings": [{"type": "ai", "name": "AI"}],
    "keep_bindings": ["secret_text"],
    "observability": {"enabled": True},
}


def ok(resp: dict, what: str) -> dict:
    if not resp.get("success"):
        sys.exit(f"{what} failed: {json.dumps(resp.get('errors'))}")
    return resp


def key() -> str:
    """OOJ_AI_KEY from .env, made and saved there the first time."""
    lines = ENV.read_text(encoding="utf-8").splitlines() if ENV.exists() else []
    for line in lines:
        if line.startswith("OOJ_AI_KEY="):
            return line.split("=", 1)[1].strip().strip('"')
    made = secrets.token_urlsafe(32)
    ENV.write_text("\n".join(lines + [f"OOJ_AI_KEY={made}"]) + "\n", encoding="utf-8")
    print("made OOJ_AI_KEY and saved it to .env")
    return made


def upload() -> None:
    boundary = uuid.uuid4().hex
    body = b""
    for name, filename, ctype, data in (
        ("metadata", "metadata.json", "application/json", json.dumps(METADATA).encode()),
        (SOURCE.name, SOURCE.name, "application/javascript+module", SOURCE.read_bytes()),
    ):
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
    ok(resp, "upload")
    print(f"uploaded {SCRIPT} ({SOURCE.stat().st_size} bytes)")


def to_box(secret: str) -> None:
    """Writes the key file on the box over SSM. The key is passed in the
    command, never echoed back; the output is only a byte count."""
    instance = subprocess.check_output(["gh", "variable", "get", "BOX_INSTANCE_ID"], text=True).strip()
    remote = (f"set -e; umask 077; mkdir -p /var/lib/otj; printf %s '{secret}' > {KEY_FILE}.new; "
              f"chown ubuntu:ubuntu {KEY_FILE}.new; chmod 600 {KEY_FILE}.new; mv {KEY_FILE}.new {KEY_FILE}; "
              f"stat -c '%U %a %s bytes' {KEY_FILE}")
    aws = ["aws", "--profile", "openmarket-tf", "--region", "il-central-1", "ssm"]
    cmd = subprocess.check_output(aws + ["send-command", "--instance-ids", instance, "--document-name", "AWS-RunShellScript",
                                         "--comment", "write ai-worker.key", "--parameters", json.dumps({"commands": [remote]}),
                                         "--query", "Command.CommandId", "--output", "text"], text=True).strip()
    for _ in range(20):
        status = subprocess.run(aws + ["get-command-invocation", "--command-id", cmd, "--instance-id", instance,
                                       "--query", "Status", "--output", "text"], capture_output=True, text=True).stdout.strip()
        if status in ("Success", "Failed", "Cancelled", "TimedOut"):
            break
        time.sleep(3)
    out = subprocess.run(aws + ["get-command-invocation", "--command-id", cmd, "--instance-id", instance,
                                "--query", "StandardOutputContent", "--output", "text"], capture_output=True, text=True).stdout.strip()
    if status != "Success":
        sys.exit(f"writing the key on the box: {status}")
    print(f"box key file: {out}")


def deploy() -> None:
    secret = key()
    upload()
    ok(cf.call("PUT", f"/accounts/{ACCOUNT}/workers/scripts/{SCRIPT}/secrets",
               {"name": "AI_KEY", "text": secret, "type": "secret_text"}), "setting AI_KEY")
    print("AI_KEY set on the Worker")
    ok(cf.call("POST", f"/accounts/{ACCOUNT}/workers/scripts/{SCRIPT}/subdomain", {"enabled": False}),
       "turning off workers.dev")
    want = {"pattern": PATTERN, "script": SCRIPT, "request_limit_fail_open": True}
    existing = next((r for r in ok(cf.call("GET", "/zones/{oceanofjobs.com}/workers/routes"), "listing routes")["result"]
                     if r["pattern"] == PATTERN), None)
    if existing is None:
        ok(cf.call("POST", "/zones/{oceanofjobs.com}/workers/routes", want), "adding the route")
        print(f"route {PATTERN} added")
    else:
        print(f"route {PATTERN} already in place")
    to_box(secret)


def rollback() -> None:
    routes = ok(cf.call("GET", "/zones/{oceanofjobs.com}/workers/routes"), "listing routes")["result"]
    for r in (r for r in routes if r["pattern"] == PATTERN):
        ok(cf.call("DELETE", f"/zones/{{oceanofjobs.com}}/workers/routes/{r['id']}"), "deleting the route")
        print(f"route {PATTERN} deleted")


if __name__ == "__main__":
    rollback() if "--rollback" in sys.argv[1:] else deploy()
