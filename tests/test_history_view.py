"""Application history as the account page shows it (handler._history_view):
rows matched to board listings by id, old reason codes in today's words,
and "unconfirmed" instead of "failed" where no confirmation was seen.

Run directly, no framework:  python tests/test_history_view.py
"""
import os
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))
for k, v in {"ALERTS_TABLE": "test-alerts", "DATA_BUCKET": "test-bucket", "DATA_KEY": "jobs.db", "AWS_DEFAULT_REGION": "il-central-1",
             "AWS_ACCESS_KEY_ID": "testing", "AWS_SECRET_ACCESS_KEY": "testing"}.items():
    os.environ.setdefault(k, v)

import apply  # noqa: E402
import handler  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failures.append(name)


db = sqlite3.connect(":memory:", check_same_thread=False)
db.executescript("""
CREATE TABLE jobs (id TEXT PRIMARY KEY, title TEXT, company_domain TEXT);
CREATE TABLE companies (domain TEXT PRIMARY KEY, company_name TEXT);
INSERT INTO jobs VALUES ('aaaaaaaaaaaaaaaa', 'Kubernetes Researcher', 'pointfive.com');
INSERT INTO jobs VALUES ('bbbbbbbbbbbbbbbb', 'Infrastructure Engineer', 'wayve.ai');
INSERT INTO companies VALUES ('pointfive.com', 'PointFive');
""")
handler.get_connection = lambda: db

rows = handler._history_view([
    {"job_id": "aaaaaaaaaaaaaaaa", "title": "x", "company": "pointfive.com", "status": "failed",
     "reason": "no confirmation after submitting", "url": "https://jobs.ashbyhq.com/pointfive/1"},
    {"job_id": "bbbbbbbbbbbbbbbb", "title": "Infrastructure Engineer", "company": "wayve.ai", "status": "failed",
     "reason": "could not fill Location: no options to pick from"},
    {"job_id": "cccccccccccccccc", "title": "System Architect", "company": "www.fetcherr.io", "status": "skipped",
     "reason": "not submitted", "url": "https://www.fetcherr.io/careers/1"},
    {"job_id": "dddddddddddddddd", "title": "DevOps", "company": "at-bay.com", "status": "failed",
     "reason": "form errors: Resume/CV is required."},
])
a, b, c, d = rows
check("a board job takes the board's title and company name", a["title"] == "Kubernetes Researcher" and a["company"] == "PointFive", repr(a))
check("and links to its board page", a["link"] == "/job/aaaaaaaaaaaaaaaa", repr(a))
check("no confirmation is unconfirmed, not failed, in today's words",
      a["status"] == "unconfirmed" and a["reason"] == "The form was sent, but the site didn't confirm it. Check for a confirmation email.", repr(a))
check("a company with no stored name keeps its domain", b["company"] == "wayve.ai", repr(b))
check("field reasons keep the field name", b["reason"] == "Couldn't fill in Location: There are no options in this list.", b["reason"])
check("a page not on the board keeps its own title and links to that page",
      c["title"] == "System Architect" and c["link"] == "https://www.fetcherr.io/careers/1", repr(c))
check("a skipped send reads as a closed tab", c["reason"] == "The tab closed before the application was submitted.", c["reason"])
check("form errors keep the site's message", d["reason"] == "The form needs your attention: Resume/CV is required." and d["status"] == "failed", repr(d))
check("an already worded reason passes through", apply.reason_text("The form needs your attention: X") == "The form needs your attention: X")
check("1.9.10's wording reads as today's", apply.reason_text("Needs your answer: X") == "Please answer: X")
check("a field's option mismatch keeps the value",
      apply.reason_text('Country: no option matches "Israel"') == 'Country: None of the options match "Israel".',
      apply.reason_text('Country: no option matches "Israel"'))
check("guardrail skips read as words", apply.reason_text("blocked company") == "This company is on your Never apply to list.")
worded = handler._history_view([{"job_id": "eeeeeeeeeeeeeeee", "status": "failed",
                                 "reason": "The form was sent, but the site didn't confirm it. Look for a confirmation email."}])[0]
check("a reason the extension already worded is still unconfirmed", worded["status"] == "unconfirmed", repr(worded))
stuck = handler._history_view([{"job_id": "ffffffffffffffff", "status": "claimed", "reason": ""}])[0]
check("a claim an old extension never reported on shows as in progress, a status the API lists", stuck["status"] == "in_progress", repr(stuck))

print()
if failures:
    print("%d failed" % len(failures))
    sys.exit(1)
print("all passed")
