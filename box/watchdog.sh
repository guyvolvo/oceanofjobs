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

# Units in box/systemd go live with the deploy that ships them. They used
# to need a hand-run cp and enable after every merge, which is how a timer
# gets merged and never started. A changed unit is replaced; a new timer is
# enabled and started.
SRC=/srv/otj/app/box/systemd
reload=
for f in "$SRC"/otj-*.service "$SRC"/otj-*.timer; do
  [ -f "$f" ] || continue
  cmp -s "$f" "/etc/systemd/system/${f##*/}" && continue
  echo "installing ${f##*/} from the repo"
  cp "$f" /etc/systemd/system/ && reload=1
done
if [ -n "$reload" ]; then
  systemctl daemon-reload
  for f in "$SRC"/otj-*.timer; do
    t=${f##*/}
    [ "$(systemctl is-enabled "$t" 2>/dev/null)" = enabled ] || { echo "enabling $t"; systemctl enable --now "$t"; }
  done
fi

# Disk. On 2026-11-08 it was 88% full: 5.1 GB of rollback copies that
# box/COMPACT.md says to delete 48 hours after a swap (the Oct 21 one was
# never deleted) and 2.9 GB of journal, mostly gunicorn's access log.
D=/var/lib/otj
# swap_compact.sh's rollback copy, once the swapped file has served 3 days.
if [ -n "$(find "$D/jobs.db.pre-compact" -mtime +3 2>/dev/null)" ]; then
  echo "removing the rollback copy from the last compaction"
  rm -f "$D/jobs.db.pre-compact" "$D/jobs.db.pre-compact-wal" "$D/jobs.db.pre-compact-shm"
  rm -rf "$D/.jobs.db-litestream.pre-compact"
fi
find "$D/compact" -mindepth 1 -maxdepth 1 -name rolled-back -mtime +3 -exec rm -rf {} + 2>/dev/null
# The journal keeps 1 GB, about a week; journald enforces it from then on.
CONF=/etc/systemd/journald.conf.d/otj-size.conf
if [ ! -f "$CONF" ]; then
  mkdir -p "${CONF%/*}" && printf '[Journal]\nSystemMaxUse=1G\n' > "$CONF"
  echo "journal capped at 1 GB"
  systemctl restart systemd-journald
fi
# Last resort before the disk fills: the journal and apt's cache go first,
# and the 85% alarm (box/metrics.py DiskUsedPercent) has already emailed.
used=$(df --output=pcent "$D" | tail -1 | tr -dc 0-9)
if [ "${used:-0}" -ge 90 ]; then
  echo "disk ${used}% full: trimming the journal to 200 MB and apt's cache"
  journalctl --vacuum-size=200M
  apt-get clean
fi
