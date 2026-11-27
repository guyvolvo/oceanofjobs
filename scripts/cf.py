"""A thin Cloudflare API client for the zone moves, reading the token
from .env (CLOUDFLARE_API_TOKEN) and never printing it.

    python scripts/cf.py GET /zones/<id>/dns_records
    python scripts/cf.py POST /zones/<id>/dns_records '{"type":"CNAME",...}'
"""
import json
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ZONES = {"oceanofjobs.com": "820df5408d0b7e9498a9eacc7584b8ce",
         "opentechjobs.org": "b3ba4888acc47a656eb070aca1a65919"}


def env_file() -> Path:
    """The repo's .env; from a git worktree, the main checkout's (worktrees have none)."""
    if (ROOT / ".env").exists():
        return ROOT / ".env"
    common = subprocess.run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    return Path(common).parent / ".env"


def token() -> str:
    for line in env_file().read_text(encoding="utf-8").splitlines():
        if line.startswith("CLOUDFLARE_API_TOKEN="):
            return line.split("=", 1)[1].strip().strip('"')
    sys.exit("no CLOUDFLARE_API_TOKEN in .env")


def call(method: str, path: str, body=None) -> dict:
    for name, zid in ZONES.items():
        path = path.replace("{" + name + "}", zid)
    req = urllib.request.Request(
        "https://api.cloudflare.com/client/v4" + path, method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {token()}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return json.load(e)


if __name__ == "__main__":
    body = json.loads(sys.argv[3]) if len(sys.argv) > 3 else None
    print(json.dumps(call(sys.argv[1], sys.argv[2], body), indent=1))
