"""Sign-in for apps that use the MCP server (OAuth 2.1, authorization code
with PKCE), so Claude and ChatGPT, which have no place for a token, can
still reach a user's account tools.

The MCP Worker publishes the metadata and answers 401 when an account
tool is called without a token (infra/mcp-worker.mjs). The app then:

1. registers (POST /api/oauth/register) and gets a client_id;
2. sends the user to /account/connect, where they sign in, pick the
   permissions and allow it; that page posts to /api/me/oauth/authorize,
   which answers with the app's redirect URL carrying a code;
3. trades the code and its PKCE verifier for a token
   (POST /api/oauth/token).

The token is an ordinary "mcp" token (tokens.py) marked as an app's, so
everything that checks tokens already handles it, and the user sees and
revokes it with their other tokens.

Nothing here is stored. A client_id is its own registration (the
redirect URIs and the name, signed), and a code is its own grant (user,
client, redirect, PKCE challenge, permissions, expiry, signed). A code is
spent once because the token it makes has an id derived from the code,
and that row can be written only once. Both are signed with a key
derived from ALERTS_UNSUBSCRIBE_SECRET; without it every route here
answers 503.
"""

import base64
import hashlib
import hmac
import json
import re
import time
from urllib.parse import urlencode, urlsplit

import tokens
import unsubscribe_token

ISSUER = "https://oceanofjobs.com"
RESOURCE = ISSUER + "/mcp"
SCOPE = "account"
CODE_TTL_S = 300
TOKEN_DAYS = 90
MAX_REDIRECTS = 5
# Hosts that send sign-ins here on their own; any other redirect gets a
# warning on the consent page.
KNOWN_HOSTS = ("claude.ai", "claude.com", "chatgpt.com")
BAD_SCHEMES = ("javascript", "data", "file", "vbscript", "blob", "about")


class OAuthError(Exception):
    """An RFC 6749 error: its code, and a description for the developer."""

    def __init__(self, error: str, description: str, status: int = 400):
        super().__init__(description)
        self.error, self.description, self.status = error, description, status


class NotConfigured(Exception):
    pass


def _key(label: bytes) -> bytes:
    if not unsubscribe_token.SECRET:
        raise NotConfigured
    return hmac.new(unsubscribe_token.SECRET.encode(), b"ooj-oauth-v1-" + label, hashlib.sha256).digest()


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _sign(label: bytes, payload: dict) -> str:
    body = _b64(json.dumps(payload, separators=(",", ":")).encode())
    return body + "." + _b64(hmac.new(_key(label), body.encode(), hashlib.sha256).digest()[:16])


def _unsign(label: bytes, s) -> dict | None:
    if not isinstance(s, str) or len(s) > 4000 or s.count(".") != 1:
        return None
    body, sig = s.split(".")
    want = _b64(hmac.new(_key(label), body.encode(), hashlib.sha256).digest()[:16])
    if not hmac.compare_digest(want, sig):
        return None
    try:
        out = json.loads(_unb64(body))
    except ValueError:
        return None
    return out if isinstance(out, dict) else None


def _check_redirect(uri) -> str:
    """The redirect URI if it is one an app may register, else OAuthError."""
    if not isinstance(uri, str) or not uri or len(uri) > 500 or any(c.isspace() for c in uri):
        raise OAuthError("invalid_redirect_uri", "each redirect URI is a URL without spaces, at most 500 characters")
    try:
        u = urlsplit(uri)
        u.port  # noqa: B018 -- raises on a bad port
    except ValueError:
        raise OAuthError("invalid_redirect_uri", f"{uri} is not a URL") from None
    scheme = u.scheme.lower()
    if u.fragment or "#" in uri:
        raise OAuthError("invalid_redirect_uri", "a redirect URI has no fragment")
    if scheme == "https":
        if not u.hostname or u.username or u.password:
            raise OAuthError("invalid_redirect_uri", f"{uri} needs a host and no user name")
    elif scheme == "http":
        # Only an app on the user's own computer (RFC 8252 loopback).
        if u.hostname not in ("localhost", "127.0.0.1", "::1"):
            raise OAuthError("invalid_redirect_uri", "http redirect URIs must be localhost or 127.0.0.1")
    elif not re.fullmatch(r"[a-z][a-z0-9+.-]*", scheme) or scheme in BAD_SCHEMES:
        raise OAuthError("invalid_redirect_uri", f"{uri} can't be a redirect URI")
    return uri


def _same_redirect(registered: str, given: str) -> bool:
    """Exact, except a loopback redirect may use any port (RFC 8252 7.3)."""
    if registered == given:
        return True
    a, b = urlsplit(registered), urlsplit(given)
    return (a.scheme == b.scheme == "http" and a.hostname in ("localhost", "127.0.0.1", "::1")
            and a.hostname == b.hostname and a.path == b.path and a.query == b.query)


def register(body) -> dict:
    """Dynamic client registration (RFC 7591), public clients only."""
    if not isinstance(body, dict):
        raise OAuthError("invalid_client_metadata", "send the registration as a JSON object")
    uris = body.get("redirect_uris")
    if not isinstance(uris, list) or not 1 <= len(uris) <= MAX_REDIRECTS:
        raise OAuthError("invalid_redirect_uri", f"redirect_uris is a list of 1 to {MAX_REDIRECTS} URLs")
    uris = [_check_redirect(u) for u in uris]
    # Every client is public and proves itself with PKCE. One that asked for
    # a secret is told "none" (RFC 7591 lets the server choose) rather than
    # refused, since some clients ask for client_secret_basic by default.
    grants = body.get("grant_types", ["authorization_code"])
    if not isinstance(grants, list) or "authorization_code" not in grants:
        raise OAuthError("invalid_client_metadata", "grant_types must include authorization_code")
    name = re.sub(r"[\x00-\x1f\x7f]", "", str(body.get("client_name") or "")).strip()[:tokens.NAME_MAX]
    name = name or urlsplit(uris[0]).hostname or "An app"
    client_id = _sign(b"client", {"r": uris, "n": name})
    return {"client_id": client_id, "client_id_issued_at": int(time.time()), "client_name": name, "redirect_uris": uris,
            "token_endpoint_auth_method": "none", "grant_types": ["authorization_code"], "response_types": ["code"]}


