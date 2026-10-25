"""WSGI entry for the box: `gunicorn serve:app` from this directory.

handler.py speaks API Gateway's HTTP API v2 event shape and nothing
else, on purpose: every route was validated against it, and the same
handler keeps running on Lambda until the box has earned the cutover.
So this turns a WSGI request into that event, calls lambda_handler, and
writes its answer back. No framework.

Two things API Gateway did that a plain WSGI server does not:

- Authorization. The /api/me/* routes read their claims from
  requestContext.authorizer.jwt.claims, which the gateway filled in
  after validating the Cognito ID token. Here the bearer token is
  verified against the pool's JWKS (COGNITO_ISSUER, COGNITO_AUDIENCE)
  and the claims are put in the same place, so the handler is
  unchanged. A missing or bad token on those routes answers 401 before
  the handler runs, as the gateway did. With the two variables unset,
  every /api/me route is 401: safe, not broken.
  A personal access token (ooj_..., api/tokens.py) is the other way in.
  It stands for its user only on the routes its scope lists in
  TOKEN_PATHS; anywhere else under /api/me it answers 403.
- The 29 second timeout. Not reproduced. That ceiling is what turned
  a slow download into an outage.
"""

import base64
import json
import os
from http import HTTPStatus

import tokens
import handler
from handler import lambda_handler

COGNITO_ISSUER = os.environ.get("COGNITO_ISSUER", "")
COGNITO_AUDIENCE = os.environ.get("COGNITO_AUDIENCE", "")
MAX_BODY = 64 * 1024
# A CV upload (user_files.MAX_CV, 5 MB) arrives base64 in JSON: a third more.
MAX_CV_BODY = 7 * 1024 * 1024 + 4096
# What a personal access token may reach, by scope (path prefixes).
TOKEN_PATHS = {
    "mcp": ("/api/me/saved", "/api/me/apply/queue", "/api/me/alerts", "/api/me/profile"),
    "extension": ("/api/me/saved", "/api/me/apply/", "/api/me/storage", "/api/me/cv"),
}
# Which of an mcp token's permissions each of its paths needs.
TOKEN_AREAS = {"/api/me/saved": ("saved", "saved jobs"), "/api/me/apply/queue": ("queue", "auto apply queue"),
               "/api/me/alerts": ("alerts", "alerts"), "/api/me/profile": ("preferences", "search preferences")}

_jwks = None


def _claims(environ: dict) -> dict | None:
    """Verified claims from the request's bearer token, or None."""
    global _jwks
    auth = environ.get("HTTP_AUTHORIZATION", "")
    if not auth.startswith("Bearer "):
        return None
    token = auth[len("Bearer "):].strip()
    if token.startswith(tokens.PREFIX):
        try:
            found = tokens.verify(handler._alerts_table, token)
        except Exception as e:  # noqa: BLE001 -- a table error is "not signed in", not a 500
            print(f"token check failed: {e.__class__.__name__}")
            return None
        if not found:
            return None
        # The address the account had, verified, when the token was made:
        # where an alert the token creates is sent.
        mail = {"email": found["email"], "email_verified": True} if found.get("email") else {}
        perms = {"permissions": found["permissions"]} if "permissions" in found else {}
        return {"sub": found["user_id"], "token_use": "ooj", "scope": found["scope"], **mail, **perms}
    if not (COGNITO_ISSUER and COGNITO_AUDIENCE):
        return None
    try:
        import jwt

        if _jwks is None:
            _jwks = jwt.PyJWKClient(f"{COGNITO_ISSUER}/.well-known/jwks.json", cache_keys=True)
        key = _jwks.get_signing_key_from_jwt(token).key
        claims = jwt.decode(token, key, algorithms=["RS256"], audience=COGNITO_AUDIENCE,
                            issuer=COGNITO_ISSUER)
        # The gateway's authorizer accepted ID tokens by audience; an
        # access token carries client_id instead and would have failed
        # there, so it fails here too.
        if claims.get("token_use") != "id":
            return None
        return claims
    except Exception as e:  # noqa: BLE001 -- any failure is "not signed in"
        print(f"jwt rejected: {e.__class__.__name__}: {e}")
        return None


