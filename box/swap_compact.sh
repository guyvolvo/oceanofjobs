#!/usr/bin/env bash
# Swap the box onto the compact jobs.db that box/compact_db.py built beside
# the live one, or back to the file it replaced.
#
#   sudo bash box/swap_compact.sh <generation>     # cut over
#   sudo bash box/swap_compact.sh --rollback       # back to jobs.db.pre-compact
#
# The order is in box/COMPACT.md: pause and stop the timers that write
# jobs.db, build, then this. It refuses while any of them is active, and
# when the live file has moved on since the build (its row count and
# largest rowid must equal the manifest's).
#
# jobs-fts.db is not touched. The copy keeps every rowid and the epoch
# (compact_db.py proves it), so the index stays valid as it is.
#
# Litestream: jobs.db replicates to the next path after the one the config
# names now (v6 -> v7), as the FTS split did. Litestream 0.5 keeps its
# position per database, and a different file under the old path's
# history is asking for a confused restore. The precompute Lambda restores
# that path (precompute_handler.py REPLICA_PATH, infra/precompute_lambda.tf)
# and has to follow it.
set -euo pipefail

D=/var/lib/otj
CONF=/etc/litestream.yml
PAUSE=$D/pause
TIMERS="otj-apply.timer otj-publish.timer otj-snapshot.timer otj-names.timer"
JOBS="otj-apply.service otj-publish.service otj-snapshot.service otj-names.service"

need_quiet() {
  for t in $TIMERS; do
    if systemctl is-active --quiet "$t"; then echo "refusing: $t is active; stop the timers first"; exit 1; fi
  done
  for j in $JOBS; do
    if systemctl is-active --quiet "$j"; then echo "refusing: $j is still running; wait for it"; exit 1; fi
  done
}

health() {
  for i in $(seq 1 30); do
    if curl -sf -m 5 http://127.0.0.1:8000/api/health >/dev/null; then return 0; fi
    sleep 1
  done
  echo "the API did not answer /api/health"; return 1
}

check_api() {
  # The board, a search through the index, and live facets, each with
  # rows. A failure here is before any writer has touched the new file, so
  # --rollback is clean.
  for q in "limit=5" "search=python&confidence=all&limit=5"; do
    code=$(curl -s -o /tmp/swap-compact.json -w "%{http_code}" -m 60 "http://127.0.0.1:8000/api/jobs?$q")
    python3 - "$code" "$q" <<'PY'
import json, sys
code, q = sys.argv[1], sys.argv[2]
d = json.load(open("/tmp/swap-compact.json"))
n = len(d.get("jobs", []))
if code != "200" or n == 0:
    sys.exit(f"/api/jobs?{q} after the swap: HTTP {code}, {n} rows. Run: sudo bash box/swap_compact.sh --rollback")
print(f"/api/jobs?{q}: HTTP {code}, {n} rows, total {d.get('total')}")
PY
  done
  code=$(curl -s -o /dev/null -w "%{http_code} %{time_total}s" -m 120 "http://127.0.0.1:8000/api/facets?country=US")
  case "$code" in 200*) echo "/api/facets?country=US: HTTP $code" ;;
    *) echo "/api/facets?country=US: HTTP $code. Run: sudo bash box/swap_compact.sh --rollback"; exit 1 ;; esac
}

start_writers() {
  for t in $TIMERS; do rm -f "$PAUSE/$t"; done
  systemctl start $TIMERS
}

