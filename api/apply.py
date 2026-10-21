"""Automatic applications: the profile the extension fills forms from,
the plan's credits, the applied history and the approval queue.

All of it lives in the alerts table under the user's own partition, in
rows the alert evaluator never sees (no `active` attribute):

    #apply_profile          the application profile and settings
    #plan                   the paid plan, written only by paddle.py
    #applied#<job id>       one row per job the extension claimed
    #queue#<job id>         a job the user approved for queue mode

Credits are counted from the applied rows rather than kept as a running
number, so a crash between claim and result can never leak or double a
credit: a claim with no result counts for CLAIM_HOLD_S, then frees itself.

Nothing here decides what a user's settings should be. Every field has a
neutral default and the user changes it in onboarding.
"""

import re
from datetime import datetime, timezone
from urllib.parse import urlsplit

from boto3.dynamodb.conditions import Key

PROFILE_ROW = "#apply_profile"
PLAN_ROW = "#plan"
APPLIED = "#applied#"
QUEUE = "#queue#"

# Plan limits, as on the pricing page: (period, applications).
LIMITS = {"free": ("month", 30), "basic": ("month", 100), "pro": ("day", 50)}
# A claim that never got a result stops holding its credit after this.
CLAIM_HOLD_S = 1800
# Application sites the extension can fill, one per extension/ats/*.js.
FILLABLE_ATS = frozenset({"greenhouse", "ashby", "workable"})

MODES = ("queue", "auto")
SOURCES = ("board", "matches", "ats_pages", "mcp")
UNKNOWNS = ("skip", "ai")
EEO_FIELDS = ("gender", "race", "veteran", "disability")
MAX_ANSWERS = 200
MAX_TEXT = 500
MAX_LONG = 4000
JOB_ID = re.compile(r"^[0-9a-f]{8,32}$")
DOMAIN = re.compile(r"^[a-z0-9.-]{3,253}$")
COUNTRY = re.compile(r"^[A-Z]{2}$")


def empty_profile() -> dict:
    return {
        "contact": {"first_name": "", "last_name": "", "email": "", "phone": "", "location": ""},
        "links": {"linkedin": "", "github": "", "website": ""},
        "work": {"authorized_countries": [], "needs_sponsorship": None, "notice_period": "", "salary": ""},
        "eeo": {k: None for k in EEO_FIELDS},
        "answers": [],
        "settings": {"mode": "queue", "sources": ["board", "matches"], "unknowns": "skip",
                     "guardrails": {"min_match": None, "daily_limit": None, "blocked_companies": [],
                                    "one_per_company_days": None}},
    }


def _text(v, limit=MAX_TEXT) -> str:
    return str(v or "").strip()[:limit]


def _int(v, lo, hi):
    if v in (None, ""):
        return None
    try:
        n = int(v)
    except (TypeError, ValueError):
        raise ValueError("a number was expected") from None
    if not lo <= n <= hi:
        raise ValueError(f"{n} is outside {lo} to {hi}")
    return n


def normalise_question(q: str) -> str:
    """How two wordings of one question are recognised as the same."""
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", str(q or "").lower())).strip()


def clean_profile(body: dict) -> dict:
    """The profile as stored: every field bounded, every choice from a
    closed list. Unknown keys are dropped."""
    body = body if isinstance(body, dict) else {}
    out = empty_profile()
    for group, fields in (("contact", out["contact"]), ("links", out["links"])):
        src = body.get(group) or {}
        for k in fields:
            fields[k] = _text(src.get(k))
    work = body.get("work") or {}
    out["work"]["authorized_countries"] = sorted({c for c in (str(x).upper() for x in (work.get("authorized_countries") or [])[:50])
                                                  if COUNTRY.match(c)})
    sponsor = work.get("needs_sponsorship")
    out["work"]["needs_sponsorship"] = sponsor if isinstance(sponsor, bool) else None
    out["work"]["notice_period"] = _text(work.get("notice_period"), 100)
    out["work"]["salary"] = _text(work.get("salary"), 100)
    eeo = body.get("eeo") or {}
    out["eeo"] = {k: (_text(eeo.get(k), 100) or None) for k in EEO_FIELDS}
    answers, seen = [], set()
    for a in (body.get("answers") or [])[:MAX_ANSWERS]:
        q, ans = _text((a or {}).get("question"), MAX_TEXT), _text((a or {}).get("answer"), MAX_LONG)
        key = normalise_question(q)
        if key and ans and key not in seen:
            seen.add(key)
            answers.append({"question": q, "answer": ans})
    out["answers"] = answers
    s = body.get("settings") or {}
    st = out["settings"]
    if s.get("mode") in MODES:
        st["mode"] = s["mode"]
    if "sources" in s:
        st["sources"] = [x for x in SOURCES if x in (s.get("sources") or [])]
    if s.get("unknowns") in UNKNOWNS:
        st["unknowns"] = s["unknowns"]
    g = s.get("guardrails") or {}
    st["guardrails"] = {
        "min_match": _int(g.get("min_match"), 0, 100),
        "daily_limit": _int(g.get("daily_limit"), 1, 50),
        "blocked_companies": sorted({d for d in (str(x).strip().lower() for x in (g.get("blocked_companies") or [])[:200])
                                     if DOMAIN.match(d)}),
        "one_per_company_days": _int(g.get("one_per_company_days"), 1, 365),
    }
    return out


