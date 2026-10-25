"""The extension's settings, kept on the account instead of in the browser
when the member chooses "Save my settings to: Account".

What can live here: the CV file, the Workday password and the member's
own AI key. The rest of the auto apply profile is always on the account
(apply.py); without this choice these three stay in chrome.storage.local.

  #storage row   mode ("account" | "local"), the CV's name/type/size/date,
                 the Workday password and AI key encrypted with KMS, the
                 date and policy version of the consent to store them
  S3             user-files/cv/<user_id>, encrypted with the same KMS key

The secrets are encrypted with KMS under an encryption context naming the
user and the field, so a ciphertext copied to another user's row won't
decrypt. Only the extension's token reads them back (handler.py): the
website shows that they exist, never what they are.

Without OOJ_USER_KEY and DATA_BUCKET in the environment the routes answer
"not set up" rather than storing anything unencrypted.
"""
import base64
import os
from datetime import datetime, timezone

import boto3

ROW = "#storage"
PREFIX = "user-files/cv/"
MAX_CV = 5 * 1024 * 1024
TYPES = {"application/pdf": (".pdf", b"%PDF"),
         "application/vnd.openxmlformats-officedocument.wordprocessingml.document": (".docx", b"PK")}
CONSENT_VERSION = "2026-10-25"  # the privacy policy's paragraph on stored CVs
NOT_READY = "Saving to your account isn't available yet. Your settings stay in this browser."


class NotReady(Exception):
    pass


def _key() -> str:
    return os.environ.get("OOJ_USER_KEY", "")


def _bucket() -> str:
    return os.environ.get("DATA_BUCKET", "")


def _ready():
    if not (_key() and _bucket()):
        raise NotReady(NOT_READY)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row(table, user_id: str) -> dict:
    return table.get_item(Key={"user_id": user_id, "alert_id": ROW}).get("Item") or {}


def view(table, user_id: str) -> dict:
    """What the popup and the website show: never the secrets themselves."""
    r = _row(table, user_id)
    cv = r.get("cv")
    return {
        "mode": r.get("mode") or "local",
        "ready": bool(_key() and _bucket()),
        "cv": {k: (int(cv[k]) if k == "size" else cv[k]) for k in ("name", "type", "size", "uploaded_at") if k in cv} if cv else None,
        "workday": bool(r.get("workday_enc")),
        "ai": {"provider": r["ai_provider"], "model": r.get("ai_model") or ""} if r.get("ai_enc") else None,
    }


def _encrypt(user_id: str, field: str, text: str) -> str:
    out = boto3.client("kms").encrypt(KeyId=_key(), Plaintext=text.encode("utf-8"),
                                      EncryptionContext={"user": user_id, "field": field})
    return base64.b64encode(out["CiphertextBlob"]).decode()


def _decrypt(user_id: str, field: str, blob: str) -> str:
    out = boto3.client("kms").decrypt(CiphertextBlob=base64.b64decode(blob), EncryptionContext={"user": user_id, "field": field})
    return out["Plaintext"].decode("utf-8")


def set_mode(table, user_id: str, mode: str, consent: bool = False) -> dict:
    """Account: the member agreed to store these on the account (the box in
    the popup or on the website). Local: everything stored here is deleted;
    the extension copies it into the browser first."""
    if mode == "account":
        _ready()
        if consent is not True:
            raise ValueError("Agree to the Privacy Policy to save your settings to your account.")
        table.update_item(Key={"user_id": user_id, "alert_id": ROW},
                          UpdateExpression="SET #m = :m, consent_at = :t, consent_version = :v",
                          ExpressionAttributeNames={"#m": "mode"},
                          ExpressionAttributeValues={":m": "account", ":t": _now(), ":v": CONSENT_VERSION})
    elif mode == "local":
        _delete_cv_object(user_id)
        table.put_item(Item={"user_id": user_id, "alert_id": ROW, "mode": "local"})
    else:
        raise ValueError("mode must be account or local")
    return view(table, user_id)


def _decoded_cv(body: dict) -> tuple[str, str, bytes]:
    name = str(body.get("name") or "").strip().replace("/", "_").replace("\\", "_")[:200]
    ctype = str(body.get("type") or "")
    if ctype not in TYPES:
        raise ValueError("Choose a PDF or DOCX file.")
    try:
        data = base64.b64decode(str(body.get("data") or ""), validate=True)
    except ValueError:
        raise ValueError("The file couldn't be read. Choose it again.") from None
    if not data or len(data) > MAX_CV:
        raise ValueError("This file is larger than 5 MB." if data else "The file is empty.")
    ext, magic = TYPES[ctype]
    if not data.startswith(magic):
        raise ValueError("Choose a PDF or DOCX file.")
    if not name.lower().endswith(ext):
        name = (name or "Resume") + ext
    return name, ctype, data


