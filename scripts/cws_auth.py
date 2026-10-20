"""Chrome Web Store API credentials for .github/workflows/publish-extension.yml.

    python scripts/cws_auth.py            # sign in once, store CWS_REFRESH_TOKEN in .env
    python scripts/cws_auth.py --github   # copy the five CWS_* values from .env to GitHub secrets

Reads CWS_CLIENT_ID and CWS_CLIENT_SECRET (a Google Cloud OAuth client of
type Desktop app, with the Chrome Web Store API enabled) from the repo's
.env, opens Google's consent page, catches the reply on 127.0.0.1 and
writes the refresh token back to .env. Nothing secret is printed. Run it
in your own terminal: the consent page needs your browser.

The OAuth consent screen must be published ("In production"): while it
is in Testing, Google expires the refresh token after seven days.
"""
import http.server
import json
import secrets
import subprocess
import sys
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

ENV = Path(__file__).resolve().parent.parent / ".env"
SCOPE = "https://www.googleapis.com/auth/chromewebstore"
NAMES = ("CWS_CLIENT_ID", "CWS_CLIENT_SECRET", "CWS_REFRESH_TOKEN", "CWS_PUBLISHER_ID", "CWS_ITEM_ID")


def read_env() -> dict:
    return dict(l.split("=", 1) for l in ENV.read_text(encoding="utf-8").splitlines() if "=" in l and not l.startswith("#"))


def set_env(name: str, value: str) -> None:
    lines = [l for l in ENV.read_text(encoding="utf-8").splitlines() if not l.startswith(name + "=")]
    ENV.write_text("\n".join(lines + [f"{name}={value}"]) + "\n", encoding="utf-8")


def sign_in() -> None:
    env = read_env()
    client_id, client_secret = env.get("CWS_CLIENT_ID", "").strip(), env.get("CWS_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        sys.exit("Put CWS_CLIENT_ID and CWS_CLIENT_SECRET in .env first.")
    state = secrets.token_urlsafe(16)
    got: dict = {}

    class Reply(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            got.update(urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query))
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"Done. You can close this tab and go back to the terminal.")

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Reply)
    redirect = f"http://127.0.0.1:{server.server_port}"
    url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
        "client_id": client_id, "redirect_uri": redirect, "response_type": "code", "scope": SCOPE,
        "access_type": "offline", "prompt": "consent", "state": state})
    print("Opening Google's consent page. If it does not open, visit:\n" + url)
    webbrowser.open(url)
    while "code" not in got and "error" not in got:
        server.handle_request()
    if got.get("state", [""])[0] != state:
        sys.exit("The reply did not match this sign-in; run it again.")
    if "error" in got:
        sys.exit(f"Google answered: {got['error'][0]}")
    body = urllib.parse.urlencode({"code": got["code"][0], "client_id": client_id, "client_secret": client_secret,
                                   "redirect_uri": redirect, "grant_type": "authorization_code"}).encode()
    token = json.load(urllib.request.urlopen("https://oauth2.googleapis.com/token", body, timeout=20))
    if "refresh_token" not in token:
        sys.exit("No refresh token came back. Remove the app's access at myaccount.google.com/permissions and run again.")
    set_env("CWS_REFRESH_TOKEN", token["refresh_token"])
    print("CWS_REFRESH_TOKEN written to .env.")


def to_github() -> None:
    env = read_env()
    missing = [n for n in NAMES if not env.get(n, "").strip()]
    if missing:
        sys.exit("Missing in .env: " + ", ".join(missing))
    for name in NAMES:
        subprocess.run(["gh", "secret", "set", name], input=env[name].strip(), text=True, check=True)
        print(f"{name} set in GitHub.")


if __name__ == "__main__":
    to_github() if "--github" in sys.argv else sign_in()
