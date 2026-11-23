"""Ask Workday, one job at a time, about open jobs its listing can't show.

Workday's listing stops at 2,000 jobs, so a read of a bigger board is
incomplete and closes nothing (probe.WORKDAY_TOTAL_LIMIT). Without this,
a job that really closes on one of those boards stays open on ours for
good. On 2026-11-05 70 boards held 17,735 open jobs their latest read
had not returned; a sample of 40 was half still live, half gone.

Each such job gets its detail endpoint asked. The answer feeds the same
clock a complete read does (loader/load_to_sqlite.close_missing_jobs):
live resets it, gone advances it, and a job closes after 6 hours and 3
gone answers. Workday's own answers, checked against a listing search by
id on those 40: 200 with a title is live, 404 or a 403 with errorCode
S22 is gone. Anything else (a block, a 406, a timeout) says nothing.

Rotation lives in CHECKED next to jobs.db: when each job is next due.
Gone jobs come back in 2 hours so they can close, live ones in 12.

    python box/workday_checks.py --limit 2000
"""

import argparse
import json
import os
import re
import sqlite3
import sys
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
for _p in (ROOT, ROOT / "loader", ROOT / "box"):
    sys.path.insert(0, str(_p))

import probe  # noqa: E402
from load_to_sqlite import CLOSE_AFTER, CLOSE_AFTER_READS  # noqa: E402
from lock import exclusive  # noqa: E402

DB = Path(os.environ.get("DATA_PATH", "/var/lib/otj/jobs.db"))
CHECKED = DB.with_name("workday-checked.json")
WORKERS = 8
RECHECK = {"gone": timedelta(hours=2), "live": timedelta(hours=12), None: timedelta(hours=6)}


def detail_url(url: str) -> str | None:
    """The cxs detail endpoint behind a job's public Workday URL."""
    u = urllib.parse.urlsplit(url)
    parts = [p for p in u.path.split("/") if p]
    if parts and re.fullmatch(r"[a-z]{2}-[A-Z]{2}", parts[0]):
        parts = parts[1:]  # locale prefix
    if "myworkdayjobs.com" not in u.netloc or len(parts) < 3 or parts[1] != "job":
        return None
    return f"https://{u.netloc}/wday/cxs/{u.netloc.split('.')[0]}/{parts[0]}/job/{'/'.join(parts[2:])}"


def verdict(status: int, body: str) -> str | None:
    """"live", "gone", or None when the answer proves nothing."""
    try:
        data = json.loads(body)
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    if status == 200:
        return "live" if (data.get("jobPostingInfo") or {}).get("title") else None
    if status == 404 or (status == 403 and data.get("errorCode") == "S22"):
        return "gone"
    return None


def candidates(conn: sqlite3.Connection) -> list[tuple[str, str]]:
    """(job id, url) of open jobs on boards past Workday's listing limit
    that the board's latest read did not return. The latest read is the
    board's newest last_seen: an unchanged board's read moves no rows."""
    big = conn.execute(
        "SELECT company_domain, max(last_seen) FROM jobs WHERE ats = 'workday' AND closed_at IS NULL"
        " GROUP BY 1 HAVING count(*) >= ?", (probe.WORKDAY_TOTAL_LIMIT,)).fetchall()
    rows = []
    for domain, latest in big:
        rows += conn.execute(
            "SELECT id, url FROM jobs WHERE company_domain = ? AND ats = 'workday' AND closed_at IS NULL"
            " AND julianday(last_seen) < julianday(?) - 1.0 / 48", (domain, latest)).fetchall()
    return rows


def record(conn: sqlite3.Connection, answers: dict[str, str], ts: str) -> dict[str, int]:
    """Feed the answers into the missing clock; close what has been gone
    for CLOSE_AFTER and CLOSE_AFTER_READS answers."""
    live = [(jid,) for jid, v in answers.items() if v == "live"]
    gone = [(ts, jid) for jid, v in answers.items() if v == "gone"]
    conn.executemany("UPDATE jobs SET missing_since = NULL, missing_reads = 0"
                     " WHERE id = ? AND closed_at IS NULL AND missing_since IS NOT NULL", live)
    conn.executemany("UPDATE jobs SET missing_since = COALESCE(missing_since, ?),"
                     " missing_reads = COALESCE(missing_reads, 0) + 1 WHERE id = ? AND closed_at IS NULL", gone)
    cutoff = (datetime.fromisoformat(ts) - CLOSE_AFTER).isoformat(timespec="seconds")
    closing = [(ts, jid) for (_, jid) in gone if conn.execute(
        "SELECT 1 FROM jobs WHERE id = ? AND closed_at IS NULL AND missing_since <= ? AND missing_reads >= ?",
        (jid, cutoff, CLOSE_AFTER_READS)).fetchone()]
    conn.executemany("UPDATE jobs SET closed_at = ? WHERE id = ?", closing)
    return {"live": len(live), "gone": len(gone), "closed": len(closing)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=2000)
    args = ap.parse_args()
    now = datetime.now(timezone.utc)
    ts = now.isoformat(timespec="seconds")
    try:
        due_at = json.loads(CHECKED.read_text())
    except (OSError, ValueError):
        due_at = {}
    ro = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=30)
    try:
        rows = candidates(ro)
    finally:
        ro.close()
    due_at = {jid: due_at[jid] for jid, _ in rows if jid in due_at}  # forget jobs no longer waiting
    todo = sorted((r for r in rows if due_at.get(r[0], "") <= ts), key=lambda r: due_at.get(r[0], ""))[:args.limit]
    print(f"{len(rows)} jobs past the listing limit, {len(todo)} asked this run")

    sess = probe.session()

    def ask(row):
        url = detail_url(row[1])
        if not url:
            return row[0], None
        try:
            r = sess.get(url, timeout=20, headers={"Accept": "application/json"})
            return row[0], verdict(r.status_code, r.text)
        except Exception:  # noqa: BLE001 -- no answer is not evidence either way
            return row[0], None

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        answered = list(pool.map(ask, todo))
    for jid, v in answered:
        due_at[jid] = (now + RECHECK[v]).isoformat(timespec="seconds")
    answers = {jid: v for jid, v in answered if v}

    with exclusive("workday-checks", wait=600) as got:
        if not got:
            print("disk lock busy, answers dropped; the jobs stay due")
            return 1
        conn = sqlite3.connect(DB, timeout=30)
        conn.execute("PRAGMA busy_timeout = 30000")
        try:
            with conn:
                counts = record(conn, answers, ts)
        finally:
            conn.close()
    CHECKED.write_text(json.dumps(due_at))
    print(f"workday checks: {counts['live']} live, {counts['gone']} gone, {counts['closed']} closed,"
          f" {len(answered) - len(answers)} no answer")
    return 0


if __name__ == "__main__":
    sys.exit(main())
