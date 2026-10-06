"""What the box looks like with and without the scrape worker on it.

    python3 box/trial_metrics.py sample            # one line, every minute from otj-trial.timer
    python3 box/trial_metrics.py report --since "2026-10-06 12:00" --until "2026-10-07 12:00"

The question the worker trial asks is whether scraping on the box costs
the site anything (box/scrape_worker.py). Memory it takes comes out of
the page cache holding the databases, so the answer is in request times
and disk stalls rather than in the worker's own size. sample records the
box once a minute to a local CSV (no CloudWatch metrics, which cost
money per metric); report reads that and the API's access log for a
window, so a baseline window and a trial window can be put side by side.

Request times need gunicorn's %(L)s at the end of the access log line
(see CUTOVER.md, otj-api).
"""
import argparse
import csv
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

OUT = Path(os.environ.get("TRIAL_METRICS_CSV", "/var/lib/otj-trial/samples.csv"))
FIELDS = ["at", "mem_available_mb", "cached_mb", "worker_mb", "io_some_avg60", "io_full_avg60",
          "mem_some_avg60", "cpu_pct", "load1"]


def _meminfo():
    out = {}
    for line in Path("/proc/meminfo").read_text().splitlines():
        k, v = line.split(":", 1)
        out[k] = int(v.split()[0]) / 1024
    return out


def _psi(kind):
    some = full = 0.0
    for line in Path(f"/proc/pressure/{kind}").read_text().splitlines():
        avg60 = float(re.search(r"avg60=([\d.]+)", line).group(1))
        if line.startswith("some"):
            some = avg60
        else:
            full = avg60
    return some, full


def _cpu_pct():
    def read():
        f = [int(x) for x in Path("/proc/stat").read_text().splitlines()[0].split()[1:]]
        return sum(f), f[3] + f[4]
    t1, i1 = read()
    time.sleep(1)
    t2, i2 = read()
    return 100.0 * (1 - (i2 - i1) / max(1, t2 - t1))


def _worker_mb():
    """The scrape worker unit's own memory, page cache included, from its
    cgroup. 0 when it is not running."""
    p = Path("/sys/fs/cgroup/system.slice/otj-scrape.service/memory.current")
    try:
        return int(p.read_text()) / 2**20
    except OSError:
        return 0.0


def sample():
    m = _meminfo()
    io_some, io_full = _psi("io")
    mem_some, _ = _psi("memory")
    row = {"at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "mem_available_mb": round(m["MemAvailable"]), "cached_mb": round(m["Cached"]),
           "worker_mb": round(_worker_mb()), "io_some_avg60": io_some, "io_full_avg60": io_full,
           "mem_some_avg60": mem_some, "cpu_pct": round(_cpu_pct(), 1),
           "load1": float(Path("/proc/loadavg").read_text().split()[0])}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    new = not OUT.exists()
    with OUT.open("a", newline="") as fh:
        w = csv.DictWriter(fh, FIELDS)
        if new:
            w.writeheader()
        w.writerow(row)


def _pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p * (len(xs) - 1))))] if xs else None


# 127.0.0.1 - - [06/Oct/2026:10:00:00 +0000] "GET /api/jobs?x HTTP/1.1" 200 123 "ref" "ua" 0.123456
LINE = re.compile(r'"(?:GET|HEAD) (\S+) HTTP/[\d.]+" (\d{3}) \S+ "[^"]*" "[^"]*" ([\d.]+)$')


def _route(path):
    p = path.split("?", 1)[0]
    for prefix, name in (("/api/jobs", "/api/jobs"), ("/api/facets", "/api/facets"), ("/api/stats", "/api/stats"),
                         ("/api/me", "/api/me"), ("/job/", "/job"), ("/company/", "/company"), ("/logo/", "/logo")):
        if p.startswith(prefix):
            return name
    return "other"


def report(since, until):
    log = subprocess.run(["journalctl", "-u", "otj-api", "--since", since, "--until", until,
                          "--no-pager", "-o", "cat"], capture_output=True, text=True).stdout
    by = {}
    for line in log.splitlines():
        m = LINE.search(line)
        if m and m.group(2) != "304":
            by.setdefault(_route(m.group(1)), []).append(float(m.group(3)))
    print(f"API request time, {since} to {until} (seconds)")
    print(f"{'route':14}{'n':>7}{'p50':>8}{'p95':>8}{'p99':>8}{'max':>8}")
    for route, xs in sorted(by.items(), key=lambda kv: -len(kv[1])):
        print(f"{route:14}{len(xs):>7}{_pct(xs, .5):>8.3f}{_pct(xs, .95):>8.3f}{_pct(xs, .99):>8.3f}{max(xs):>8.2f}")
    alls = [x for xs in by.values() for x in xs]
    if alls:
        print(f"{'all':14}{len(alls):>7}{_pct(alls, .5):>8.3f}{_pct(alls, .95):>8.3f}{_pct(alls, .99):>8.3f}{max(alls):>8.2f}")

    rows = []
    if OUT.exists():
        lo = datetime.fromisoformat(since.replace(" ", "T")).replace(tzinfo=timezone.utc)
        hi = datetime.fromisoformat(until.replace(" ", "T")).replace(tzinfo=timezone.utc)
        with OUT.open() as fh:
            rows = [r for r in csv.DictReader(fh) if lo <= datetime.fromisoformat(r["at"]) < hi]
    print(f"\nbox, {len(rows)} one-minute samples")
    for f in FIELDS[1:]:
        xs = [float(r[f]) for r in rows]
        if xs:
            print(f"{f:18} mean {sum(xs) / len(xs):9.1f}  p50 {_pct(xs, .5):9.1f}  p95 {_pct(xs, .95):9.1f}  min {min(xs):9.1f}  max {max(xs):9.1f}")
    oom = subprocess.run(["journalctl", "-k", "--since", since, "--until", until, "--no-pager", "-o", "cat"],
                         capture_output=True, text=True).stdout
    kills = [ln for ln in oom.splitlines() if "Out of memory" in ln or "oom-kill" in ln]
    print(f"\nout-of-memory kills: {len(kills)}")
    for ln in kills[:10]:
        print("  " + ln[:160])


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=("sample", "report"))
    ap.add_argument("--since")
    ap.add_argument("--until")
    a = ap.parse_args()
    if a.mode == "sample":
        sample()
    else:
        if not (a.since and a.until):
            sys.exit("report needs --since and --until")
        report(a.since, a.until)
