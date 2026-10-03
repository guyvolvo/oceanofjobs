"""The fixes from the 2026-10-03 security review.

1. A logo is served only when its bytes match its declared image type,
   with nosniff and a sandbox CSP, so an SVG or anything else opened as a
   page runs nothing.
2. The 404 pages never echo the requested path into markup.
4. Alerts only mail an address the account has confirmed.
5. A logo fetch has a total deadline and a cap on fetches at once.
(3, the stats page, is checked in the browser by tests/e2e/security_stats.mjs.)

Run directly, no framework:  python tests/test_security_fixes.py
"""
import json
import os
import sqlite3
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))
for k, v in {"ALERTS_TABLE": "test-alerts", "DATA_BUCKET": "test-bucket", "DATA_KEY": "jobs.db",
             "AWS_DEFAULT_REGION": "il-central-1", "AWS_ACCESS_KEY_ID": "testing",
             "AWS_SECRET_ACCESS_KEY": "testing"}.items():
    os.environ.setdefault(k, v)

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failures.append(name)


import company_page  # noqa: E402
import handler  # noqa: E402
import job_page  # noqa: E402
import page_chrome  # noqa: E402

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
SVG = b'<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
HTML = b"<html><script>alert(document.domain)</script></html>"

# 1. What a logo may be.
ok = handler._logo_bytes_ok
check("a real PNG passes", ok("image/png", PNG))
check("HTML labelled as PNG is refused", not ok("image/png", HTML))
check("an SVG labelled as SVG passes (served sandboxed)", ok("image/svg+xml", SVG))
check("HTML labelled as SVG is refused", not ok("image/svg+xml", HTML))
check("an unknown image type is refused", not ok("image/x-weird", PNG))
check("a WebP and an ICO pass", ok("image/webp", b"RIFF\x00\x00\x00\x00WEBPVP8 ") and ok("image/x-icon", b"\x00\x00\x01\x00\x01\x00"))
r = handler._logo_response("image/svg+xml", SVG)
h = r["headers"]
check("logo responses are nosniff and sandboxed",
      h.get("X-Content-Type-Options") == "nosniff" and "sandbox" in h.get("Content-Security-Policy", "")
      and "default-src 'none'" in h.get("Content-Security-Policy", ""), repr(h))

db = Path(tempfile.mkdtemp()) / "jobs.db"
c = sqlite3.connect(db)
c.executescript("CREATE TABLE companies (domain TEXT PRIMARY KEY, logo_url TEXT);"
                "INSERT INTO companies VALUES ('evil.example', 'https://evil.example/x.svg');"
                "INSERT INTO companies VALUES ('good.example', 'https://good.example/x.png');")
c.commit()
cache = Path(tempfile.mkdtemp())
calls = []


def fetch(url):
    calls.append(url)
    return ("image/png", PNG) if "good" in url else None


resp = handler.route_company_logo("good.example", conn=c, fetch=fetch, cache_dir=cache)
check("a good logo is served with the guard headers", resp["statusCode"] == 200
      and resp["headers"].get("X-Content-Type-Options") == "nosniff", repr(resp["headers"]))
# A cache entry written before the fix: HTML under an image label.
import hashlib  # noqa: E402
key = hashlib.sha1(b"evil.example").hexdigest()
(cache / f"{key}.bin").write_bytes(HTML)
(cache / f"{key}.ct").write_text("image/png", encoding="utf-8")
calls.clear()
resp = handler.route_company_logo("evil.example", conn=c, fetch=fetch, cache_dir=cache)
check("a cached file whose bytes do not match its type is not served from the cache",
      resp["statusCode"] == 404 and calls, f"{resp['statusCode']} calls={calls}")

# 5. Fetches at once, and the total deadline.
handler._logo_fetch_permits = threading.BoundedSemaphore(2)
held = [handler._logo_fetch_permits.acquire(blocking=False) for _ in range(2)]
t0 = time.monotonic()
resp = handler.route_company_logo("good.example", conn=c, fetch=fetch,
                                  cache_dir=Path(tempfile.mkdtemp()))
check("with both fetch permits taken a cold logo answers 503 within about a second, uncached",
      resp["statusCode"] == 503 and time.monotonic() - t0 < 2 and resp["headers"].get("Cache-Control") == "no-store",
      f"{resp['statusCode']} {time.monotonic() - t0:.1f}s")
for _ in held:
    handler._logo_fetch_permits.release()


class Drip:
    """A response that hands over a byte every half second, forever."""
    status_code = 200
    headers = {"Content-Type": "image/png"}

    class raw:  # noqa: N801
        @staticmethod
        def read(n, decode_content=True):
            time.sleep(0.5)
            return b"\x89"

    def close(self):
        pass


import requests  # noqa: E402
real_get = requests.get
requests.get = lambda *a, **k: Drip()
handler._LOGO_FETCH_DEADLINE_S = 2.0
t0 = time.monotonic()
got = handler._fetch_logo("https://slow.example/x.png")
took = time.monotonic() - t0
requests.get = real_get
check("a host that drips bytes is cut off at the total deadline", got is None and took < 3.5, f"{got!r} after {took:.1f}s")

# 2. The 404 pages.
payload = 'x"><img src=x onerror=alert(1)>'
for name, page in (("job", job_page.render_missing(404, payload)),
                   ("company", company_page.render_missing(payload))):
    check(f"the {name} 404 page carries no markup from the path", "<img src=x onerror" not in page
          and 'x"><img' not in page, page[page.find("canonical"):][:160])
check("the job 404 canonical falls back to the board for an invalid id",
      'rel="canonical" href="https://oceanofjobs.com/board"' in job_page.render_missing(404, payload))
head = page_chrome.head("t", "d", 'https://oceanofjobs.com/job/a"b')
check("the shared head escapes the canonical URL", 'href="https://oceanofjobs.com/job/a&quot;b"' in head)

# 4. Alerts and the confirmed address.
v = handler.email_is_verified
check("email_verified true, as JSON or as the authorizer's string", v({"email_verified": True}) and v({"email_verified": "true"}))
check("email_verified false is refused, in either spelling", not v({"email_verified": False}) and not v({"email_verified": "false"}))
check("no claim: allowed for a federated sign-in, in either identities shape",
      v({"identities": [{"providerName": "Google"}]}) and v({"identities": json.dumps([{"providerName": "Google"}])}))
check("no claim and no federated identity is refused", not v({}))


class FakeTable:
    def __init__(self):
        self.items = []

    def put_item(self, Item):
        self.items.append(Item)


handler._alerts_table = FakeTable()
try:
    handler.route_create_alert({"sub": "u1", "email": "victim@example.com", "email_verified": "false"},
                               {"filter": {"search": "python"}})
    check("an alert for an unconfirmed address is refused", False, "it was created")
except ValueError as e:
    check("an alert for an unconfirmed address is refused", "confirm" in str(e) and not handler._alerts_table.items, str(e))
item = handler.route_create_alert({"sub": "u1", "email": "me@example.com", "email_verified": "true"},
                                  {"filter": {"search": "python"}})
check("an alert for a confirmed address is created", item["email"] == "me@example.com" and len(handler._alerts_table.items) == 1)

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
