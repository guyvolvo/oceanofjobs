#!/usr/bin/env bash
# Lets the box's publisher recover by itself.
#
# 2026-10-16: a publish run hung for 3h40m, it and its timer were stopped
# by hand, and nothing started the timer again. The sitemap, the board's
# first page and the stats froze for four days. Two pieces here:
#
# - A 2-hour limit on otj-publish.service (a pass takes minutes). Every
#   otj service had no limit, so a hung run blocked its timer for ever.
# - otj-watchdog.timer, every 15 minutes, runs box/watchdog.sh, which
#   starts any enabled otj-*.timer that is stopped and has no pause
#   marker (see that file for how to pause one on purpose).
#
# infra/alarms.tf's publish-stopped alarm is the third piece: it emails
# when no publish pass finishes for two hours.
#
# Idempotent. Needs box/watchdog.sh deployed first (deploy-box), the
# openmarket-tf AWS profile and gh signed in to the repo.
#   bash scripts/box_self_heal.sh
set -euo pipefail

INSTANCE="$(gh variable get BOX_INSTANCE_ID)"
REGION="il-central-1"
PROFILE="openmarket-tf"

read -r -d '' REMOTE <<'EOF' || true
set -e
test -x /srv/otj/app/box/watchdog.sh || chmod +x /srv/otj/app/box/watchdog.sh
mkdir -p /etc/systemd/system/otj-publish.service.d /var/lib/otj/pause
printf '[Service]\nTimeoutStartSec=2h\n' > /etc/systemd/system/otj-publish.service.d/timeout.conf
printf '[Unit]\nDescription=Restart stopped otj timers (box/watchdog.sh)\n[Service]\nType=oneshot\nExecStart=/bin/sh /srv/otj/app/box/watchdog.sh\n' > /etc/systemd/system/otj-watchdog.service
printf '[Unit]\nDescription=Check the otj timers every 15 minutes\n[Timer]\nOnBootSec=5min\nOnUnitActiveSec=15min\n[Install]\nWantedBy=timers.target\n' > /etc/systemd/system/otj-watchdog.timer
systemctl daemon-reload
systemctl enable --now otj-watchdog.timer
systemctl start otj-watchdog.service
echo "publish timeout: $(systemctl show otj-publish.service -p TimeoutStartUSec --value)"
systemctl list-timers --all --no-pager | grep -E 'otj-(watchdog|publish)'
journalctl -u otj-watchdog --since "-2 min" --no-pager | tail -5
EOF

params="$(python -c 'import json, sys; print(json.dumps({"commands": [sys.stdin.read()]}))' <<<"$REMOTE")"
cmd="$(aws ssm send-command --profile "$PROFILE" --region "$REGION" --instance-ids "$INSTANCE" \
  --document-name AWS-RunShellScript --comment "self-heal: publish timeout and timer watchdog" \
  --parameters "$params" --query Command.CommandId --output text)"
for _ in $(seq 1 20); do
  status="$(aws ssm get-command-invocation --profile "$PROFILE" --region "$REGION" --command-id "$cmd" --instance-id "$INSTANCE" --query Status --output text 2>/dev/null || true)"
  case "$status" in Success|Failed|Cancelled|TimedOut) break ;; esac
  sleep 3
done
echo "status: $status"
aws ssm get-command-invocation --profile "$PROFILE" --region "$REGION" --command-id "$cmd" --instance-id "$INSTANCE" \
  --query '[StandardOutputContent, StandardErrorContent]' --output text
