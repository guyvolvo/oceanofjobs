"""The signature on a mail's one-click unsubscribe link (RFC 8058).

Shared by alerts.py, which writes the link into every alert mail, and
api/handler.py, which honours it. In api/ rather than beside alerts.py
because the API runs from this directory and cannot import the root.
The secret is ALERTS_UNSUBSCRIBE_SECRET, set on the box by hand; without
it there are no links and the route stays closed.
"""

import hashlib
import hmac
import os

SECRET = os.environ.get("ALERTS_UNSUBSCRIBE_SECRET", "")


def unsubscribe_token(user_id: str, alert_id: str, secret: str | None = None) -> str:
    """32 hex characters over the alert's key. The same input and secret
    give the same token, so a mail's link keeps working."""
    key = (SECRET if secret is None else secret).encode("utf-8")
    return hmac.new(key, f"{user_id}\n{alert_id}".encode("utf-8"), hashlib.sha256).hexdigest()[:32]
