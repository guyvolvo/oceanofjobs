"""Copies ALERTS_UNSUBSCRIBE_SECRET from the box into the repo .env, so the
CRM signs unsubscribe links the box accepts. Never prints the value.

    python scripts/copy_unsubscribe_secret.py

Needs the openmarket-tf AWS profile and gh signed in to the repo.
"""
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
P = ["--profile", "openmarket-tf", "--region", "il-central-1", "--output", "json"]
NAME = "ALERTS_UNSUBSCRIBE_SECRET"


def main() -> None:
    inst = subprocess.run("gh variable get BOX_INSTANCE_ID", shell=True, capture_output=True, text=True, cwd=ROOT).stdout.strip()
    if not inst:
        sys.exit("gh variable get BOX_INSTANCE_ID returned nothing")
    cmd = f"grep -h '^{NAME}=' /etc/otj-*.env 2>/dev/null | head -1"
    sent = subprocess.run(["aws", "ssm", "send-command", "--instance-ids", inst, "--document-name", "AWS-RunShellScript",
                           "--parameters", json.dumps({"commands": [cmd]}), *P], capture_output=True, text=True)
    if sent.returncode:
        sys.exit(sent.stderr.strip())
    cid = json.loads(sent.stdout)["Command"]["CommandId"]
    out = ""
    for _ in range(30):
        time.sleep(2)
        r = subprocess.run(["aws", "ssm", "get-command-invocation", "--command-id", cid, "--instance-id", inst, *P], capture_output=True, text=True)
        if r.returncode == 0 and json.loads(r.stdout)["Status"] not in ("Pending", "InProgress", "Delayed"):
            out = json.loads(r.stdout)["StandardOutputContent"]
            break
    value = next((l.split("=", 1)[1].strip().strip("\"'") for l in out.splitlines() if l.startswith(NAME + "=")), "")
    if not value:
        sys.exit(f"{NAME} isn't in any /etc/otj-*.env on the box")
    env = ROOT / ".env"
    keep = [l for l in env.read_text(encoding="utf-8").splitlines() if not l.startswith(NAME + "=")]
    env.write_text("\n".join(keep + [f"{NAME}={value}"]) + "\n", encoding="utf-8")
    print(f"{NAME} written to .env ({len(value)} characters, not shown)")


if __name__ == "__main__":
    main()
