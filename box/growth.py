"""Growth gauges for the Grafana dashboard, from the box, once an hour.

The page counts (visits, searches, apply clicks) come from the API
itself (api/events.py). These are the numbers that only exist as state:

  Accounts, NewAccounts24h, NewAccounts7d  the Cognito user pool
  ActiveAlerts, UsersWithAlerts           the alerts table in DynamoDB
  OpenListings, CompaniesHiring           precomputed/stats.json in S3

All of it is read over the network, none from jobs.db, so it never
waits on the disk. The publisher calls maybe_publish on every tick
(box/publish.py), and it sends at most once an hour.

Cognito is listed with no attributes at all, so no email address
leaves the pool for this: only each account's creation date.
"""

import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

NAMESPACE = "OceanOfJobs"
EVERY_S = 3600
# Past this many pages (60 accounts each) the count is the pool's own
# estimate instead of an exact walk.
MAX_USER_PAGES = 200


def account_counts(cognito, pool_id: str, now: datetime) -> dict[str, int]:
    total = new_24h = new_7d = 0
    token = None
    for _ in range(MAX_USER_PAGES):
        kw = {"UserPoolId": pool_id, "AttributesToGet": [], "Limit": 60}
        if token:
            kw["PaginationToken"] = token
        page = cognito.list_users(**kw)
        for user in page.get("Users", []):
            total += 1
            made = user.get("UserCreateDate")
            if made is not None:
                if made.tzinfo is None:
                    made = made.replace(tzinfo=timezone.utc)
                age = now - made
                new_24h += age <= timedelta(hours=24)
                new_7d += age <= timedelta(days=7)
        token = page.get("PaginationToken")
        if not token:
            break
    else:
        total = int(cognito.describe_user_pool(UserPoolId=pool_id)["UserPool"].get("EstimatedNumberOfUsers") or total)
    return {"Accounts": total, "NewAccounts24h": new_24h, "NewAccounts7d": new_7d}


def alert_counts(table) -> dict[str, int]:
    from alerts import _scan_active_alerts

    alerts = _scan_active_alerts(table)
    return {"ActiveAlerts": len(alerts), "UsersWithAlerts": len({a["user_id"] for a in alerts})}


def listing_counts(s3, bucket: str) -> dict[str, int]:
    body = s3.get_object(Bucket=bucket, Key="precomputed/stats.json")["Body"].read()
    totals = json.loads(body).get("totals") or {}
    out = {}
    if totals.get("open_jobs") is not None:
        out["OpenListings"] = int(totals["open_jobs"])
    if totals.get("companies_hiring") is not None:
        out["CompaniesHiring"] = int(totals["companies_hiring"])
    return out


def collect(cognito=None, table=None, s3=None, now: datetime | None = None) -> dict[str, int]:
    """Every gauge that can be read now. One source failing leaves the
    others: a missing point on one panel beats a blank dashboard."""
    import boto3

    now = now or datetime.now(timezone.utc)
    out: dict[str, int] = {}
    issuer = os.environ.get("COGNITO_ISSUER", "")
    if issuer:
        try:
            out.update(account_counts(cognito or boto3.client("cognito-idp"), issuer.rstrip("/").rsplit("/", 1)[-1], now))
        except Exception as e:  # noqa: BLE001
            print(f"growth: accounts failed: {e!r}", file=sys.stderr)
    table_name = os.environ.get("ALERTS_TABLE", "")
    if table_name or table is not None:
        try:
            out.update(alert_counts(table if table is not None else boto3.resource("dynamodb").Table(table_name)))
        except Exception as e:  # noqa: BLE001
            print(f"growth: alerts failed: {e!r}", file=sys.stderr)
    bucket = os.environ.get("DATA_BUCKET", "")
    if bucket:
        try:
            out.update(listing_counts(s3 or boto3.client("s3"), bucket))
        except Exception as e:  # noqa: BLE001
            print(f"growth: listings failed: {e!r}", file=sys.stderr)
    return out


def publish(values: dict[str, int], cw=None) -> None:
    if not values:
        return
    import boto3

    data = [{"MetricName": name, "Value": v, "Unit": "Count"} for name, v in sorted(values.items())]
    (cw or boto3.client("cloudwatch")).put_metric_data(Namespace=NAMESPACE, MetricData=data)


def maybe_publish(stamp: Path) -> dict[str, int] | None:
    """Collect and send if the last send was an hour ago or more."""
    try:
        if time.time() - stamp.stat().st_mtime < EVERY_S:
            return None
    except OSError:
        pass
    stamp.touch()
    values = collect()
    publish(values)
    return values


def count_event(name: str, n: int, cw=None) -> None:
    """One server-side count into the same Events metric the pages feed
    (api/events.py), e.g. the digests the applier just sent."""
    import boto3

    (cw or boto3.client("cloudwatch")).put_metric_data(Namespace=NAMESPACE, MetricData=[
        {"MetricName": "Events", "Dimensions": [{"Name": "event", "Value": name}], "Value": n, "Unit": "Count"}])
