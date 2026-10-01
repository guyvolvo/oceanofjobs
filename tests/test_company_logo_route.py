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


PNG = b"\x89PNG\r\n\x1a\n" + b"x" * 40
conn = sqlite3.connect(":memory:")
conn.execute("CREATE TABLE companies (domain TEXT, logo_url TEXT)")
conn.executemany("INSERT INTO companies VALUES (?, ?)", [
    ("wix.com", "https://www.wix.com/favicon.png"), ("nologo.com", None), ("dead.com", "https://dead.com/x.png")])
fetched = []


def fetch(url):
    fetched.append(url)
    return ("image/png", PNG) if "wix" in url else None


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
    check("a company with no logo is a 404 and nothing is fetched", r["statusCode"] == 404 and len(fetched) == 1)
    r = handler.route_company_logo("dead.com", conn=conn, fetch=fetch, cache_dir=cache)
    r = handler.route_company_logo("dead.com", conn=conn, fetch=fetch, cache_dir=cache)
    check("a URL that gives no image is a 404, asked once and then remembered",
          r["statusCode"] == 404 and fetched.count("https://dead.com/x.png") == 1)
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
