"""Personal access tokens: what an MCP client sends to act for one user.

A token reads ooj_<user>.<id>.<secret>. <user> is the Cognito sub,
base64url, so checking a token is one GetItem on the alerts table at
(user_id, "#token#<id>") with no index and no table of its own; the box
already holds every permission that needs. Only the SHA-256 of the whole
token is stored: a copy of the table cannot be used to sign in, and the
secret carries 192 random bits, so a fast hash is enough.

A token is not a session, and each has a scope. An "mcp" token reaches
the saved-jobs routes and the auto apply queue only; an "extension" token (made by the website
for the browser extension) also reaches /api/me/apply/*. serve.py holds
the map. Neither can read the search profile, change alerts, or mint or
revoke tokens.
"""

import base64
import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone

from boto3.dynamodb.conditions import Key

PREFIX = "ooj_"
ROW = "#token#"
MAX_PER_USER = 5
EXPIRY_DAYS = (30, 90, None)  # None: never
SCOPES = ("mcp", "extension")
NAME_MAX = 60
# last_used moves at most this often, so a busy client does not cost a
# write on every call.
TOUCH_EVERY_S = 3600


def _b64(s: str) -> str:
    return base64.urlsafe_b64encode(s.encode()).rstrip(b"=").decode()


def _unb64(s: str) -> str:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4)).decode()


def digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def parse(token: str) -> tuple[str, str] | None:
    """(user_id, token_id) from a well-formed token, else None."""
    if not isinstance(token, str) or not token.startswith(PREFIX) or len(token) > 300:
        return None
    parts = token[len(PREFIX):].split(".")
    if len(parts) != 3 or not all(parts):
        return None
    try:
        user_id = _unb64(parts[0])
    except Exception:  # noqa: BLE001 -- any decoding failure is "not a token"
        return None
    token_id = parts[1]
    if not user_id or len(token_id) != 8 or any(c not in "0123456789abcdef" for c in token_id):
        return None
    return user_id, token_id


def _public(item: dict) -> dict:
    return {"id": item["alert_id"][len(ROW):], "name": item.get("name"), "hint": item.get("hint"),
            "created_at": item.get("created_at"), "last_used_at": item.get("last_used_at"),
            "expires_at": item.get("expires_at"), "scope": item.get("scope") or "mcp"}


def list_tokens(table, user_id: str) -> list[dict]:
    resp = table.query(KeyConditionExpression=Key("user_id").eq(user_id) & Key("alert_id").begins_with(ROW))
    rows = sorted(resp.get("Items", []), key=lambda i: i.get("created_at") or "", reverse=True)
    return [_public(i) for i in rows]


def create(table, user_id: str, name, days, now: datetime | None = None, scope: str = "mcp", email: str | None = None) -> dict:
    """A new token. The only time the token itself is ever returned.
    email is the account's verified address, kept so an alert made with
    the token has somewhere to go."""
    now = now or datetime.now(timezone.utc)
    name = str(name or "").strip()[:NAME_MAX] or "Token"
    if days not in EXPIRY_DAYS:
        raise ValueError("expires_in_days must be 30, 90 or null")
    if scope not in SCOPES:
        raise ValueError("scope must be mcp or extension")
    existing = list_tokens(table, user_id)
    if scope == "extension":
        # One extension per account: connecting again replaces the old token
        # rather than piling up a new one each time.
        for t in existing:
            if t["scope"] == "extension":
                revoke(table, user_id, t["id"])
        existing = [t for t in existing if t["scope"] != "extension"]
    if len(existing) >= MAX_PER_USER:
        raise ValueError(f"at most {MAX_PER_USER} tokens; revoke one first")
    token_id = secrets.token_hex(4)
    token = f"{PREFIX}{_b64(user_id)}.{token_id}.{secrets.token_urlsafe(24)}"
    item = {"user_id": user_id, "alert_id": ROW + token_id, "hash": digest(token), "name": name,
            "hint": token[-4:], "created_at": now.isoformat(), "scope": scope}
    if days:
        item["expires_at"] = (now + timedelta(days=days)).isoformat()
    if email:
        item["email"] = email
    table.put_item(Item=item, ConditionExpression="attribute_not_exists(alert_id)")
    return {**_public(item), "token": token}


def revoke(table, user_id: str, token_id: str) -> None:
    if len(token_id) != 8 or any(c not in "0123456789abcdef" for c in token_id):
        raise ValueError("not a token id")
    table.delete_item(Key={"user_id": user_id, "alert_id": ROW + token_id})


def verify(table, token: str, now: datetime | None = None) -> dict | None:
    """{"user_id", "scope"} and the email if it has one, for a live token, else None."""
    parsed = parse(token)
    if not parsed:
        return None
    user_id, token_id = parsed
    item = table.get_item(Key={"user_id": user_id, "alert_id": ROW + token_id}).get("Item")
    if not item or not hmac.compare_digest(str(item.get("hash") or ""), digest(token)):
        return None
    now = now or datetime.now(timezone.utc)
    if item.get("expires_at") and datetime.fromisoformat(item["expires_at"]) <= now:
        return None
    last = item.get("last_used_at")
    if not last or (now - datetime.fromisoformat(last)).total_seconds() >= TOUCH_EVERY_S:
        try:
            table.update_item(Key={"user_id": user_id, "alert_id": ROW + token_id},
                              UpdateExpression="SET last_used_at = :t", ExpressionAttributeValues={":t": now.isoformat()},
                              ConditionExpression="attribute_exists(alert_id)")
        except Exception as e:  # noqa: BLE001 -- a missed timestamp must not refuse a good token
            print(f"token last_used not updated: {e.__class__.__name__}")
    return {"user_id": user_id, "scope": item.get("scope") or "mcp", **({"email": item["email"]} if item.get("email") else {})}
