"""Render the job alert mail with fixture data, to a file you can open.

    python scripts/alert_email/render_fixture.py [out.html]

Four listings: one under 24 hours old, one with a logo this site serves,
one with a hot-linked logo (shown as a letter, like one with none), one
Hebrew title. Nothing is sent. The text part is written beside it as
.txt.
"""
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "api"))
os.environ.setdefault("AWS_DEFAULT_REGION", "il-central-1")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "testing")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "testing")

import alerts  # noqa: E402

NOW = datetime(2026, 9, 30, 12, 0, tzinfo=timezone.utc)
ALERT = {"alert_id": "a1", "user_id": "u1", "email": "someone@example.com",
         "filter": {"country": "IL", "search": ""},
         "last_digest_at": (NOW - timedelta(days=1)).isoformat()}


def job(**over):
    base = {"id": "5f2a9c1e7b3d4a60", "title": "Staff Data Scientist (Armis)", "company_domain": "armis.com",
            "company_name": "Armis", "city": "Tel Aviv", "country": "IL", "location": "Tel Aviv, Israel",
            "url": "https://boards.greenhouse.io/armis/jobs/1", "logo_url": None,
            "posted_at": (NOW - timedelta(days=15)).isoformat(), "first_seen": (NOW - timedelta(hours=3)).isoformat(),
            "seniority": "staff", "workplace_type": "hybrid", "salary_text": "₪45K – ₪60K",
            "salary_is_estimate": 1, "salary_source": "model"}
    base.update(over)
    return base


MATCHES = [
    job(),
    job(id="1a2b3c4d5e6f7081", title="Staff Security Engineer - Application/Product Security", city="Petah Tikva",
        location="Petah Tikva, Israel", url="https://boards.greenhouse.io/armis/jobs/2",
        posted_at=(NOW - timedelta(days=21)).isoformat(), logo_url="https://www.armis.com/favicon.ico"),
    job(id="9f8e7d6c5b4a3921", title="Senior Platform Architect", company_domain="ubisoft.com", company_name="Ubisoft",
        city="Montreal", country="CA", location="Montreal, Canada", url="https://jobs.smartrecruiters.com/Ubisoft2/1",
        logo_url=f"{alerts.SITE_ORIGIN}/img/logos/ubisoft.png", posted_at=(NOW - timedelta(days=4)).isoformat()),
    job(id="c0ffee0123456789", title="מהנדס/ת מערכת שבבים", company_domain="arbe.com", company_name="Arbe",
        url="https://arbe.com/careers/7", posted_at=(NOW - timedelta(hours=5)).isoformat(),
        first_seen=(NOW - timedelta(hours=1)).isoformat()),
]

out = Path(sys.argv[1] if len(sys.argv) > 1 else "alert-email-preview.html")
out.write_text(alerts._digest_html(len(MATCHES), MATCHES, ALERT, NOW), encoding="utf-8")
out.with_suffix(".txt").write_text(alerts._digest_text(len(MATCHES), MATCHES, ALERT, NOW), encoding="utf-8")
print(f"wrote {out} and {out.with_suffix('.txt')}; subject: {alerts.digest_subject(ALERT, MATCHES)}")
