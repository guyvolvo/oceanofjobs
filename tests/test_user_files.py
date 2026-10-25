"""The extension's settings on the account (api/user_files.py and its routes):
the choice between account and browser, the CV file, the encrypted Workday
password and AI key, and who may read them back.

Needs moto (test only):    python -m pip install "moto[dynamodb,s3,kms]==5.1.4"
Run directly, no framework:  python tests/test_user_files.py
"""
import base64
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))
for k, v in {"ALERTS_TABLE": "files-test", "DATA_BUCKET": "files-bucket", "DATA_KEY": "jobs.db", "AWS_DEFAULT_REGION": "il-central-1",
             "AWS_ACCESS_KEY_ID": "testing", "AWS_SECRET_ACCESS_KEY": "testing"}.items():
    os.environ[k] = v

import boto3  # noqa: E402
from moto import mock_aws  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + str(detail)))
    if not ok:
        failures.append(name)


PDF = b"%PDF-1.4\n" + b"x" * 1000
DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

with mock_aws():
    ddb = boto3.resource("dynamodb", region_name="il-central-1")
    table = ddb.create_table(TableName="files-test", KeySchema=[{"AttributeName": "user_id", "KeyType": "HASH"},
                                                                {"AttributeName": "alert_id", "KeyType": "RANGE"}],
                             AttributeDefinitions=[{"AttributeName": "user_id", "AttributeType": "S"},
                                                   {"AttributeName": "alert_id", "AttributeType": "S"}],
                             BillingMode="PAY_PER_REQUEST")
    s3 = boto3.client("s3", region_name="il-central-1")
    s3.create_bucket(Bucket="files-bucket", CreateBucketConfiguration={"LocationConstraint": "il-central-1"})
    import handler  # noqa: E402
    import user_files  # noqa: E402
    handler._alerts_table = table

    def call(user, method, path, body=None, extension=False):
        claims = {"sub": user, "email": "dana@example.com", "email_verified": "true"}
        if extension:
            claims.update({"token_use": "ooj", "scope": "extension"})
        event = {"rawPath": "/api" + path, "rawQueryString": "", "body": json.dumps(body) if body is not None else "",
                 "headers": {}, "requestContext": {"http": {"method": method}, "authorizer": {"jwt": {"claims": claims}}}}
        r = handler.lambda_handler(event, None)
        return r["statusCode"], json.loads(r["body"] or "null")

    def cv(data=PDF, name="Dana_Levi_CV.pdf", ctype="application/pdf", consent=None):
        body = {"name": name, "type": ctype, "data": base64.b64encode(data).decode()}
        if consent is not None:
            body["consent"] = consent
        return body

    # Without a key, nothing is stored unencrypted.
    s, out = call("u1", "PUT", "/me/storage", {"mode": "account", "consent": True})
    check("without a KMS key the account option says it isn't ready", s == 503 and out["code"] == "not_ready", (s, out))
    s, out = call("u1", "GET", "/me/storage")
    check("and the view says so", s == 200 and out["ready"] is False and out["mode"] == "local", out)

    key = boto3.client("kms", region_name="il-central-1").create_key()["KeyMetadata"]["KeyId"]
    os.environ["OOJ_USER_KEY"] = key

    # Choosing the account.
    s, out = call("u1", "PUT", "/me/storage", {"mode": "account"})
    check("the account needs the privacy box", s == 400, (s, out))
    s, out = call("u1", "PUT", "/me/storage", {"mode": "account", "consent": True})
    row = table.get_item(Key={"user_id": "u1", "alert_id": "#storage"})["Item"]
    check("with it, the mode and the consent date are kept", s == 200 and out["mode"] == "account" and row.get("consent_at"), row)

    # The CV.
    s, out = call("u1", "PUT", "/me/cv", cv())
    check("a PDF is stored", s == 200 and out["cv"]["name"] == "Dana_Levi_CV.pdf" and out["cv"]["size"] == len(PDF), out)
    head = s3.head_object(Bucket="files-bucket", Key="user-files/cv/u1")
    check("encrypted with the KMS key", head.get("ServerSideEncryption") == "aws:kms", head.get("ServerSideEncryption"))
    s, out = call("u1", "GET", "/me/cv")
    check("and comes back byte for byte", s == 200 and base64.b64decode(out["data"]) == PDF, s)
    s, out = call("u1", "PUT", "/me/cv", cv(data=b"MZ\x90\x00" + b"x" * 100, name="evil.pdf"))
    check("a file that isn't a PDF is refused, whatever its name", s == 400, (s, out))
    s, out = call("u1", "PUT", "/me/cv", cv(data=b"PK\x03\x04" + b"x" * 100, name="resume", ctype=DOCX_TYPE))
    check("a DOCX is taken and named so", s == 200 and out["cv"]["name"] == "resume.docx", out)
    s, out = call("u1", "PUT", "/me/cv", cv(data=b"%PDF" + b"x" * (5 * 1024 * 1024)))
    check("over 5 MB is refused", s == 400 and "5 MB" in out["error"], (s, out))
    s, out = call("u1", "PUT", "/me/cv", cv(name="../../etc/passwd.pdf"))
    check("a path in the name can't reach another key", s == 200 and "/" not in out["cv"]["name"], out)
    s, out = call("u2", "PUT", "/me/cv", cv())
    check("uploading without the account chosen needs the box", s == 400, (s, out))
    s, out = call("u2", "PUT", "/me/cv", cv(consent=True))
    check("with it, the upload chooses the account", s == 200 and out["mode"] == "account", out)
    s, out = call("u3", "GET", "/me/cv")
    check("another member's file is never there", s == 404, (s, out))

    # The secrets.
    s, out = call("u1", "PUT", "/me/storage/secrets", {"workday": "Xk7!mP2#qR9$"})
    check("the website can't set them", s == 403, (s, out))
    s, out = call("u1", "PUT", "/me/storage/secrets", {"workday": "Xk7!mP2#qR9$", "ai": {"provider": "anthropic", "key": "sk-ant-1", "model": "m"}},
                  extension=True)
    row = table.get_item(Key={"user_id": "u1", "alert_id": "#storage"})["Item"]
    check("the extension can, and they're stored encrypted", s == 200 and "Xk7" not in json.dumps(row, default=str)
          and "sk-ant-1" not in json.dumps(row, default=str), row)
    check("the view says they exist, not what they are", out["workday"] is True and out["ai"] == {"provider": "anthropic", "model": "m"}, out)
    s, out = call("u1", "GET", "/me/storage/secrets")
    check("the website can't read them back", s == 403, (s, out))
    s, out = call("u1", "GET", "/me/storage/secrets", extension=True)
    check("the extension reads them back", out == {"workday": "Xk7!mP2#qR9$", "ai": {"provider": "anthropic", "key": "sk-ant-1", "model": "m"}}, out)
    stolen = dict(row)
    stolen["user_id"] = "u2"
    stolen["alert_id"] = "#storage"
    table.put_item(Item=stolen)
    s, out = call("u2", "GET", "/me/storage/secrets", extension=True)
    check("a ciphertext copied to another member doesn't decrypt", s >= 500 or out.get("workday") != "Xk7!mP2#qR9$", (s, out))
    table.delete_item(Key={"user_id": "u2", "alert_id": "#storage"})
    s, out = call("u1", "PUT", "/me/storage/secrets", {"workday": "short"}, extension=True)
    check("a password under 8 characters is refused", s == 400, (s, out))
    s, out = call("u1", "PUT", "/me/storage/secrets", {"ai": None}, extension=True)
    check("null removes one, the other stays", out["ai"] is None and out["workday"] is True, out)

    # Back to the browser.
    s, out = call("u1", "PUT", "/me/storage", {"mode": "local"})
    row = table.get_item(Key={"user_id": "u1", "alert_id": "#storage"})["Item"]
    gone = s3.list_objects_v2(Bucket="files-bucket", Prefix="user-files/cv/u1").get("KeyCount", 0) == 0
    check("choosing the browser deletes the file and the secrets", s == 200 and out["mode"] == "local" and gone
          and set(row) == {"user_id", "alert_id", "mode"}, row)
    s, out = call("u1", "PUT", "/me/storage/secrets", {"workday": "Xk7!mP2#qR9$"}, extension=True)
    check("and nothing is stored again until the account is chosen", s == 400, (s, out))

    # Deleting the account.
    s, _ = call("u2", "DELETE", "/me/storage")
    check("deleting the account removes the file and the row", s == 204
          and not s3.list_objects_v2(Bucket="files-bucket", Prefix="user-files/cv/u2").get("KeyCount")
          and "Item" not in table.get_item(Key={"user_id": "u2", "alert_id": "#storage"}))

print()
print("all passed" if not failures else f"{len(failures)} failed")
sys.exit(1 if failures else 0)
