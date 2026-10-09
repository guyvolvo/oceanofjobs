"""An address SES refuses still moves its alert's watermark.

In the SES sandbox an unverified address is refused on every send. If the
watermark stayed put, that alert would be re-matched and re-sent on every
pass, over a window that only grows. A send that fails for any other
reason (throttling, a network error) keeps the watermark, so it is retried.

Run directly, no framework:  python tests/test_alert_rejected.py
"""

import os
import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "api"))

os.environ.setdefault("ALERTS_TABLE", "test-alerts")
os.environ.setdefault("DATA_BUCKET", "test-bucket")
os.environ.setdefault("DATA_KEY", "jobs.db")
os.environ.setdefault("AWS_DEFAULT_REGION", "il-central-1")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "testing")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "testing")

import alerts  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failures.append(name)


class Table:
    def __init__(self):
        self.updates = []

    def update_item(self, **kw):
        self.updates.append(kw["Key"]["alert_id"])


def run(send):
    table = Table()
    alerts.ALERTS_TABLE = "test-alerts"
    alerts._dynamodb = type("D", (), {"Table": lambda self, name: table})()
    alerts._scan_active_alerts = lambda t: [{"user_id": "u1", "alert_id": "a1", "created_at": "2026-01-01T00:00:00+00:00",
                                             "last_notified_at": "2026-01-01T00:00:00+00:00"}]
    alerts._profiles = lambda t, ids: {}
    alerts._find_new_matches = lambda conn, alert: [{"id": "j1"}]
    alerts.is_fresh = lambda m, now: True
    alerts._watched_domains = lambda a: set()
    alerts._recently_matching_domains = lambda conn, a: set()
    alerts._send_digest = send
    with tempfile.TemporaryDirectory() as d:
        db = Path(d) / "jobs.db"
        sqlite3.connect(db).close()
        out = alerts.evaluate_alerts(db)
    return table.updates, out


def rejected(alert, matches):
    raise alerts._ses.exceptions.MessageRejected(
        {"Error": {"Code": "MessageRejected", "Message": "Email address is not verified."}}, "SendEmail")


def throttled(alert, matches):
    raise RuntimeError("TooManyRequests")


updates, out = run(rejected)
check("a refused address moves the watermark and is reported", updates == ["a1"] and out["errors"] and out["digests_sent"] == 0,
      f"{updates} {out}")
updates, out = run(throttled)
check("any other send failure keeps the watermark, so the digest is retried", updates == [] and out["errors"],
      f"{updates} {out}")
updates, out = run(lambda alert, matches: None)
check("a sent digest moves the watermark", updates == ["a1"] and out["digests_sent"] == 1, f"{updates} {out}")

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