def client(client_id, redirect_uri) -> dict:
    """The app behind a client_id, checked against the redirect URI it
    asked for: {"name", "host", "known"}."""
    c = _unsign(b"client", client_id)
    if not c or not isinstance(c.get("r"), list):
        raise OAuthError("invalid_client", "unknown client_id; register again", 401)
    if not isinstance(redirect_uri, str) or not any(_same_redirect(r, redirect_uri) for r in c["r"]):
        raise OAuthError("invalid_request", "redirect_uri is not one this client registered")
    host = urlsplit(redirect_uri).hostname or urlsplit(redirect_uri).scheme
    known = host in ("localhost", "127.0.0.1", "::1") or any(host == h or host.endswith("." + h) for h in KNOWN_HOSTS)
    return {"name": str(c.get("n") or "An app"), "host": host, "known": known}


def _perms_code(p: dict) -> str:
    return "".join(p[a][0] for a in tokens.AREAS)


def _perms_of(s) -> dict:
    if not isinstance(s, str) or len(s) != len(tokens.AREAS):
        raise ValueError
    return tokens.clean_permissions({a: {"n": "none", "r": "read", "w": "write"}[c] for a, c in zip(tokens.AREAS, s)})


def _client_hash(client_id: str) -> str:
    return _b64(hashlib.sha256(client_id.encode()).digest()[:12])


def authorize(user_id: str, email: str | None, body) -> dict:
    """The signed-in user allowed the app: where to send their browser,
    with a code the app trades for a token."""
    if not isinstance(body, dict):
        raise OAuthError("invalid_request", "send a JSON object")
    redirect_uri = body.get("redirect_uri")
    app = client(body.get("client_id"), redirect_uri)
    if body.get("response_type", "code") != "code":
        raise OAuthError("unsupported_response_type", "response_type is code")
    challenge = body.get("code_challenge")
    if body.get("code_challenge_method") != "S256" or not isinstance(challenge, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", challenge):
        raise OAuthError("invalid_request", "PKCE is required: code_challenge with code_challenge_method S256")
    if body.get("resource") not in (None, "", RESOURCE, RESOURCE + "/"):
        raise OAuthError("invalid_target", f"the only resource here is {RESOURCE}")
    try:
        perms = tokens.clean_permissions(body.get("permissions"))
    except ValueError as e:
        raise OAuthError("invalid_request", str(e)) from None
    grant = {"u": user_id, "c": _client_hash(body["client_id"]), "r": redirect_uri, "h": challenge, "p": _perms_code(perms),
             "n": app["name"], "x": int(time.time()) + CODE_TTL_S}
    if email:
        grant["e"] = email
    q = {"code": _sign(b"code", grant), "iss": ISSUER}
    if isinstance(body.get("state"), str) and body["state"]:
        q["state"] = body["state"][:1000]
    return {"redirect": redirect_uri + ("&" if "?" in redirect_uri else "?") + urlencode(q)}


def token(table, form: dict) -> dict:
    """The token endpoint: a code and its PKCE verifier for a token."""
    if form.get("grant_type") != "authorization_code":
        raise OAuthError("unsupported_grant_type", "only authorization_code")
    code, verifier, client_id = form.get("code"), form.get("code_verifier"), form.get("client_id")
    grant = _unsign(b"code", code)
    if not grant:
        raise OAuthError("invalid_grant", "the code is not valid")
    if grant.get("x", 0) < time.time():
        raise OAuthError("invalid_grant", "the code expired; sign in again")
    if not isinstance(client_id, str) or not hmac.compare_digest(_client_hash(client_id), str(grant.get("c"))):
        raise OAuthError("invalid_grant", "the code was issued to another client")
    if form.get("redirect_uri") not in (None, grant.get("r")):
        raise OAuthError("invalid_grant", "redirect_uri differs from the one the code was issued for")
    if not isinstance(verifier, str) or not re.fullmatch(r"[A-Za-z0-9._~-]{43,128}", verifier):
        raise OAuthError("invalid_grant", "code_verifier is missing or malformed")
    if not hmac.compare_digest(_b64(hashlib.sha256(verifier.encode()).digest()), str(grant.get("h"))):
        raise OAuthError("invalid_grant", "code_verifier does not match the code_challenge")
    # One token per code: its id comes from the code, and the row is written once.
    token_id = hmac.new(_key(b"code-id"), code.encode(), hashlib.sha256).hexdigest()[:8]
    user_id = grant["u"]
    if table.get_item(Key={"user_id": user_id, "alert_id": tokens.ROW + token_id}).get("Item"):
        raise OAuthError("invalid_grant", "the code was already used")
    try:
        made = tokens.create(table, user_id, grant.get("n"), TOKEN_DAYS, email=grant.get("e"), permissions=_perms_of(grant.get("p")),
                             client=True, token_id=token_id)
    except table.meta.client.exceptions.ConditionalCheckFailedException:
        raise OAuthError("invalid_grant", "the code was already used") from None
    except ValueError:
        raise OAuthError("invalid_grant", "the code is not valid") from None
    return {"access_token": made["token"], "token_type": "Bearer", "expires_in": TOKEN_DAYS * 86400, "scope": SCOPE}
