#!/usr/bin/env bash
# Puts the applier and the publisher behind the API for CPU and disk.
#
# Both walk the 5.3GB jobs.db, which is bigger than the box's RAM, so
# their reads come from disk and every API query queues behind them
# (2026-10-01: IO stalled a third of the time, calls taking 10 to 30
# seconds). A systemd drop-in gives each a lower CPU priority and the
# lowest best-effort disk class, so the API's reads go first. Idempotent:
# run it again and it rewrites the same two files.
#
# Needs the openmarket-tf AWS profile and gh signed in to the repo.
#   bash scripts/box_priority.sh
set -euo pipefail

INSTANCE="$(gh variable get BOX_INSTANCE_ID)"
REGION="il-central-1"
PROFILE="openmarket-tf"

read -r -d '' REMOTE <<'EOF' || true
for u in otj-apply otj-publish; do
  mkdir -p /etc/systemd/system/$u.service.d
  printf '[Service]\nNice=10\nIOSchedulingClass=best-effort\nIOSchedulingPriority=7\n' > /etc/systemd/system/$u.service.d/priority.conf
done
systemctl daemon-reload
for u in otj-apply otj-publish; do
  echo "== $u"
  systemctl show $u.service -p Nice -p IOSchedulingClass -p IOSchedulingPriority
done
EOF

params="$(python -c 'import json, sys; print(json.dumps({"commands": [sys.stdin.read()]}))' <<<"$REMOTE")"
cmd="$(aws ssm send-command --profile "$PROFILE" --region "$REGION" --instance-ids "$INSTANCE" \
  --document-name AWS-RunShellScript --comment "box priority drop-ins" \
  --parameters "$params" --query Command.CommandId --output text)"
for _ in $(seq 1 20); do
  status="$(aws ssm get-command-invocation --profile "$PROFILE" --region "$REGION" --command-id "$cmd" --instance-id "$INSTANCE" --query Status --output text 2>/dev/null || true)"
  case "$status" in Success|Failed|Cancelled|TimedOut) break ;; esac
  sleep 3
done
echo "status: $status"
aws ssm get-command-invocation --profile "$PROFILE" --region "$REGION" --command-id "$cmd" --instance-id "$INSTANCE" --query StandardOutputContent --output text
