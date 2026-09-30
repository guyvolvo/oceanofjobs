"""The pipeline's freshness, as CloudWatch metrics, from the box.

Everything that watched the pipeline before 2026-09-30 asked the wrong
question. /api/health asked whether the database was up; the Lambda
alarms asked whether a function had thrown. Both were green for the 40
hours in which no Greenhouse, Ashby or SmartRecruiters listing reached
the board, because the database was up and the failing runs threw
nothing the alarms counted. What was wrong was visible only in the data:
the newest Greenhouse listing was a day and a half old.

So this publishes that, once per publish tick (box/publish.py, every 15
minutes): for each of the main sources, how many minutes since the last
listing from it arrived, plus how many delta fragments are waiting to be
applied. infra/alarms.tf turns those into alarms. A source that has been
quiet for three hours is not a quiet market, it is a stalled scraper.
"""

import sys
from datetime import datetime, timezone
from pathlib import Path

NAMESPACE = "OceanOfJobs"
# The sources whose silence means something. Each is polled every few
# minutes and posts many times an hour in normal times.
SOURCES = ("greenhouse", "ashby", "smartrecruiters", "lever", "comeet", "workday")
FRAGMENT_PREFIX = "deltas/"


def _parse(stamp: str) -> datetime | None:
    try:
        d = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def freshness_minutes(conn, now: datetime | None = None) -> dict[str, float]:
    """Minutes since the newest listing from each source arrived.

    One grouped MAX over the jobs table, about five seconds on the box's
    4.8GB database (measured 2026-09-30), so it runs once a tick and not
    once a source. A source with no rows at all is left out rather than
    reported as infinitely stale: that is an empty database, not a
    stalled scraper, and the alarm treats a missing value on its own.
    """
    now = now or datetime.now(timezone.utc)
    marks = ",".join("?" * len(SOURCES))
    out: dict[str, float] = {}
    for ats, seen in conn.execute(
            f"SELECT ats, MAX(first_seen) FROM jobs WHERE ats IN ({marks}) GROUP BY ats", SOURCES):
        when = _parse(seen or "")
        if when is not None:
            out[ats] = max(0.0, (now - when).total_seconds() / 60)
    return out


def pending_fragments(s3, bucket: str) -> int:
    """How many fragments the applier has not yet taken. One page: past a
    thousand the exact number stops mattering."""
    page = s3.list_objects_v2(Bucket=bucket, Prefix=FRAGMENT_PREFIX, MaxKeys=1000)
    return int(page.get("KeyCount") or 0)


def publish(db: Path, bucket: str, cw=None, s3=None, now: datetime | None = None) -> dict:
    """Read the numbers and put them to CloudWatch in one call. Returns
    what was sent, for the log and the tests."""
    import sqlite3

    import boto3

    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        fresh = freshness_minutes(conn, now)
    finally:
        conn.close()
    s3 = s3 or boto3.client("s3")
    pending = pending_fragments(s3, bucket) if bucket else None

    data = [{"MetricName": "SourceFreshnessMinutes", "Dimensions": [{"Name": "ats", "Value": ats}],
             "Value": round(minutes, 1), "Unit": "None"} for ats, minutes in sorted(fresh.items())]
    if pending is not None:
        data.append({"MetricName": "PendingFragments", "Value": pending, "Unit": "Count"})
    if data:
        cw = cw or boto3.client("cloudwatch")
        cw.put_metric_data(Namespace=NAMESPACE, MetricData=data)
    return {"freshness_minutes": fresh, "pending_fragments": pending}


if __name__ == "__main__":
    import os

    sent = publish(Path(os.environ.get("DATA_PATH", "/var/lib/otj/jobs.db")), os.environ.get("DATA_BUCKET", ""))
    print(sent, file=sys.stderr)
