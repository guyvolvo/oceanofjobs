"""The account overview's route: answered from DynamoDB, computed in the background.

Computing the overview for forty skills takes longer than a request may
hold a statement, so it is never computed while the reader waits:
  - nothing stored: {"computing": true} at once, the copy stored shortly;
  - stored, fresh, same skills: that copy;
  - stored but old, or for other skills: that copy at once, marked
    updating, and a fresh one stored in the background;
  - polls landing on both workers start one computation between them
    (a marker item in the table);
  - the marker is never listed as an alert.

Run directly, no framework:  python tests/test_dashboard_route.py
"""
import json
import os
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))
for k, v in {"ALERTS_TABLE": "test-alerts", "DATA_BUCKET": "test-bucket", "DATA_KEY": "jobs.db",
             "AWS_DEFAULT_REGION": "il-central-1", "AWS_ACCESS_KEY_ID": "testing",
             "AWS_SECRET_ACCESS_KEY": "testing"}.items():
    os.environ.setdefault(k, v)

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failures.append(name)


class ConditionalCheckFailedException(Exception):
    pass


class FakeTable:
    """Enough of a DynamoDB table: get, put (with the one condition the
    route uses), delete, query by user."""

    class meta:  # noqa: N801
        class client:  # noqa: N801
            class exceptions:  # noqa: N801
                ConditionalCheckFailedException = ConditionalCheckFailedException

    def __init__(self):
        self.items, self.lock = {}, threading.Lock()

    def get_item(self, Key):
        with self.lock:
            item = self.items.get((Key["user_id"], Key["alert_id"]))
        return {"Item": dict(item)} if item else {}

    def put_item(self, Item, ConditionExpression=None, ExpressionAttributeValues=None):
        k = (Item["user_id"], Item["alert_id"])
        with self.lock:
            if ConditionExpression:
                have = self.items.get(k)
                if have and not have.get("started", 0) < ExpressionAttributeValues[":stale"]:
                    raise ConditionalCheckFailedException()
            self.items[k] = dict(Item)
        return {}

    def delete_item(self, Key):
        with self.lock:
            self.items.pop((Key["user_id"], Key["alert_id"]), None)
        return {}

    def query(self, **kwargs):
        with self.lock:
            return {"Items": [dict(v) for (u, _), v in self.items.items() if u == "u1"]}


import dashboard  # noqa: E402
import handler  # noqa: E402

table = FakeTable()
handler._alerts_table = table
SKILLS = ["python", "sql"]
handler.route_get_profile = lambda uid: {"profile": {"skills": list(SKILLS), "country": "IL"}}
handler.get_connection = lambda: None
runs = []


def fake_compute(conn, profile, page):
    runs.append(time.monotonic())
    time.sleep(0.4)
    return {"key": dashboard.scope_key(profile), "computed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "history": {"weeks": [1, 2]}, "counts": {"python": 5}, "matches": [{"id": "a"}], "suggested": []}


dashboard.compute = fake_compute


def wait_idle(timeout=5.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        with handler._dashboard_lock:
            if not handler._dashboard_running:
                return True
        time.sleep(0.05)
    return False


# Nothing stored.
t0 = time.monotonic()
r = handler.route_dashboard("u1")
check("with nothing stored the answer is 'computing', at once", r.get("computing") is True and time.monotonic() - t0 < 0.2,
      f"{r} in {time.monotonic() - t0:.2f}s")
check("the computation finishes in the background", wait_idle())
r = handler.route_dashboard("u1")
check("then the stored copy answers, not marked updating", r.get("matches") == [{"id": "a"}] and not r.get("updating"), repr(r))
check("one computation so far", len(runs) == 1, str(len(runs)))

# Stored but a day and a half old.
item = table.get_item(Key={"user_id": "u1", "alert_id": handler.DASHBOARD_ID})["Item"]
old = json.loads(item["blob"])
old["computed_at"] = (datetime.now(timezone.utc) - timedelta(hours=36)).isoformat(timespec="seconds")
item["blob"] = json.dumps(old)
table.put_item(Item=item)
t0 = time.monotonic()
r = handler.route_dashboard("u1")
check("an old copy answers at once, marked updating", r.get("updating") is True and r.get("matches") == [{"id": "a"}]
      and time.monotonic() - t0 < 0.2, repr(r))
wait_idle()
r = handler.route_dashboard("u1")
check("and a fresh copy is stored behind it", not r.get("updating") and r["computed_at"] != old["computed_at"], repr(r))

# The skills changed.
SKILLS[:] = ["rust"]
r = handler.route_dashboard("u1")
check("a copy for other skills answers, marked updating and as for other skills",
      r.get("updating") is True and r.get("for_other_skills") is True, repr(r))
wait_idle()
r = handler.route_dashboard("u1")
check("then the copy for the new skills", not r.get("updating") and r.get("key") == dashboard.scope_key({"skills": ["rust"], "country": "IL"}),
      repr(r))

# refresh=1 recomputes but still answers at once.
before = len(runs)
r = handler.route_dashboard("u1", refresh=True)
check("refresh answers from the stored copy, marked updating", r.get("updating") is True)
wait_idle()
check("and recomputes once", len(runs) == before + 1, f"{len(runs) - before}")

# Two workers polling at once start one computation.
before = len(runs)
handler.route_dashboard("u1", refresh=True)
handler._dashboard_running.clear()  # as the other worker, which has its own process memory
handler.route_dashboard("u1", refresh=True)
time.sleep(1.0)
check("polls on two workers start one computation between them", len(runs) - before == 1 and wait_idle(),
      f"computations started: {len(runs) - before}")
check("the marker is gone once the run ends",
      not table.get_item(Key={"user_id": "u1", "alert_id": handler.DASHBOARD_RUNNING_ID}))

# The marker is never an alert.
table.put_item(Item={"user_id": "u1", "alert_id": handler.DASHBOARD_RUNNING_ID, "started": 1})
table.put_item(Item={"user_id": "u1", "alert_id": "real-alert", "filter": {}, "active": True})
listed = [a["alert_id"] for a in handler.route_list_alerts("u1")["alerts"]]
check("the alert list holds only real alerts", listed == ["real-alert"], repr(listed))

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