if [ "${1:-}" = "--rollback" ]; then
  need_quiet
  [ -f "$D/jobs.db.pre-compact" ] || { echo "no $D/jobs.db.pre-compact to go back to"; exit 1; }
  systemctl stop litestream otj-api
  mkdir -p "$D/compact/rolled-back"
  # Listings the applier inserted after the swap took rowids the old file
  # never issued, and jobs-fts.db indexed them under those rowids. The old
  # file would hand the same rowids to other listings, so its epoch is
  # bumped: search falls back to LIKE (degraded, never wrong) until the
  # index is rebuilt for it (box/STAGE2-FTS.md, the invariant).
  grown=$(sudo -u ubuntu python3 - "$D" <<'PY'
import json, sqlite3, sys
from pathlib import Path
d = Path(sys.argv[1])
gens = sorted((d / "compact").glob("*/manifest.json"))
want = json.loads(gens[-1].read_text())["max_rowid"] if gens else None
top = sqlite3.connect(f"file:{d / 'jobs.db'}?mode=ro", uri=True).execute("SELECT MAX(rowid) FROM jobs").fetchone()[0]
print("yes" if want is None or top > want else "no")
PY
)
  mv "$D/jobs.db" "$D/compact/rolled-back/jobs.db"
  rm -f "$D/jobs.db-wal" "$D/jobs.db-shm"
  mv "$D/jobs.db.pre-compact" "$D/jobs.db"
  [ -f "$D/jobs.db.pre-compact-wal" ] && mv "$D/jobs.db.pre-compact-wal" "$D/jobs.db-wal"
  [ -f "$D/jobs.db.pre-compact-shm" ] && mv "$D/jobs.db.pre-compact-shm" "$D/jobs.db-shm"
  if [ "$grown" = "yes" ]; then
    sudo -u ubuntu sqlite3 "$D/jobs.db" \
      "UPDATE meta SET value = value || '-rolled-back-$(date -u +%Y%m%dT%H%M%SZ)' WHERE key = 'fts_rowid_epoch';"
    echo "rows were added after the swap: search uses LIKE until jobs-fts.db is rebuilt for this file"
  fi
  [ -f "$CONF.pre-compact" ] && cp "$CONF.pre-compact" "$CONF"
  if [ -d "$D/.jobs.db-litestream.pre-compact" ]; then
    rm -rf "$D/.jobs.db-litestream"
    mv "$D/.jobs.db-litestream.pre-compact" "$D/.jobs.db-litestream"
  fi
  systemctl start otj-api
  health
  systemctl start litestream
  start_writers
  echo "rolled back to the pre-compact file; the compact one is in $D/compact/rolled-back/"
  exit 0
fi

GEN="${1:?usage: swap_compact.sh <generation> | --rollback}"
S="$D/compact/$GEN"
need_quiet
[ ! -e "$D/jobs.db.pre-compact" ] || { echo "refusing: $D/jobs.db.pre-compact already exists (an earlier swap?)"; exit 1; }
[ -f "$S/manifest.json" ] || { echo "no $S/manifest.json: run box/compact_db.py first"; exit 1; }

sudo -u ubuntu python3 - "$S" "$D/jobs.db" <<'PY'
import hashlib, json, sqlite3, sys
from pathlib import Path
s, live = Path(sys.argv[1]), Path(sys.argv[2])
m = json.loads((s / "manifest.json").read_text())
want = m["files"]["jobs.db"]
p = s / "jobs.db"
h = hashlib.sha256()
with open(p, "rb") as f:
    for chunk in iter(lambda: f.read(8 << 20), b""):
        h.update(chunk)
if p.stat().st_size != want["bytes"] or h.hexdigest() != want["sha256"]:
    sys.exit("jobs.db does not match the manifest")
rows, top = sqlite3.connect(f"file:{live}?mode=ro", uri=True).execute(
    "SELECT COUNT(*), MAX(rowid) FROM jobs").fetchone()
if (rows, top) != (m["rows"], m["max_rowid"]):
    sys.exit(f"the live file moved on since the build: {rows},{top} vs {m['rows']},{m['max_rowid']}. Rebuild.")
print(f"generation {m['generation']}: matches the manifest and the live file, epoch {m['epoch']}, "
      f"{m['rows']:,} rows, {want['bytes']:,} bytes from {m['src_bytes']:,}")
PY
chown ubuntu:ubuntu "$S/jobs.db"
chmod 664 "$S/jobs.db"

systemctl stop litestream
systemctl stop otj-api
mv "$D/jobs.db" "$D/jobs.db.pre-compact"
[ -f "$D/jobs.db-wal" ] && mv "$D/jobs.db-wal" "$D/jobs.db.pre-compact-wal"
[ -f "$D/jobs.db-shm" ] && mv "$D/jobs.db-shm" "$D/jobs.db.pre-compact-shm"
[ -d "$D/.jobs.db-litestream" ] && mv "$D/.jobs.db-litestream" "$D/.jobs.db-litestream.pre-compact"
mv "$S/jobs.db" "$D/jobs.db"
sudo -u ubuntu sqlite3 "$D/jobs.db" "PRAGMA journal_mode=WAL;" >/dev/null

cp "$CONF" "$CONF.pre-compact"
python3 - "$CONF" <<'PY'
import re, sys
from pathlib import Path
conf = Path(sys.argv[1])
text = conf.read_text()
m = re.search(r"path: litestream/v(\d+)/jobs\n", text)
if not m:
    sys.exit("no litestream/vN/jobs replica path in the config; edit it by hand")
nxt = int(m.group(1)) + 1
conf.write_text(text.replace(m.group(0), f"path: litestream/v{nxt}/jobs\n"))
print(f"litestream: jobs.db now replicates to litestream/v{nxt}/jobs")
PY

systemctl start otj-api
health
check_api
systemctl start litestream
start_writers
echo "swapped to generation $GEN; the old file is $D/jobs.db.pre-compact (rollback: sudo bash box/swap_compact.sh --rollback)"
