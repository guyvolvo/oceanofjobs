"""Today's Cloudflare Workers requests against the free plan's daily allowance.

    CLOUDFLARE_ANALYTICS_TOKEN=... python scripts/workers_quota.py

Exits 1 at 70% of the allowance, so the scheduled workflow
(.github/workflows/workers-quota.yml) fails and GitHub emails, hours
before the account runs out. Out of allowance, the MCP route falls back
to CloudFront's 503 and otj-box-router, which fails closed, answers the
board's API with Cloudflare's error page until 00:00 UTC.

The token needs one permission: Account Analytics, Read, on this account.
Without one this warns and exits 0, so a missing secret is visible on
the run without failing it every half hour.
"""

import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

ACCOUNT = "2f08a903f97b2824af964b0d4a85a1ed"
DAILY_ALLOWANCE = 100_000
# WORKERS_ALERT_AT overrides it for a controlled test of the alert, from
# the workflow's alert_at input: a low value makes today's real number fail.
ALERT_AT = float(os.environ.get("WORKERS_ALERT_AT") or 0.70)
QUERY = """query($a: String!, $s: Time!, $e: Time!) { viewer { accounts(filter: {accountTag: $a}) {
  workersInvocationsAdaptive(limit: 100, filter: {datetime_geq: $s, datetime_lt: $e}) {
    sum { requests errors } dimensions { scriptName } } } } }"""


def main() -> int:
    token = os.environ.get("CLOUDFLARE_ANALYTICS_TOKEN", "").strip()
    if not token:
        print("::warning::CLOUDFLARE_ANALYTICS_TOKEN is not set, so Workers usage is not being watched")
        return 0
    now = datetime.now(timezone.utc)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    body = json.dumps({"query": QUERY, "variables": {
        "a": ACCOUNT, "s": start.isoformat().replace("+00:00", "Z"),
        "e": (start + timedelta(days=1)).isoformat().replace("+00:00", "Z")}}).encode()
    req = urllib.request.Request("https://api.cloudflare.com/client/v4/graphql", data=body,
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.load(r)
    if d.get("errors"):
        print(f"::error::Cloudflare analytics refused the query: {d['errors'][0].get('message')}")
        return 1
    rows = d["data"]["viewer"]["accounts"][0]["workersInvocationsAdaptive"]
    by_script = {r["dimensions"]["scriptName"]: r["sum"]["requests"] for r in rows}
    total = sum(by_script.values())
    share = total / DAILY_ALLOWANCE
    hours = (now - start).total_seconds() / 3600
    lines = [f"Workers requests today (UTC, {hours:.1f}h in): {total:,} of {DAILY_ALLOWANCE:,} ({share:.0%})"]
    lines += [f"  {name}: {n:,}" for name, n in sorted(by_script.items(), key=lambda kv: -kv[1])]
    print("\n".join(lines))
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
    if share >= ALERT_AT:
        print(f"::error::Workers usage is at {share:.0%} of the daily allowance, {hours:.1f}h into the UTC day. "
              "At 100% the MCP answers its 503 and the board's API route fails closed until 00:00 UTC.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
