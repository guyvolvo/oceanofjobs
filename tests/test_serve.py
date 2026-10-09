"""The box's WSGI front door (api/serve.py): what it refuses before the
handler ever runs, and the Cognito token check in front of /api/me/*.

Needs PyJWT with crypto, as the box does:  pip install "pyjwt[crypto]"
Run directly, no framework:  python tests/test_serve.py
"""
import io
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))
for k, v in {"ALERTS_TABLE": "test-alerts", "DATA_BUCKET": "test-bucket", "DATA_KEY": "jobs.db", "AWS_DEFAULT_REGION": "il-central-1",
             "AWS_ACCESS_KEY_ID": "testing", "AWS_SECRET_ACCESS_KEY": "testing"}.items():
    os.environ.setdefault(k, v)

import serve  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failures.append(name)


class Body(io.BytesIO):
    """Fails the test if anything reads it."""

    def read(self, *a):
        raise AssertionError("body was read")


def call(path, method="GET", length=None, auth=None):
    environ = {"PATH_INFO": path, "REQUEST_METHOD": method, "wsgi.input": Body()}
    if length is not None:
        environ["CONTENT_LENGTH"] = str(length)
    if auth:
        environ["HTTP_AUTHORIZATION"] = auth
    got = {}
    body = serve.app(environ, lambda status, headers: got.update(status=status))
    return got["status"], b"".join(body)


status, _ = call("/api/contact", "POST", length=100 * 1024 * 1024)
check("a 100MB body is refused with 413 and never read into memory", status.startswith("413"), status)

geo = {}
serve.app({"PATH_INFO": "/api/geo", "REQUEST_METHOD": "GET", "HTTP_X_VIEWER_COUNTRY": "CH", "wsgi.input": Body()},
          lambda status, headers: geo.update(status=status, headers=dict(headers)))
check("/api/geo tells every edge not to cache one viewer's country",
      geo["status"].startswith("200") and geo["headers"].get("Cache-Control") == "no-store", repr(geo))

status, _ = call("/api/me/profile")
check("/api/me without a token is 401 before the handler runs", status.startswith("401"), status)

status, _ = call("/api/me/profile", auth="Bearer not-a-jwt")
check("/api/me with a garbage token is 401", status.startswith("401"), status)

# The JWT check itself: the only gate in front of /api/me/* on the box.
import jwt  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import rsa  # noqa: E402

key, other = (rsa.generate_private_key(public_exponent=65537, key_size=2048) for _ in range(2))
serve.COGNITO_ISSUER, serve.COGNITO_AUDIENCE = "https://cognito.example/pool", "client-1"
serve._jwks = type("J", (), {"get_signing_key_from_jwt": lambda self, t: type("K", (), {"key": key.public_key()})()})()
now = int(time.time())
good = {"sub": "u1", "iss": serve.COGNITO_ISSUER, "aud": "client-1", "token_use": "id", "exp": now + 600}


def claims(payload, signer=key, alg="RS256"):
    token = jwt.encode(payload, signer if alg != "none" else None, algorithm=alg)
    return serve._claims({"HTTP_AUTHORIZATION": "Bearer " + token})


check("a good ID token passes", (claims(good) or {}).get("sub") == "u1")
check("an expired token is refused", claims(dict(good, exp=now - 60)) is None)
check("another app's audience is refused", claims(dict(good, aud="client-2")) is None)
check("another pool's issuer is refused", claims(dict(good, iss="https://evil.example/pool")) is None)
check("an access token is refused", claims(dict(good, token_use="access")) is None)
check("a token signed by another key is refused", claims(good, signer=other) is None)
check("alg=none is refused", claims(good, alg="none") is None)
check("no Authorization header is no claims", serve._claims({}) is None)

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
