#!/bin/sh
# Restarts any otj-*.timer that is enabled but stopped. Run every 15
# minutes by otj-watchdog.timer (installed by scripts/box_self_heal.sh).
#
# otj-publish.timer was stopped by hand on 2026-10-16 to take load off
# the box and nothing started it again: the sitemap, the board's first
# page and the stats froze for four days with no error anywhere.
#
# To pause a timer on purpose, leave a marker; it is honoured for six
# hours, then the timer comes back by itself:
#   sudo mkdir -p /var/lib/otj/pause && sudo touch /var/lib/otj/pause/otj-publish.timer
#   sudo systemctl stop otj-publish.timer
PAUSE=/var/lib/otj/pause
for t in $(systemctl list-unit-files 'otj-*.timer' --no-legend | awk '{print $1}'); do
  [ "$t" = otj-watchdog.timer ] && continue
  [ "$(systemctl is-enabled "$t")" = enabled ] || continue
  [ "$(systemctl is-active "$t")" = active ] && continue
  if [ -n "$(find "$PAUSE/$t" -mmin -360 2>/dev/null)" ]; then
    echo "$t is stopped and paused, leaving it"
    continue
  fi
  echo "$t was stopped with no pause marker, starting it"
  systemctl start "$t"
done