def get_profile(table, user_id: str) -> dict:
    item = table.get_item(Key={"user_id": user_id, "alert_id": PROFILE_ROW}).get("Item") or {}
    return clean_profile(item.get("profile") or {})


def put_profile(table, user_id: str, body: dict, now: datetime | None = None) -> dict:
    cleaned = clean_profile(body)
    table.put_item(Item={"user_id": user_id, "alert_id": PROFILE_ROW, "profile": cleaned,
                         "updated_at": (now or datetime.now(timezone.utc)).isoformat()})
    return cleaned


def add_answer(table, user_id: str, question, answer) -> None:
    """One saved answer, from the extension. Replaces an answer to the
    same question rather than adding a second."""
    profile = get_profile(table, user_id)
    key = normalise_question(question)
    if not key or not _text(answer):
        raise ValueError("question and answer are required")
    profile["answers"] = [a for a in profile["answers"] if normalise_question(a["question"]) != key]
    profile["answers"].insert(0, {"question": _text(question), "answer": _text(answer, MAX_LONG)})
    put_profile(table, user_id, profile)


def plan_of(table, user_id: str) -> str:
    """The plan in force: a paid plan only while Paddle says it is
    active or trialing (paddle.py keeps the row)."""
    item = table.get_item(Key={"user_id": user_id, "alert_id": PLAN_ROW}).get("Item") or {}
    if item.get("plan") in LIMITS and item.get("status") in ("active", "trialing", "past_due"):
        return item["plan"]
    return "free"


def _applied(table, user_id: str) -> list[dict]:
    resp = table.query(KeyConditionExpression=Key("user_id").eq(user_id) & Key("alert_id").begins_with(APPLIED))
    return resp.get("Items", [])


# One job, whichever address it was reached by: the board's listing URL and
# a company careers page that embeds the same form both name the ATS's own
# job id. Anything else falls back to host and path.
_CANONICAL = [
    (re.compile(r"greenhouse\.io/.*?(?:[?&](?:token|gh_jid)=|/jobs/)(\d+)", re.I), "greenhouse"),
    (re.compile(r"[?&]gh_jid=(\d+)", re.I), "greenhouse"),
    (re.compile(r"jobs\.ashbyhq\.com/[^/?#]+/([0-9a-f-]{36})", re.I), "ashby"),
    (re.compile(r"workable\.com/(?:[^/?#]+/)?j(?:obs)?/([A-Z0-9]{6,})", re.I), "workable"),
    (re.compile(r"jobs\.lever\.co/[^/?#]+/([0-9a-f-]{36})", re.I), "lever"),
]


def canonical_job(url: str | None) -> str:
    u = (url or "").strip()
    for rx, ats in _CANONICAL:
        m = rx.search(u)
        if m:
            return f"{ats}:{m.group(1).lower()}"
    p = urlsplit(u)
    host = p.netloc.lower().removeprefix("www.")
    return f"{host}{p.path.rstrip('/').lower()}" if host else ""


def submitted_already(table, user_id: str, job_id: str, url: str | None = None) -> bool:
    """Whether this job, by id or by canonical identity, was submitted. The
    server-side guard every path (extension, board, MCP) goes through."""
    canon = canonical_job(url)
    return any(r.get("status") == "submitted"
               and (r.get("job_id") == job_id or (canon and (r.get("canon") or canonical_job(r.get("url"))) == canon))
               for r in _applied(table, user_id))


