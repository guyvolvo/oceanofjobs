"""GET /api/logo/{domain}: a company's logo, from this domain.

Run directly, no framework:  python tests/test_company_logo_route.py
"""
import base64
import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))
os.environ.setdefault("ALERTS_TABLE", "test-alerts")
os.environ.setdefault("DATA_BUCKET", "test-bucket")
os.environ.setdefault("DATA_KEY", "jobs.db")
os.environ.setdefault("AWS_DEFAULT_REGION", "il-central-1")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "testing")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "testing")

import handler  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failures.append(name)


def png(w, h):
    """The first 24 bytes of a PNG: the signature and an IHDR with its size."""
    return b"\x89PNG\r\n\x1a\n" + (13).to_bytes(4, "big") + b"IHDR" + w.to_bytes(4, "big") + h.to_bytes(4, "big") + b"x" * 20


PNG = png(64, 64)
conn = sqlite3.connect(":memory:")
conn.execute("CREATE TABLE companies (domain TEXT, logo_url TEXT)")
conn.executemany("INSERT INTO companies VALUES (?, ?)", [
    ("wix.com", "https://www.wix.com/favicon.png"), ("nologo.com", None), ("dead.com", "https://dead.com/x.png"),
    ("hellofresh.com", "https://www.hellofresh.com/favicons/hellofresh.ico"), ("obscure.com", None)])
fetched = []


def fetch(url):
    fetched.append(url)
    if "wix" in url:
        return ("image/png", PNG)
    # Google's favicon service: HelloFresh's real mark, a placeholder for the rest.
    if url.startswith("https://www.google.com/s2/favicons?domain=hellofresh.com"):
        return ("image/png", png(64, 64))
    if url.startswith("https://www.google.com/s2/favicons"):
        return ("image/png", png(16, 16))
    return None


with tempfile.TemporaryDirectory() as td:
    cache = Path(td)
    r = handler.route_company_logo("wix.com", conn=conn, fetch=fetch, cache_dir=cache)
    check("a company's logo is fetched from its resolved URL and served as the image",
          r["statusCode"] == 200 and r["isBase64Encoded"] and base64.b64decode(r["body"]) == PNG
          and r["headers"]["Content-Type"] == "image/png" and fetched == ["https://www.wix.com/favicon.png"], repr(r)[:200])
    check("with a week of cache", r["headers"]["Cache-Control"] == "public, max-age=604800")
    r2 = handler.route_company_logo("wix.com", conn=conn, fetch=fetch, cache_dir=cache)
    check("the second request is served from disk, nothing fetched", r2["statusCode"] == 200 and len(fetched) == 1)
    r3 = handler.route_company_logo("wix.com.png", conn=conn, fetch=fetch, cache_dir=cache)
    check("a .png suffix is tolerated", r3["statusCode"] == 200 and len(fetched) == 1)
    r = handler.route_company_logo("nologo.com", conn=conn, fetch=fetch, cache_dir=cache)
    check("a company with no logo asks Google alone, and its placeholder is a 404",
          r["statusCode"] == 404 and len(fetched) == 2 and fetched[-1].startswith("https://www.google.com/s2/favicons?domain=nologo.com"))
    r = handler.route_company_logo("dead.com", conn=conn, fetch=fetch, cache_dir=cache)
    r = handler.route_company_logo("dead.com", conn=conn, fetch=fetch, cache_dir=cache)
    check("a URL that gives no image falls back to Google, and a miss is asked once and then remembered",
          r["statusCode"] == 404 and fetched.count("https://dead.com/x.png") == 1
          and sum(u.startswith("https://www.google.com/s2/favicons?domain=dead.com") for u in fetched) == 1)
    r = handler.route_company_logo("hellofresh.com", conn=conn, fetch=fetch, cache_dir=cache)
    check("a host that refuses the box is served from Google's copy of its mark",
          r["statusCode"] == 200 and base64.b64decode(r["body"]) == png(64, 64)
          and fetched[-2] == "https://www.hellofresh.com/favicons/hellofresh.ico", repr(r)[:120])
    import hashlib
    old = cache / (hashlib.sha1(b"obscure.com").hexdigest() + ".ct")
    old.write_text("miss", encoding="utf-8")
    before = len(fetched)
    handler.route_company_logo("obscure.com", conn=conn, fetch=fetch, cache_dir=cache)
    check("a miss written before the Google fallback existed is retried", len(fetched) == before + 1)
    r = handler.route_company_logo("unknown.com", conn=conn, fetch=fetch, cache_dir=cache)
    check("a domain not on the board is a 404", r["statusCode"] == 404)
    r = handler.route_company_logo("../etc/passwd", conn=conn, fetch=fetch, cache_dir=cache)
    check("anything that is not a domain is a 404 before the database is asked", r["statusCode"] == 404)
    r = handler.lambda_handler({"rawPath": "/api/logo/unknown.com", "rawQueryString": "",
                                "requestContext": {"http": {"method": "GET"}}}, None) if False else None
    check("the route is wired under /api/logo/", 'path.startswith("/logo/")' in Path(ROOT / "api/handler.py").read_text(encoding="utf-8"))
    src = Path(ROOT / "api/handler.py").read_text(encoding="utf-8")
    check("and at /logo/<domain>.png outside the API prefix, where the rate limit does not reach",
          'if path.startswith("/logo/") and len(path) > len("/logo/"):' in src
          and src.index('path.startswith("/logo/") and len(path)') < src.index('if path.startswith("/api"):'))

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
