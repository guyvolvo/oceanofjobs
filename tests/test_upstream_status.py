"""Which upstream problems the site reports (handler.upstream_status):
only the components it runs on, only while they are not operational.

Run directly, no framework:  python tests/test_upstream_status.py
"""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))
os.environ.setdefault("ALERTS_TABLE", "test-alerts")
os.environ.setdefault("DATA_BUCKET", "test-bucket")
os.environ.setdefault("AWS_DEFAULT_REGION", "il-central-1")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "testing")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "testing")
os.environ.pop("AWS_PROFILE", None)

import handler  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + str(detail)))
    if not ok:
        failures.append(name)


url, vendor, effects = handler.STATUSPAGES[0]
got = handler.statuspage_problems({"components": [
    {"name": "Actions", "status": "degraded_performance"},
    {"name": "Codespaces", "status": "major_outage"},
    {"name": "Git Operations", "status": "operational"},
]}, vendor, effects)
check("only a component the site uses, as degraded",
      [(g["service"], g["level"]) for g in got] == [("GitHub Actions", "degraded")], got)
got = handler.statuspage_problems({"components": [{"name": "Actions", "status": "partial_outage"}]}, vendor, effects)
check("a partial outage reads as an outage", got[0]["level"] == "outage", got)
check("all operational reports nothing",
      handler.statuspage_problems({"components": [{"name": "Actions", "status": "operational"}]}, vendor, effects) == [])

got = handler.aws_problems([
    {"service": "ec2-il-central-1", "service_name": "Amazon EC2"},
    {"service": "multipleservices-me-central-1", "service_name": "Multiple services"},
    {"service": "cloudfront", "service_name": "Amazon CloudFront"},
])
check("AWS: our region and CloudFront, not the region next door",
      [g["service"] for g in got] == ["AWS Amazon EC2", "AWS Amazon CloudFront"], got)

print("\nall passed" if not failures else f"\n{len(failures)} failed")
sys.exit(1 if failures else 0)
