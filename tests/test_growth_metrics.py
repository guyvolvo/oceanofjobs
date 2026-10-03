"""The growth dashboard's numbers.

api/events.py: only known event names count, a page can't send the
server's own events, one client can't push a minute past the cap, and a
flush sends one Events datum per name and starts over.
POST /api/event: 204 for a known name, 400 for anything else, 405 for GET.
box/growth.py: accounts walk every page of the pool and count the new
ones, alerts count people once, listings come from stats.json, and one
failing source leaves the others.

Run directly, no framework:  python tests/test_growth_metrics.py
"""
import io
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
for p in (ROOT / "api", ROOT / "box", ROOT):
    sys.path.insert(0, str(p))
for k, v in {"ALERTS_TABLE": "test-alerts", "DATA_BUCKET": "test-bucket", "DATA_KEY": "jobs.db",
             "AWS_DEFAULT_REGION": "il-central-1", "AWS_ACCESS_KEY_ID": "testing",
             "AWS_SECRET_ACCESS_KEY": "testing"}.items():
    os.environ.setdefault(k, v)
os.environ["DATA_PATH"] = "/tmp/jobs.db"
os.environ.pop("AWS_LAMBDA_FUNCTION_NAME", None)

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failures.append(name)


class FakeCW:
    def __init__(self):
        self.calls = []

    def put_metric_data(self, **kw):
        self.calls.append(kw)


import events  # noqa: E402

events._ensure_flusher = lambda: None  # no background thread in a test

events.take()
check("a known page event counts", events.record("apply") and events.record("apply") and events.record("visit"))
check("an unknown name is refused", not events.record("drop_tables") and not events.record(""))
check("a page can't send a server event", not events.record("alert_created"))
check("the server can", events.record("alert_created", from_page=False))
cw = FakeCW()
sent = events.flush(cw)
check("a flush sends what was counted", sent == {"apply": 2, "visit": 1, "alert_created": 1}, repr(sent))
datums = cw.calls[0]["MetricData"]
check("one Events datum per name, in the OceanOfJobs namespace",
      cw.calls[0]["Namespace"] == "OceanOfJobs" and len(datums) == 3
      and all(d["MetricName"] == "Events" and d["Dimensions"][0]["Name"] == "event" for d in datums), repr(datums))
cw2 = FakeCW()
check("a second flush with nothing counted sends nothing", events.flush(cw2) == {} and not cw2.calls)
for _ in range(events.MAX_PER_MINUTE + 50):
    events.record("search")
check("one minute is capped per event", events.take().get("search") == events.MAX_PER_MINUTE)
os.environ["AWS_LAMBDA_FUNCTION_NAME"] = "fallback"
events.record("visit")
check("nothing is counted on the Lambda fallback", events.take() == {})
os.environ.pop("AWS_LAMBDA_FUNCTION_NAME")

import handler  # noqa: E402


def call(method, query):
    return handler.lambda_handler({"rawPath": "/api/event", "rawQueryString": query,
                                   "requestContext": {"http": {"method": method}}, "headers": {}}, None)


r = call("POST", "e=apply")
check("POST /api/event with a known name is 204, uncached",
      r["statusCode"] == 204 and r["headers"].get("Cache-Control") == "no-store", repr(r)[:200])
check("and it counted", events.take().get("apply") == 1)
check("an unknown name is 400", call("POST", "e=whatever")["statusCode"] == 400)
check("GET is 405", call("GET", "e=apply")["statusCode"] == 405)

import growth  # noqa: E402

NOW = datetime(2026, 10, 3, 12, tzinfo=timezone.utc)


