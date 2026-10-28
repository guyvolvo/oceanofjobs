#!/usr/bin/env bash
# Sets one secret in the box's /etc/otj-api.env and restarts the API.
#
#   bash scripts/set_box_secret.sh PADDLE_WEBHOOK_SECRET
#
# Run it in your own terminal, not through an AI assistant: the value is
# read with hidden typing and goes from here to the box over SSM, so it is
# never on screen or in a chat. It is visible in this AWS account's SSM
# command history, which only the account's own users can read.
#
# Needs the openmarket-tf AWS profile and gh signed in to the repo.
set -euo pipefail

NAME="${1:?usage: bash scripts/set_box_secret.sh NAME}"
case "$NAME" in
  PADDLE_WEBHOOK_SECRET|PADDLE_ENV|PADDLE_PRICES|PADDLE_API_KEY|OOJ_USER_KEY) ;;
  *) echo "unknown setting $NAME" >&2; exit 2 ;;
esac
read -r -s -p "$NAME (input hidden): " VALUE; echo
[ -n "$VALUE" ] || { echo "empty, nothing changed" >&2; exit 1; }
case "$VALUE" in *[\'\"\\\$\`]*) echo "the value has a quote, backslash, \$ or backtick; set it by hand" >&2; exit 1 ;; esac

INSTANCE="$(gh variable get BOX_INSTANCE_ID)"
REMOTE="set -e
f=/etc/otj-api.env
grep -v '^$NAME=' \$f > \$f.new || true
echo '$NAME=$VALUE' >> \$f.new
chmod --reference=\$f \$f.new && chown --reference=\$f \$f.new && mv \$f.new \$f
systemctl restart otj-api
sleep 3
systemctl is-active otj-api
grep -c '^$NAME=' \$f"
params="$(python -c 'import json, sys; print(json.dumps({"commands": [sys.stdin.read()]}))' <<<"$REMOTE")"
cmd="$(aws ssm send-command --profile openmarket-tf --region il-central-1 --instance-ids "$INSTANCE" \
  --document-name AWS-RunShellScript --comment "set $NAME" --parameters "$params" \
  --query Command.CommandId --output text)"
for _ in $(seq 1 20); do
  status="$(aws ssm get-command-invocation --profile openmarket-tf --region il-central-1 --command-id "$cmd" --instance-id "$INSTANCE" --query Status --output text 2>/dev/null || true)"
  case "$status" in Success|Failed|Cancelled|TimedOut) break ;; esac
  sleep 3
done
echo "status: $status (expect 'active' and '1' below)"
aws ssm get-command-invocation --profile openmarket-tf --region il-central-1 --command-id "$cmd" --instance-id "$INSTANCE" \
  --query StandardOutputContent --output text