def _counts(row: dict, now: datetime) -> bool:
    """Whether a row uses a credit: submitted, or claimed recently enough
    that its result may still come."""
    if row.get("status") == "submitted":
        return True
    if row.get("status") == "claimed":
        return (now - datetime.fromisoformat(row["at"])).total_seconds() < CLAIM_HOLD_S
    return False


def usage(table, user_id: str, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    plan = plan_of(table, user_id)
    period, limit = LIMITS[plan]
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    if period == "month":
        start = start.replace(day=1)
    used = sum(1 for r in _applied(table, user_id)
               if _counts(r, now) and datetime.fromisoformat(r["at"]) >= start)
    return {"plan": plan, "period": period, "limit": limit, "used": used, "remaining": max(0, limit - used)}


class LimitReached(Exception):
    pass


class AlreadyApplied(Exception):
    pass


def claim(table, user_id: str, body: dict, now: datetime | None = None) -> dict:
    """Reserve one credit for one job before the extension submits it."""
    now = now or datetime.now(timezone.utc)
    job_id = str((body or {}).get("job_id") or "")
    if not JOB_ID.match(job_id):
        raise ValueError("job_id is not a job id")
    existing = table.get_item(Key={"user_id": user_id, "alert_id": APPLIED + job_id}).get("Item")
    if existing and _counts(existing, now):
        raise AlreadyApplied("already applied to this job")
    # The same job under another id: the board's listing and a careers page
    # hashed by its address (extension/background.js pageJobId).
    canon = canonical_job(body.get("url"))
    if canon and any(_counts(r, now) and (r.get("canon") or canonical_job(r.get("url"))) == canon
                     for r in _applied(table, user_id) if r.get("job_id") != job_id):
        raise AlreadyApplied("already applied to this job")
    u = usage(table, user_id, now)
    if u["remaining"] <= 0:
        when = "this month" if u["period"] == "month" else "today"
        raise LimitReached(f"You've used all {u['limit']} applications on the {u['plan'].capitalize()} plan {when}.")
    table.put_item(Item={"user_id": user_id, "alert_id": APPLIED + job_id, "job_id": job_id,
                         "company": _text(body.get("company"), 200), "title": _text(body.get("title"), 300),
                         "url": _text(body.get("url"), 1000), "canon": canon, "status": "claimed", "reason": "",
                         "at": now.isoformat()})
    return {"remaining": u["remaining"] - 1}


def result(table, user_id: str, body: dict, now: datetime | None = None) -> None:
    """The outcome of a job. Skipped and failed give the credit back.

    A submitted application is final: no later report changes it, so a
    re-queued job that screens as already applied cannot erase the
    submission, refund it, or make the job eligible again. A skip for a
    job that was never claimed is kept as a record that costs nothing, so
    an automatic run sees the job as tried instead of picking it (and
    running the AI on it) every 15 minutes."""
    now = now or datetime.now(timezone.utc)
    job_id = str((body or {}).get("job_id") or "")
    status = (body or {}).get("status")
    if not JOB_ID.match(job_id) or status not in ("submitted", "skipped", "failed"):
        raise ValueError("job_id and a status of submitted, skipped or failed are required")
    key = {"user_id": user_id, "alert_id": APPLIED + job_id}
    reason = _text(body.get("reason"), 300)
    row = table.get_item(Key=key).get("Item")
    if not row:
        if status != "skipped":
            raise ValueError("claim the job before reporting it")
        try:
            table.put_item(Item={**key, "job_id": job_id, "status": "skipped", "reason": reason,
                                 "at": now.isoformat(), "done_at": now.isoformat()},
                           ConditionExpression="attribute_not_exists(alert_id)")
        except table.meta.client.exceptions.ConditionalCheckFailedException:
            pass  # claimed meanwhile; that claim's own result decides
        return
    if row.get("status") == "submitted":
        return
    try:
        table.update_item(Key=key, UpdateExpression="SET #s = :s, reason = :r, done_at = :t",
                          ConditionExpression="#s <> :sub",
                          ExpressionAttributeNames={"#s": "status"},
                          ExpressionAttributeValues={":s": status, ":r": reason, ":t": now.isoformat(), ":sub": "submitted"})
    except table.meta.client.exceptions.ConditionalCheckFailedException:
        pass  # submitted between the read and this write: it stays submitted


# The extension's internal reason codes as the owner's copy words them
# (extension/lib/match.js reasonText); older history rows still hold codes.
_REASONS = {
    "no application form on this page.": "No application form found on this page.",
    "a captcha stands in front of the form. solve it, then try again.": "Complete the CAPTCHA, then try again.",
    "no confirmation after submitting": "The form was sent, but the site didn't confirm it. Look for a confirmation email.",
    "no confirmation": "The form was sent, but the site didn't confirm it. Look for a confirmation email.",
    "not submitted": "The tab was closed before the application was sent.",
    "tab closed": "The tab was closed before the site confirmed the application.",
    "captcha": "The site asked for a CAPTCHA.",
    "unsupported site": "Can't apply automatically on this site. Open the job to fill it in yourself.",
    "job closed": "This job is no longer accepting applications.",
    "job not found": "Couldn't find this job listing.",
    "application form not found": "Couldn't find the application form.",
    "not on the page": "This field isn't on the page.",
    "page did not load": "The application page didn't load.",
    "submit button not found": "Couldn't find the Submit button. Submit the form yourself.",
    "no options to pick from": "The list had no options to choose from.",
    "no dropdown on the page": "Couldn't find the dropdown for this question.",
    "no input to type into": "Couldn't find the field for this answer.",
    "no phone box on the page": "Couldn't find the phone number field.",
    "the phone country did not stick": "Couldn't set the phone country. Check it yourself.",
    "no file input": "Couldn't find the file upload field.",
    "needs a date": "Enter the required date yourself.",
    "sections like this one are not filled": "Fill in this section yourself.",
    "no cv saved in the extension": "Add your CV in extension settings, then try again.",
    "greenhouse asked for an email security code": "Greenhouse sent an email security code. Enter it on the page to continue.",
    "blocked company": "This company is on your Never apply to list.",
    "applied to this company recently": "You applied to this company recently.",
    "already applied": "You've already applied to this job.",
}
_PREFIXES = (("form errors: ", "The form needs your attention: "), ("needs answer: ", "Needs your answer: "),
             ("ashby will not take this application: ", "Ashby couldn't submit this application: "))
# The codes, and the words the extension sends in their place since it
# began reporting reasonText() instead of the code.
UNCONFIRMED = {"no confirmation after submitting", "no confirmation",
               "we couldn't confirm that the application was submitted. check the page.",
               _REASONS["no confirmation"].lower()}


def _wording(r: str) -> str | None:
    """One reason's own wording, or None when it has none."""
    low = r.lower()
    if low in _REASONS:
        return _REASONS[low]
    for prefix, lead in _PREFIXES:
        if low.startswith(prefix):
            return lead + r[len(prefix):]
    m = re.match(r'no option matches (".*")$', r, re.I)
    return f"None of the options match {m.group(1)}." if m else None


def reason_text(reason: str) -> str:
    """A stored reason in the words the extension now shows."""
    r = (reason or "").strip()
    own = _wording(r)
    if own:
        return own
    if r.lower().startswith("could not fill "):
        return "Couldn't fill in " + "; ".join(reason_text(part) for part in r[len("could not fill "):].split("; "))
    field, sep, rest = r.rpartition(": ")
    text = sep and ":" not in rest and _wording(rest)
    return f"{field}: {text}" if text else r


def history(table, user_id: str, limit: int = 50) -> list[dict]:
    rows = sorted(_applied(table, user_id), key=lambda r: r.get("at") or "", reverse=True)[:max(1, min(limit, 500))]
    return [{k: r.get(k) for k in ("job_id", "company", "title", "url", "status", "reason", "at")} for r in rows]


def queue(table, user_id: str) -> list[dict]:
    resp = table.query(KeyConditionExpression=Key("user_id").eq(user_id) & Key("alert_id").begins_with(QUEUE))
    rows = sorted(resp.get("Items", []), key=lambda r: r.get("added_at") or "")
    return [{"job_id": r["job_id"], "added_at": r.get("added_at")} for r in rows]


def enqueue(table, user_id: str, job_id: str, now: datetime | None = None) -> None:
    if not JOB_ID.match(job_id):
        raise ValueError("not a job id")
    table.put_item(Item={"user_id": user_id, "alert_id": QUEUE + job_id, "job_id": job_id,
                         "added_at": (now or datetime.now(timezone.utc)).isoformat()})


def dequeue(table, user_id: str, job_id: str) -> None:
    if not JOB_ID.match(job_id):
        raise ValueError("not a job id")
    table.delete_item(Key={"user_id": user_id, "alert_id": QUEUE + job_id})
