"""Sets up what "Save my settings to: Account" needs (api/user_files.py):
a KMS key that encrypts members' CVs, Workday passwords and AI keys, and
the box role's right to use it and the user-files/ prefix of the data bucket.

    python scripts/setup_user_storage.py           # shows what it would do
    python scripts/setup_user_storage.py --apply   # does it

Then put the key on the box (the API answers "not set up" until then):
    bash scripts/set_box_secret.sh OOJ_USER_KEY    # paste the alias ARN this prints

Uses the openmarket-tf AWS profile. The box role is hand-made, not in
terraform, so this is the record of what was added to it.
"""
import json
import subprocess
import sys

PROFILE, REGION = "openmarket-tf", "il-central-1"
ACCOUNT = "876913698688"
BUCKET = f"iljobs-data-{ACCOUNT}"
ROLE, POLICY = "otj-box-experiment", "user-files"
ALIAS = "alias/ooj-user-files"


def aws(*args, quiet=False):
    out = subprocess.run(["aws", *args, "--profile", PROFILE, "--region", REGION, "--output", "json"],
                         capture_output=True, text=True)
    if out.returncode and not quiet:
        sys.exit(out.stderr.strip())
    return json.loads(out.stdout) if out.returncode == 0 and out.stdout.strip() else None


def main(apply: bool):
    found = aws("kms", "describe-key", "--key-id", ALIAS, quiet=True)
    if found:
        key_arn = found["KeyMetadata"]["Arn"]
        print(f"key exists: {key_arn}")
    elif apply:
        made = aws("kms", "create-key", "--description", "Ocean of Jobs: members' CVs, Workday passwords and AI keys",
                   "--tags", "TagKey=project,TagValue=oceanofjobs")
        key_arn = made["KeyMetadata"]["Arn"]
        aws("kms", "create-alias", "--alias-name", ALIAS, "--target-key-id", made["KeyMetadata"]["KeyId"])
        aws("kms", "enable-key-rotation", "--key-id", made["KeyMetadata"]["KeyId"])
        print(f"created {ALIAS}: {key_arn} (yearly rotation on)")
    else:
        key_arn = f"arn:aws:kms:{REGION}:{ACCOUNT}:key/<new>"
        print(f"would create a KMS key with alias {ALIAS}, yearly rotation on (about $1 a month)")

    policy = {"Version": "2012-10-17", "Statement": [
        {"Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
         "Resource": f"arn:aws:s3:::{BUCKET}/user-files/*"},
        {"Effect": "Allow", "Action": ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"], "Resource": key_arn},
    ]}
    if apply:
        aws("iam", "put-role-policy", "--role-name", ROLE, "--policy-name", POLICY, "--policy-document", json.dumps(policy))
        print(f"role {ROLE}: policy {POLICY} set")
        print(f"\nnow run:  bash scripts/set_box_secret.sh OOJ_USER_KEY   and paste: arn:aws:kms:{REGION}:{ACCOUNT}:{ALIAS}")
    else:
        print(f"would set policy {POLICY} on role {ROLE}:\n{json.dumps(policy, indent=1)}")


if __name__ == "__main__":
    main("--apply" in sys.argv)