class FakeCognito:
    def __init__(self, ages_h):
        users = [{"Username": f"u{i}", "UserCreateDate": NOW - timedelta(hours=h)} for i, h in enumerate(ages_h)]
        self.pages = [users[i:i + 60] for i in range(0, len(users), 60)] or [[]]
        self.asked = []

    def list_users(self, **kw):
        self.asked.append(kw)
        i = int(kw.get("PaginationToken") or 0)
        out = {"Users": self.pages[i]}
        if i + 1 < len(self.pages):
            out["PaginationToken"] = str(i + 1)
        return out


cog = FakeCognito([1] * 3 + [30] * 5 + [24 * 10] * 120)
got = growth.account_counts(cog, "pool", NOW)
check("accounts walk every page and count the new ones",
      got == {"Accounts": 128, "NewAccounts24h": 3, "NewAccounts7d": 8}, repr(got))
check("no attributes are asked for, so no email leaves the pool",
      all(kw.get("AttributesToGet") == [] for kw in cog.asked) and len(cog.asked) == 3)


class FakeTable:
    def scan(self, **kw):
        return {"Items": [{"user_id": "a", "alert_id": "1", "active": True},
                          {"user_id": "a", "alert_id": "2", "active": True},
                          {"user_id": "b", "alert_id": "3", "active": True}]}


check("alerts count people once", growth.alert_counts(FakeTable()) == {"ActiveAlerts": 3, "UsersWithAlerts": 2})


class FakeS3:
    def get_object(self, Bucket, Key):
        assert Key == "precomputed/stats.json"
        return {"Body": io.BytesIO(json.dumps({"totals": {"open_jobs": 282722, "companies_hiring": 8896}}).encode())}


check("listings come from the precomputed stats",
      growth.listing_counts(FakeS3(), "b") == {"OpenListings": 282722, "CompaniesHiring": 8896})


class Broken:
    def list_users(self, **kw):
        raise RuntimeError("AccessDenied")


os.environ["COGNITO_ISSUER"] = "https://cognito-idp.il-central-1.amazonaws.com/il-central-1_test"
vals = growth.collect(cognito=Broken(), table=FakeTable(), s3=FakeS3(), now=NOW)
check("one source failing leaves the others",
      "Accounts" not in vals and vals.get("ActiveAlerts") == 3 and vals.get("OpenListings") == 282722, repr(vals))
cw = FakeCW()
growth.publish(vals, cw)
check("gauges go out in one call, by name",
      {d["MetricName"] for d in cw.calls[0]["MetricData"]} == set(vals) and cw.calls[0]["Namespace"] == "OceanOfJobs")
cw = FakeCW()
growth.count_event("digest_sent", 0, cw)
d = cw.calls[0]["MetricData"][0]
check("a digest count of zero still goes out, as an Events datum",
      d["MetricName"] == "Events" and d["Value"] == 0 and d["Dimensions"] == [{"Name": "event", "Value": "digest_sent"}])

sys.path.insert(0, str(ROOT / "infra" / "grafana"))
import growth_dashboard  # noqa: E402

dash = growth_dashboard.build()
import re  # noqa: E402
queries = [t for p in dash["panels"] for t in p.get("targets", [])]
names = {t.get("dimensions", {}).get("event") for t in queries} - {None}
names |= set(re.findall(r'event="([a-z_]+)"', " ".join(t.get("expression", "") for t in queries)))
check("the dashboard shows the page events", {"visit", "new_visitor", "search", "job_view", "apply", "signin"} <= names, repr(names))
check("every event the dashboard shows is one that gets counted",
      names <= (events.PAGE_EVENTS | events.SERVER_EVENTS | {"digest_sent"}), repr(names))
gauges = {t["metricName"] for p in dash["panels"] for t in p.get("targets", []) if t.get("namespace") == "OceanOfJobs"} - {"Events"}
check("every gauge the dashboard shows is one that gets sent",
      gauges <= {"Accounts", "NewAccounts7d", "ActiveAlerts", "UsersWithAlerts", "OpenListings", "CompaniesHiring",
                 "PendingFragments", "SourceFreshnessMinutes"}, repr(gauges))

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
