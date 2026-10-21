"""Fill in descriptions for open listings whose ATS list endpoint has none.

SmartRecruiters, BambooHR, JazzHR, Breezy and Personio only give a
listing's text one request per job, which the scrape skips on cost
(probe.DESCRIPTION_ATS). On 2026-10-21 that left 287k open listings, a
quarter of the board, with only a title on their page and in the
JobPosting markup Google reads.

Job pages, the API and MCP read the text from descriptions/{job_id}.json
in S3 before the column (api/handler.py _description_from_s3), so this
only writes that blob. It reads jobs.db and never writes it: the column
stays empty, which means search does not match words in these
descriptions. Newest listings first, up to --limit a run.

A listing is not asked again once it has a blob or its source answered
for good (gone, or no text). The ids live in DONE, one per line, next to
jobs.db. Timeouts, 429s and 5xx are retried on a later run.

    python box/describe_backfill.py --limit 20000
"""

import argparse
import json
import os
import re
import sqlite3
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
for _p in (ROOT, ROOT / "loader"):
    sys.path.insert(0, str(_p))

import probe  # noqa: E402
from descriptions import put_many  # noqa: E402

DB = Path(os.environ.get("DATA_PATH", "/var/lib/otj/jobs.db"))
DONE = DB.with_name("described-ids.txt")
ATS = ("smartrecruiters", "bamboohr", "jazzhr", "breezy", "personio")
MIN_CHARS = 200  # the same line the audit drew: under it the page is title-only
WORKERS = 4
LD_RE = re.compile(r'<script[^>]*application/ld\+json[^>]*>(.*?)</script>', re.S)


class Gone(Exception):
    """The source answered for good: the listing is gone or has no text."""


def ld_description(html: str) -> str | None:
    """The description from a page's schema.org JobPosting markup."""
    for block in LD_RE.findall(html):
        try:
            data = json.loads(block.strip())
        except ValueError:
            continue
        if isinstance(data, dict):
            data = data.get("@graph", [data])
        for item in data if isinstance(data, list) else []:
            if isinstance(item, dict) and item.get("@type") == "JobPosting" and item.get("description"):
                return item["description"]
    return None


def source(ats: str, url: str, external_id: str) -> tuple[str, str]:
    """(url to fetch, kind) for one listing."""
    if ats == "smartrecruiters":
        token = url.split("/")[3]
        return f"https://api.smartrecruiters.com/v1/companies/{token}/postings/{external_id}", "smartrecruiters"
    if ats == "bamboohr":
        return url.rstrip("/") + "/detail", "bamboohr"
    return url, "page"


def parse(kind: str, body: str) -> str | None:
    """Plain text for the site from one response body, or None."""
    if kind == "smartrecruiters":
        return probe.smartrecruiters_description(json.loads(body))
    if kind == "bamboohr":
        raw = ((json.loads(body).get("result") or {}).get("jobOpening") or {}).get("description")
    else:
        raw = ld_description(body)
    return probe._clean_text(raw) if raw else None


def fetch(sess, row) -> tuple[str, str | None]:
    """(job_id, text). Raises Gone for an answer that will not change;
    any other exception means try again another night."""
    job_id, ats, url, external_id = row
    target, kind = source(ats, url, external_id)
    r = sess.get(target, timeout=20, headers={"Accept": "text/html" if kind == "page" else "application/json"})
    if r.status_code in (404, 410):
        raise Gone(job_id)
    r.raise_for_status()
    text = parse(kind, r.text)
    if not text or len(text) < MIN_CHARS:
        raise Gone(job_id)
    return job_id, text


def todo(limit: int, done: set[str]) -> list[tuple]:
    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=30)
    try:
        rows = conn.execute(
            f"SELECT id, ats, url, external_id FROM jobs WHERE closed_at IS NULL AND ats IN ({','.join('?' * len(ATS))}) "
            "AND COALESCE(description_chars, 0) < ? ORDER BY first_seen DESC",
            (*ATS, MIN_CHARS),
        ).fetchall()
    finally:
        conn.close()
    return [r for r in rows if r[0] not in done][:limit]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=20000)
    ap.add_argument("--minutes", type=float, default=150, help="stop starting new work after this long")
    args = ap.parse_args()
    bucket = os.environ["DATA_BUCKET"]
    done = set(DONE.read_text().split()) if DONE.exists() else set()
    rows = todo(args.limit, done)
    print(f"{len(rows)} listings to describe ({len(done)} done before)")
    deadline = time.monotonic() + args.minutes * 60
    sess = probe.session()
    counts = {"written": 0, "gone": 0, "retry": 0}

    def one(row):
        if time.monotonic() > deadline:
            return None
        try:
            return fetch(sess, row)
        except Gone:
            counts["gone"] += 1
            return (row[0], None)
        except Exception:  # noqa: BLE001 -- transient, the next run asks again
            counts["retry"] += 1
            return None

    # Uploaded and recorded in batches, so a run stopped halfway keeps
    # what it already fetched.
    for start in range(0, len(rows), 500):
        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            results = [r for r in pool.map(one, rows[start:start + 500]) if r]
        landed = put_many(bucket, [(i, t) for i, t in results if t])
        counts["written"] += len(landed)
        finished = landed | {i for i, t in results if t is None}
        if finished:
            with DONE.open("a") as f:
                f.write("".join(f"{i}\n" for i in finished))
        if time.monotonic() > deadline:
            break
    print(f"described: {counts}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
