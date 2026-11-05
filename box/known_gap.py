"""Resolved companies the five-minute sweep never polls.

The sweep reads its board list from known.json in S3, not from the
database, and nothing puts a company back once it falls out of that
file. On 2026-11-04, 1,700-odd resolved boards (Buildots, Skai,
DriveNets, SolarEdge, VAST Data, Fiverr, ...) had not been polled since
September: their old jobs stayed open and their new ones never arrived.

missing() is that gap: companies with an ATS and token the fast sweep
reads, not merged into another domain, and absent from known.json.
box/publish.py sends its size as CompaniesNotPolled every pass and
infra/alarms.tf emails when it stays above zero for a day.

    python box/known_gap.py           # print the gap
    python box/known_gap.py --json    # the missing entries, known.json shaped
"""

import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
for _p in (ROOT, ROOT / "api"):
    sys.path.insert(0, str(_p))

from probe import SLOW_BOARD_ATS  # noqa: E402
from same_company import SAME_COMPANY  # noqa: E402


def missing(conn: sqlite3.Connection, known: list[dict]) -> list[dict]:
    have = {e.get("domain") for e in known}
    rows = conn.execute("SELECT domain, ats, token FROM companies WHERE ats IS NOT NULL AND token IS NOT NULL")
    return [{"domain": d, "ats": a, "token": t} for d, a, t in rows
            if d not in have and a not in SLOW_BOARD_ATS and d not in SAME_COMPANY]


def load_known(bucket: str, s3=None) -> list[dict]:
    import boto3

    s3 = s3 or boto3.client("s3")
    return json.loads(s3.get_object(Bucket=bucket, Key="known.json")["Body"].read())


def count(db: Path, bucket: str, s3=None) -> int:
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        return len(missing(conn, load_known(bucket, s3)))
    finally:
        conn.close()


if __name__ == "__main__":
    import os

    conn = sqlite3.connect(f"file:{os.environ.get('DATA_PATH', '/var/lib/otj/jobs.db')}?mode=ro", uri=True)
    gap = missing(conn, load_known(os.environ["DATA_BUCKET"]))
    if "--json" in sys.argv:
        print(json.dumps(gap, ensure_ascii=False))
    else:
        print(f"{len(gap)} resolved companies not in known.json")
        for e in gap[:20]:
            print(f"  {e['domain']} ({e['ats']})")