def _event(environ: dict) -> dict:
    headers = {}
    for k, v in environ.items():
        if k.startswith("HTTP_"):
            headers[k[5:].lower().replace("_", "-")] = v
    for k in ("CONTENT_TYPE", "CONTENT_LENGTH"):
        if environ.get(k):
            headers[k.lower().replace("_", "-")] = environ[k]
    body = ""
    try:
        length = int(environ.get("CONTENT_LENGTH") or 0)
    except ValueError:
        length = 0
    if length:
        body = environ["wsgi.input"].read(length).decode("utf-8", "replace")
    event = {
        "version": "2.0",
        "rawPath": environ.get("PATH_INFO") or "/",
        "rawQueryString": environ.get("QUERY_STRING") or "",
        "headers": headers,
        "body": body,
        "requestContext": {"http": {"method": environ.get("REQUEST_METHOD", "GET"),
                                    "sourceIp": headers.get("cf-connecting-ip")
                                    or environ.get("REMOTE_ADDR", "")}},
    }
    claims = _claims(environ)
    if claims:
        event["requestContext"]["authorizer"] = {"jwt": {"claims": claims}}
    return event


def _permission_refusal(path: str, method: str, claims: dict) -> str | None:
    """Why an mcp token's permissions don't cover this request, or None."""
    if claims.get("token_use") != "ooj" or claims.get("scope") != "mcp":
        return None
    for prefix, (area, label) in TOKEN_AREAS.items():
        if path == prefix or path.startswith(prefix + "/"):
            has = (claims.get("permissions") or {}).get(area, "none")
            need = "read" if method in ("GET", "HEAD") else "write"
            if has == "write" or has == need:
                return None
            return (f"This token can't {'see' if need == 'read' else 'change'} your {label}. Make a token with that "
                    "permission at https://oceanofjobs.com/account#settings")
    return None


def app(environ, start_response):
    # Every real body is a small JSON form; _event reads the whole thing
    # into memory, and nothing upstream caps it below Cloudflare's 100MB.
    try:
        limit = MAX_CV_BODY if environ.get("PATH_INFO") == "/api/me/cv" else MAX_BODY
        too_big = int(environ.get("CONTENT_LENGTH") or 0) > limit
    except ValueError:
        too_big = False
    if too_big:
        start_response("413 Content Too Large", [("Content-Type", "application/json")])
        return [b'{"error": "request body too large"}']
    event = _event(environ)
    path = event["rawPath"]
    if path.startswith("/api/me/") and "authorizer" not in event["requestContext"]:
        start_response("401 Unauthorized", [("Content-Type", "application/json")])
        return [b'{"error": "unauthorized"}']
    claims = event["requestContext"].get("authorizer", {}).get("jwt", {}).get("claims", {})
    if (path.startswith("/api/me/") and claims.get("token_use") == "ooj"
            and not any(path == p or path.startswith(p.rstrip("/") + "/") for p in TOKEN_PATHS.get(claims.get("scope"), ()))):
        start_response("403 Forbidden", [("Content-Type", "application/json")])
        return [b'{"error": "this personal access token cannot use this route"}']
    refused = _permission_refusal(path, event["requestContext"]["http"]["method"], claims)
    if refused:
        start_response("403 Forbidden", [("Content-Type", "application/json")])
        return [json.dumps({"error": refused}).encode()]

    result = lambda_handler(event, None) or {}
    status = int(result.get("statusCode", 500))
    try:
        reason = HTTPStatus(status).phrase
    except ValueError:
        reason = ""
    body = result.get("body") or ""
    if result.get("isBase64Encoded"):
        payload = base64.b64decode(body)
    else:
        payload = body.encode("utf-8") if isinstance(body, str) else body
    headers = [(k, str(v)) for k, v in (result.get("headers") or {}).items()]
    headers.append(("Content-Length", str(len(payload))))
    start_response(f"{status} {reason}", headers)
    return [payload]
