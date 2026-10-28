"""The AWS side of the CRM (crm/): its table, its sender's settings, and an
IAM user that can do only what the CRM needs.

    python scripts/setup_crm_aws.py           # shows what it would do
    python scripts/setup_crm_aws.py --apply   # does it; the key goes to .env

- DynamoDB table ooj-crm (pk, sk), on demand, point-in-time recovery on.
- SES configuration set ooj-marketing: bounces and complaints go to the
  account's suppression list, so a bounced address is never sent to again.
- IAM user ooj-crm: read the user pool and the alerts table, write licenses
  and credit resets there (see LicensesAndCredits), read and write ooj-crm, and send email only from info@oceanofjobs.com through that set.
  Its access key is written to .env (CRM_AWS_ACCESS_KEY_ID and
  CRM_AWS_SECRET_ACCESS_KEY), never printed; scripts/deploy_crm.py hands it
  to the Worker as secrets.
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROFILE, REGION, ACCOUNT = "openmarket-tf", "il-central-1", "876913698688"
TABLE, USER, CONFIG_SET = "ooj-crm", "ooj-crm", "ooj-marketing"
POOL = "il-central-1_0vIcqqXyg"
SENDER = "info@oceanofjobs.com"


def aws(*args, quiet=False):
    out = subprocess.run(["aws", *args, "--profile", PROFILE, "--region", REGION, "--output", "json"], capture_output=True, text=True)
    if out.returncode and not quiet:
        sys.exit(out.stderr.strip())
    return json.loads(out.stdout) if out.returncode == 0 and out.stdout.strip() else None


POLICY = {"Version": "2012-10-17", "Statement": [
    {"Sid": "Members", "Effect": "Allow", "Action": ["cognito-idp:ListUsers"], "Resource": f"arn:aws:cognito-idp:{REGION}:{ACCOUNT}:userpool/{POOL}"},
    {"Sid": "ReadAlerts", "Effect": "Allow", "Action": ["dynamodb:Scan", "dynamodb:Query", "dynamodb:GetItem"],
     "Resource": f"arn:aws:dynamodb:{REGION}:{ACCOUNT}:table/iljobs-alerts"},
    # Licenses (#grant rows) and credit resets (#ledger# rows). IAM can't
    # limit a write to those sort keys, so it limits the attribute names:
    # a write can carry only these, and nothing can be deleted.
    {"Sid": "LicensesAndCredits", "Effect": "Allow", "Action": ["dynamodb:PutItem", "dynamodb:UpdateItem"],
     "Resource": f"arn:aws:dynamodb:{REGION}:{ACCOUNT}:table/iljobs-alerts",
     "Condition": {"ForAllValues:StringEquals": {"dynamodb:Attributes": [
         "user_id", "alert_id", "plan", "until", "note", "by", "at", "held", "charged", "reset_at", "reset_by"]}}},
    {"Sid": "CrmTable", "Effect": "Allow", "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:UpdateItem",
                                                    "dynamodb:BatchWriteItem"],
     "Resource": f"arn:aws:dynamodb:{REGION}:{ACCOUNT}:table/{TABLE}"},
    {"Sid": "EmailImages", "Effect": "Allow", "Action": ["s3:PutObject"],
     "Resource": "arn:aws:s3:::iljobs-frontend-876913698688/mail/*"},
    {"Sid": "SendAsInfo", "Effect": "Allow", "Action": ["ses:SendEmail"],
     "Resource": [f"arn:aws:ses:{REGION}:{ACCOUNT}:identity/oceanofjobs.com", f"arn:aws:ses:{REGION}:{ACCOUNT}:configuration-set/{CONFIG_SET}"],
     "Condition": {"StringEquals": {"ses:FromAddress": SENDER}}},
]}


def set_env(pairs: dict) -> None:
    path = ROOT / ".env"
    lines = [l for l in path.read_text(encoding="utf-8").splitlines() if l.split("=", 1)[0] not in pairs]
    path.write_text("\n".join(lines + [f"{k}={v}" for k, v in pairs.items()]) + "\n", encoding="utf-8")


def main(apply: bool):
    if aws("dynamodb", "describe-table", "--table-name", TABLE, quiet=True):
        print(f"table {TABLE} exists")
    elif apply:
        aws("dynamodb", "create-table", "--table-name", TABLE, "--billing-mode", "PAY_PER_REQUEST",
            "--attribute-definitions", "AttributeName=pk,AttributeType=S", "AttributeName=sk,AttributeType=S",
            "--key-schema", "AttributeName=pk,KeyType=HASH", "AttributeName=sk,KeyType=RANGE", "--tags", "Key=project,Value=oceanofjobs")
        aws("dynamodb", "wait", "table-exists", "--table-name", TABLE)
        aws("dynamodb", "update-continuous-backups", "--table-name", TABLE, "--point-in-time-recovery-specification", "PointInTimeRecoveryEnabled=true")
        print(f"created table {TABLE}, point-in-time recovery on")
    else:
        print(f"would create table {TABLE} (pk, sk), on demand, point-in-time recovery on")

    if aws("sesv2", "get-configuration-set", "--configuration-set-name", CONFIG_SET, quiet=True):
        print(f"configuration set {CONFIG_SET} exists")
    elif apply:
        aws("sesv2", "create-configuration-set", "--configuration-set-name", CONFIG_SET,
            "--suppression-options", "SuppressedReasons=BOUNCE,COMPLAINT")
        print(f"created configuration set {CONFIG_SET}, bounces and complaints suppressed")
    else:
        print(f"would create SES configuration set {CONFIG_SET}, bounces and complaints suppressed")

    if aws("iam", "get-user", "--user-name", USER, quiet=True):
        print(f"user {USER} exists")
    elif apply:
        aws("iam", "create-user", "--user-name", USER, "--tags", "Key=project,Value=oceanofjobs")
        print(f"created user {USER}")
    else:
        print(f"would create IAM user {USER}")
    if apply:
        aws("iam", "put-user-policy", "--user-name", USER, "--policy-name", "crm", "--policy-document", json.dumps(POLICY))
        print(f"policy crm set on {USER}")
        keys = aws("iam", "list-access-keys", "--user-name", USER)["AccessKeyMetadata"]
        if keys:
            print(f"{USER} already has an access key; not making another (rotate by deleting it first)")
        else:
            made = aws("iam", "create-access-key", "--user-name", USER)["AccessKey"]
            set_env({"CRM_AWS_ACCESS_KEY_ID": made["AccessKeyId"], "CRM_AWS_SECRET_ACCESS_KEY": made["SecretAccessKey"]})
            print("access key made and written to .env (not shown)")
    else:
        print("would set this policy and write a new access key to .env:\n" + json.dumps(POLICY, indent=1))


if __name__ == "__main__":
    main("--apply" in sys.argv)
