"""The applier's alert pacing, and the companies directory's edge lifetime.

Alerts wait while more than another full batch of fragments is queued,
for at most ALERTS_DEFER_MAX_S, so an evening backlog drains instead of
the applier spending half its turns on six alerts (2026-10-16).

Run directly, no framework:  python tests/test_alert_pacing.py
"""
import os
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
for k, v in {"ALERTS_TABLE": "test-alerts", "DATA_BUCKET": "test-bucket", "DATA_KEY": "jobs.db",
             "AWS_DEFAULT_REGION": "il-central-1", "AWS_ACCESS_KEY_ID": "testing",
             "AWS_SECRET_ACCESS_KEY": "testing", "DATA_PATH": str(Path(tempfile.mkdtemp()) / "jobs.db")}.items():
    os.environ[k] = v
sys.path.insert(0, str(ROOT / "box"))
import shadow_apply as sa  # noqa: E402

failed = 0


def check(name, ok):
    global failed
    print(("ok   " if ok else "FAIL ") + name)
    failed += not ok


def ran_ago(seconds):
    sa.ALERTS_STAMP.touch()
    t = time.time() - seconds
    os.utime(sa.ALERTS_STAMP, (t, t))


ran_ago(5 * 60)
check("not due yet: no alerts, queue or not", not sa._alerts_now(3, 3) and not sa._alerts_now(100, 10))
ran_ago(11 * 60)
check("due and caught up: alerts run", sa._alerts_now(3, 3))
check("due with one more batch left: alerts run", sa._alerts_now(20, 10))
check("due but a backlog queued: alerts wait", not sa._alerts_now(114, 11))
ran_ago(31 * 60)
check("waited past the cap: alerts run despite the backlog", sa._alerts_now(114, 11))
sa.ALERTS_STAMP.unlink()
check("never ran: alerts run", sa._alerts_now(114, 11))

sys.path.insert(0, str(ROOT / "api"))
from handler import _response  # noqa: E402

cc = _response(200, "{}", cache_seconds=300, edge="s-maxage=3600, stale-while-revalidate=86400")["headers"]["Cache-Control"]
check("directory: an hour at the edge, stale while refreshing", cc == "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400")
cc = _response(200, "{}", cache_seconds=60)["headers"]["Cache-Control"]
check("everything else keeps the default edge lifetime", cc == "public, max-age=60, s-maxage=180")

sys.exit(1 if failed else 0)