def put_cv(table, user_id: str, body: dict) -> dict:
    """Stores the CV on the account. Uploading it is itself the choice to
    save to the account, so it takes the same consent."""
    _ready()
    r = _row(table, user_id)
    if r.get("mode") != "account":
        set_mode(table, user_id, "account", consent=body.get("consent") is True)
    name, ctype, data = _decoded_cv(body)
    boto3.client("s3").put_object(Bucket=_bucket(), Key=PREFIX + user_id, Body=data, ContentType=ctype,
                                  ServerSideEncryption="aws:kms", SSEKMSKeyId=_key())
    table.update_item(Key={"user_id": user_id, "alert_id": ROW}, UpdateExpression="SET cv = :c",
                      ExpressionAttributeValues={":c": {"name": name, "type": ctype, "size": len(data), "uploaded_at": _now()}})
    return view(table, user_id)


def get_cv(table, user_id: str) -> dict | None:
    """The file, for the extension to attach (and the website's Download)."""
    _ready()
    r = _row(table, user_id)
    if r.get("mode") != "account" or not r.get("cv"):
        return None
    obj = boto3.client("s3").get_object(Bucket=_bucket(), Key=PREFIX + user_id)
    cv = r["cv"]
    return {"name": cv["name"], "type": cv["type"], "size": int(cv["size"]), "uploaded_at": cv["uploaded_at"],
            "data": base64.b64encode(obj["Body"].read()).decode()}


def _delete_cv_object(user_id: str):
    if _bucket():
        boto3.client("s3").delete_object(Bucket=_bucket(), Key=PREFIX + user_id)


def delete_cv(table, user_id: str) -> dict:
    _delete_cv_object(user_id)
    table.update_item(Key={"user_id": user_id, "alert_id": ROW}, UpdateExpression="REMOVE cv")
    return view(table, user_id)


def put_secrets(table, user_id: str, body: dict) -> dict:
    """The Workday password and the AI key, from the extension. A field
    sent as null is removed; a field left out stays as it is."""
    _ready()
    if _row(table, user_id).get("mode") != "account":
        raise ValueError("Your settings are saved in this browser, not on your account.")
    sets, removes, values = [], [], {}
    if "workday" in body:
        pw = body["workday"]
        if pw is None:
            removes.append("workday_enc")
        else:
            if not isinstance(pw, str) or not 8 <= len(pw) <= 128:
                raise ValueError("The Workday password must be 8 to 128 characters.")
            sets.append("workday_enc = :w")
            values[":w"] = _encrypt(user_id, "workday", pw)
    if "ai" in body:
        ai = body["ai"]
        if ai is None:
            removes += ["ai_enc", "ai_provider", "ai_model"]
        else:
            provider, key, model = (str((ai or {}).get(k) or "").strip() for k in ("provider", "key", "model"))
            if not (provider and key) or len(provider) > 40 or len(key) > 400 or len(model) > 100:
                raise ValueError("Choose a provider and enter your API key.")
            sets += ["ai_enc = :k", "ai_provider = :p", "ai_model = :mo"]
            values.update({":k": _encrypt(user_id, "ai", key), ":p": provider, ":mo": model})
    if sets or removes:
        expr = (("SET " + ", ".join(sets)) if sets else "") + ((" REMOVE " + ", ".join(removes)) if removes else "")
        kw = {"ExpressionAttributeValues": values} if values else {}
        table.update_item(Key={"user_id": user_id, "alert_id": ROW}, UpdateExpression=expr.strip(), **kw)
    return view(table, user_id)


def get_secrets(table, user_id: str) -> dict:
    """Decrypted, for the extension's token only (handler.py checks)."""
    _ready()
    r = _row(table, user_id)
    if r.get("mode") != "account":
        return {"workday": None, "ai": None}
    return {"workday": _decrypt(user_id, "workday", r["workday_enc"]) if r.get("workday_enc") else None,
            "ai": {"provider": r["ai_provider"], "key": _decrypt(user_id, "ai", r["ai_enc"]), "model": r.get("ai_model") or ""}
            if r.get("ai_enc") else None}


def forget(table, user_id: str) -> None:
    """Deleting the account."""
    _delete_cv_object(user_id)
    table.delete_item(Key={"user_id": user_id, "alert_id": ROW})
