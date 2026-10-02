#!/usr/bin/env bash
# Swap the box onto the split pair (jobs.db + jobs-fts.db) built off-box by
# box/split_fts.py, or back to the file it replaced.
#
#   sudo bash box/swap_split.sh <generation>     # cut over
#   sudo bash box/swap_split.sh --rollback       # back to jobs.db.pre-split
#
# The cutover order (box/STAGE2-FTS.md, "Cutover"): stop the applier,
# publisher and snapshot timers first and let any running job finish, so
# the Litestream restore the worker splits is the box's final state. This
# script refuses to run while any of them is still active.
#
# Litestream: the pair replicates to new paths (litestream/v6/jobs and
# litestream/v6/jobs-fts). Litestream 0.5 keeps transaction state per
# database, and a different file under the old path's history is asking
# for a confused restore. The v5 replica of the pre-split file stays as it
# is for its 72 hours, a second way back.
set -euo pipefail

D=/var/lib/otj
BUCKET="${DATA_BUCKET:-iljobs-data-876913698688}"
CONF=/etc/litestream.yml
TIMERS="otj-apply.timer otj-publish.timer otj-snapshot.timer"
JOBS="otj-apply.service otj-publish.service otj-snapshot.service"

need_quiet() {
  for t in $TIMERS; do
    if systemctl is-active --quiet "$t"; then echo "refusing: $t is active; stop the timers first"; exit 1; fi
  done
  for j in $JOBS; do
    if systemctl is-active --quiet "$j"; then echo "refusing: $j is still running; wait for it"; exit 1; fi
  done
}

health() {
  for i in $(seq 1 20); do
    if curl -sf -m 5 http://127.0.0.1:8000/api/health >/dev/null; then return 0; fi
    sleep 1
  done
  echo "the API did not answer /api/health"; return 1
}

if [ "${1:-}" = "--rollback" ]; then
  need_quiet
  [ -f "$D/jobs.db.pre-split" ] || { echo "no $D/jobs.db.pre-split to go back to"; exit 1; }
  systemctl stop litestream otj-api
  mkdir -p "$D/split/rolled-back"
  mv "$D/jobs.db" "$D/split/rolled-back/jobs.db"
  mv "$D/jobs-fts.db" "$D/split/rolled-back/jobs-fts.db"
  rm -f "$D/jobs.db-wal" "$D/jobs.db-shm" "$D/jobs-fts.db-wal" "$D/jobs-fts.db-shm"
  mv "$D/jobs.db.pre-split" "$D/jobs.db"
  [ -f "$D/jobs.db.pre-split-wal" ] && mv "$D/jobs.db.pre-split-wal" "$D/jobs.db-wal"
  [ -f "$D/jobs.db.pre-split-shm" ] && mv "$D/jobs.db.pre-split-shm" "$D/jobs.db-shm"
  [ -f "$CONF.pre-split" ] && cp "$CONF.pre-split" "$CONF"
  [ -d "$D/.jobs.db-litestream.pre-split" ] && { rm -rf "$D/.jobs.db-litestream"; mv "$D/.jobs.db-litestream.pre-split" "$D/.jobs.db-litestream"; }
  systemctl start otj-api
  health
  systemctl start litestream
  systemctl start $TIMERS
  echo "rolled back to the pre-split file; the split pair is in $D/split/rolled-back/"
  exit 0
fi

GEN="${1:?usage: swap_split.sh <generation> | --rollback}"
S="$D/split/$GEN"
need_quiet
[ ! -e "$D/jobs.db.pre-split" ] || { echo "refusing: $D/jobs.db.pre-split already exists (an earlier swap?)"; exit 1; }

mkdir -p "$S"
for f in manifest.json jobs.db jobs-fts.db; do
  aws s3 cp --only-show-errors "s3://$BUCKET/split/$GEN/$f" "$S/$f"
done
python3 - "$S" <<'PY'
import hashlib, json, sys
from pathlib import Path
s = Path(sys.argv[1])
m = json.loads((s / "manifest.json").read_text())
for name, want in m["files"].items():
    p = s / name
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(8 << 20), b""):
            h.update(chunk)
    if p.stat().st_size != want["bytes"] or h.hexdigest() != want["sha256"]:
        sys.exit(f"{name} does not match the manifest")
print(f"generation {m['generation']}: both files match the manifest, epoch {m['epoch']}, {m['rows']:,} rows")
PY
chown ubuntu:ubuntu "$S/jobs.db" "$S/jobs-fts.db"
chmod 664 "$S/jobs.db" "$S/jobs-fts.db"

systemctl stop litestream
systemctl stop otj-api
mv "$D/jobs.db" "$D/jobs.db.pre-split"
[ -f "$D/jobs.db-wal" ] && mv "$D/jobs.db-wal" "$D/jobs.db.pre-split-wal"
[ -f "$D/jobs.db-shm" ] && mv "$D/jobs.db-shm" "$D/jobs.db.pre-split-shm"
[ -d "$D/.jobs.db-litestream" ] && mv "$D/.jobs.db-litestream" "$D/.jobs.db-litestream.pre-split"
mv "$S/jobs.db" "$D/jobs.db"
mv "$S/jobs-fts.db" "$D/jobs-fts.db"
sudo -u ubuntu sqlite3 "$D/jobs.db" "PRAGMA journal_mode=WAL;" >/dev/null
sudo -u ubuntu sqlite3 "$D/jobs-fts.db" "PRAGMA journal_mode=WAL;" >/dev/null

cp "$CONF" "$CONF.pre-split"
python3 - "$CONF" "$BUCKET" <<'PY'
import sys
from pathlib import Path
conf, bucket = Path(sys.argv[1]), sys.argv[2]
text = conf.read_text()
text = text.replace("path: litestream/v5/jobs\n", "path: litestream/v6/jobs\n")
if "jobs-fts.db" not in text:
    text = text.rstrip("\n") + f"""
  # The search index in its own file (box/STAGE2-FTS.md). Restored
  # together with jobs.db from one manifest generation; on its own it is
  # meaningless (its rowids belong to one generation of jobs.db).
  - path: /var/lib/otj/jobs-fts.db
    replicas:
      - type: s3
        bucket: {bucket}
        path: litestream/v6/jobs-fts
        region: il-central-1
        sync-interval: 30s
        retention: 72h
        snapshot-interval: 6h
"""
conf.write_text(text)
PY

systemctl start otj-api
health
code=$(curl -s -o /tmp/split-search.json -w "%{http_code}" -m 30 "http://127.0.0.1:8000/api/jobs?search=python&confidence=all&limit=5")
python3 - "$code" <<'PY'
import json, sys
code = sys.argv[1]
d = json.load(open("/tmp/split-search.json"))
n = len(d.get("jobs", []))
if code != "200" or n == 0:
    sys.exit(f"search after the swap: HTTP {code}, {n} rows. Run: sudo bash box/swap_split.sh --rollback")
print(f"search after the swap: HTTP {code}, {n} rows, total {d.get('total')}")
PY
systemctl start litestream
systemctl start $TIMERS
echo "swapped to generation $GEN; the old file is $D/jobs.db.pre-split (rollback: sudo bash box/swap_split.sh --rollback)"
