"""Automatic applications: the profile the extension fills forms from,
the plan's credits, the applied history and the approval queue.

All of it lives in the alerts table under the user's own partition, in
rows the alert evaluator never sees (no `active` attribute):

    #apply_profile          the application profile and settings
    #plan                   the paid plan, written only by dodo.py
    #grant                  a plan the owner gave by hand in the CRM (crm/)
    #applied#<job id>       one row per job the extension claimed
    #queue#<job id>         a job the user approved for queue mode

Credits are kept by attempts.py. The applied rows are the old claim and
result path, still used by extensions before 1.9 and for skip records:
their credits are counted from the rows rather than kept as a running
number, so a crash between claim and result can never leak or double a
credit (a claim with no result counts for CLAIM_HOLD_S, then frees itself).

Nothing here decides what a user's settings should be. Every field has a
neutral default and the user changes it in onboarding.
"""

import re
from datetime import datetime, timezone
from urllib.parse import urlsplit

from boto3.dynamodb.conditions import Key

PROFILE_ROW = "#apply_profile"
PLAN_ROW = "#plan"
GRANT_ROW = "#grant"
APPLIED = "#applied#"
QUEUE = "#queue#"

# Plan limits, as on the pricing page: (period, applications). The only
# table: attempts.PLAN_LIMITS is built from it. Filling a form without
# sending it takes nothing on any plan (attempts.Attempts.filled).
LIMITS = {"free": ("month", 10), "basic": ("month", 100), "pro": ("day", 50)}
# A claim that never got a result stops holding its credit after this.
CLAIM_HOLD_S = 1800
# Application sites an automatic run can apply on: the three with their own
# extension/ats/*.js, and those in GENERAL_ATS in extension/background.js.
# Keep frontend/app.js FILLABLE_ATS the same.
FILLABLE_ATS = frozenset({"greenhouse", "ashby", "workable", "workday", "smartrecruiters", "bamboohr", "jazzhr", "recruitee", "lever", "teamtailor", "pinpoint", "breezy", "personio", "comeet"})

MODES = ("queue", "auto")
# What Fill application does: fill only, or fill and submit (Basic and Pro;
# attempts.snapshot then uses new AI answers without approval).
FILLS = ("half", "full")
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
        "settings": {"mode": "queue", "fill": "half", "sources": ["board", "matches"], "unknowns": "ai", "consent": True,
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


# Questions about one employer or one role. Their answers name that company
# or job, so an answer saved for one application must never fill another:
# it is kept with its job_id and used for that job only (extension 1.9.3,
# lib/match.js findAnswer). Matched on the normalised question.
JOB_SPECIFIC = re.compile(
    r"\bwhy (do|would) you (want|like|wish)|\bwhy are you (interested|applying|excited|drawn)|\bwhy (this|our|us|join|work)\b"
    r"|\binterests? you (about|in)\b|\bwhat (excites|attracts|draws|motivates|appeals to) you\b|\bcover (letter|note)\b"
    r"|\b(good|great|strong|right) fit for (this|the|our)\b")


def job_specific(question) -> bool:
    return bool(JOB_SPECIFIC.search(normalise_question(question)))


# Who wrote a saved answer and whether the user approved that exact text
# (api/AI_AGENT_DESIGN.md). Set by the server only: add_answer and approve
# set it, and put_profile works it out from what changed.
AUTHORS, APPROVALS = ("user", "ai"), ("pending", "approved", "rejected")
USER_ANSWER = {"source": "user", "approval": "approved"}


def _provenance(a: dict) -> dict:
    source = a.get("source") if a.get("source") in AUTHORS else "user"
    approval = a.get("approval") if a.get("approval") in APPROVALS else ("approved" if source == "user" else "pending")
    out = {"source": source, "approval": approval}
    if source == "ai" and str(a.get("agent_version", "")).isdigit():
        out["agent_version"] = int(a["agent_version"])
    # A company-motivation draft: never sent without the user's approval.
    if source == "ai" and a.get("always_review"):
        out["always_review"] = True
    return out


def answer_key(a: dict) -> tuple:
    return normalise_question(a.get("question")), a.get("job_id", "")


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
        # A job-specific answer keeps the job it was written for.
        job = str((a or {}).get("job_id") or "")
        job = job if JOB_ID.match(job) and job_specific(q) else ""
        key = (normalise_question(q), job)
        if key[0] and ans and key not in seen:
            seen.add(key)
            answers.append({"question": q, "answer": ans, **({"job_id": job} if job else {}), **_provenance(a)})
    out["answers"] = answers
    s = body.get("settings") or {}
    st = out["settings"]
    if s.get("mode") in MODES:
        st["mode"] = s["mode"]
    if s.get("fill") in FILLS:
        st["fill"] = s["fill"]
    if "sources" in s:
        st["sources"] = [x for x in SOURCES if x in (s.get("sources") or [])]
    if s.get("unknowns") in UNKNOWNS:
        st["unknowns"] = s["unknowns"]
    # Extension 1.9.10 ticks required privacy boxes in runs only with this
    # on; later versions answer every required box, so it is always on.
    st["consent"] = True
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


def _save(table, user_id: str, cleaned: dict, now: datetime | None = None) -> dict:
    table.put_item(Item={"user_id": user_id, "alert_id": PROFILE_ROW, "profile": cleaned,
                         "updated_at": (now or datetime.now(timezone.utc)).isoformat()})
    return cleaned


def put_profile(table, user_id: str, body: dict, now: datetime | None = None) -> dict:
    """The profile as the user saved it. An answer whose text is unchanged
    keeps who wrote it and its approval; a changed or new one is the user's
    own, approved. What the client says about either is ignored."""
    stored = {answer_key(a): a for a in get_profile(table, user_id)["answers"]}
    cleaned = clean_profile(body)
    for a in cleaned["answers"]:
        old = stored.get(answer_key(a))
        for k in ("source", "approval", "agent_version"):
            a.pop(k, None)
        a.update(_provenance(old) if old and old["answer"] == a["answer"] else USER_ANSWER)
    return _save(table, user_id, cleaned, now)


def add_answer(table, user_id: str, question, answer, job_id=None, source="user", agent_version=None, always_review=False) -> None:
    """One saved answer, from the extension or /apply. Replaces an answer to
    the same question rather than adding a second. A job-specific question
    keeps the job it was answered for; without one it isn't saved at all,
    since it could only ever be reused for the wrong company."""
    profile = get_profile(table, user_id)
    key = normalise_question(question)
    if not key or not _text(answer):
        raise ValueError("question and answer are required")
    job = ""
    if job_specific(question):
        job = str(job_id or "")
        if not JOB_ID.match(job):
            return
    profile["answers"] = [a for a in profile["answers"] if answer_key(a) != (key, job)]
    # The user's own answer is approved; an AI one waits for review.
    origin = USER_ANSWER if source == "user" else {"source": "ai", "approval": "pending",
                                                   **({"agent_version": agent_version} if agent_version is not None else {}),
                                                   **({"always_review": True} if always_review else {})}
    profile["answers"].insert(0, {"question": _text(question), "answer": _text(answer, MAX_LONG), **({"job_id": job} if job else {}), **origin})
    _save(table, user_id, clean_profile(profile))


def approve(table, user_id: str, question, job_id, answer, decision: str) -> dict:
    """The user's verdict on a saved answer. Approval is for that exact text:
    approving an edited answer makes it the user's own."""
    if decision not in ("approved", "rejected"):
        raise ValueError("decision must be approved or rejected")
    profile = get_profile(table, user_id)
    key = (normalise_question(question), str(job_id or ""))
    hit = next((a for a in profile["answers"] if answer_key(a) == key), None)
    if not hit:
        raise LookupError("no saved answer to that question")
    text = _text(answer, MAX_LONG) or hit["answer"]
    if decision == "approved" and text != hit["answer"]:
        hit.update(answer=text, **USER_ANSWER)
        hit.pop("agent_version", None)
    else:
        hit["approval"] = decision
    _save(table, user_id, clean_profile(profile))
    return hit


def reusable_answers(answers: list[dict]) -> list[dict]:
    """Saved answers an application may use: a job-specific one only with
    the job it belongs to. Answers saved before 1.9.3 have no job, so a
    job-specific one among them is dropped rather than reused."""
    return [a for a in answers if (not job_specific(a["question"]) or a.get("job_id")) and a.get("approval") != "rejected"]


def plan_of(table, user_id: str, now: datetime | None = None) -> str:
    """The plan in force, the higher of: a paid plan while Dodo says it
    is active or in its grace period (dodo.py keeps the row), and a plan given in
    the CRM, through its end date (YYYY-MM-DD, UTC; none means no end)."""
    item = table.get_item(Key={"user_id": user_id, "alert_id": PLAN_ROW}).get("Item") or {}
    paid = item["plan"] if item.get("plan") in LIMITS and item.get("status") in ("active", "trialing", "past_due") else "free"
    grant = table.get_item(Key={"user_id": user_id, "alert_id": GRANT_ROW}).get("Item") or {}
    today = (now or datetime.now(timezone.utc)).strftime("%Y-%m-%d")
    given = grant["plan"] if grant.get("plan") in LIMITS and (not grant.get("until") or grant["until"] >= today) else "free"
    return max(paid, given, key=list(LIMITS).index)


def query_all(table, user_id: str, prefix: str = "", **kw) -> list[dict]:
    """Every row in the user's partition (under prefix). DynamoDB answers a
    query 1 MB at a time, and attempts with their AI answers pass that."""
    cond = Key("user_id").eq(user_id)
    if prefix:
        cond = cond & Key("alert_id").begins_with(prefix)
    items = []
    while True:
        page = table.query(KeyConditionExpression=cond, **kw)
        items += page.get("Items", [])
        if "LastEvaluatedKey" not in page:
            return items
        kw["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def _applied(table, user_id: str) -> list[dict]:
    return query_all(table, user_id, APPLIED)


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
    # Credits the new attempts path holds (api/attempts.py ledgers, keyed by
    # the user's time zone; UTC here is close enough for an old client).
    ledger = table.get_item(Key={"user_id": user_id, "alert_id": ("#ledger#month#" + now.strftime("%Y-%m")) if period == "month"
                                 else ("#ledger#day#" + now.strftime("%Y-%m-%d"))}).get("Item") or {}
    used += int(ledger.get("held", 0))
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
    "no confirmation after submitting": "The form was sent, but the site didn't confirm it. Check for a confirmation email.",
    "no confirmation": "The form was sent, but the site didn't confirm it. Check for a confirmation email.",
    "not submitted": "The tab closed before the application was submitted.",
    "tab closed": "The tab closed before the site confirmed the application.",
    "captcha": "This site asked you to complete a CAPTCHA.",
    "unsupported site": "This site doesn't support automatic applications. Open the job to fill in the form yourself.",
    "job closed": "This job is no longer accepting applications.",
    "job not found": "Couldn't find this job listing.",
    "application form not found": "Couldn't find the application form.",
    "not on the page": "This field isn't on the page.",
    "page did not load": "The application page didn't load.",
    "submit button not found": "Couldn't find the Submit button. Submit the form yourself.",
    "no options to pick from": "There are no options in this list.",
    "no dropdown on the page": "Couldn't find the dropdown for this question.",
    "no input to type into": "Couldn't find the field for this answer.",
    "no phone box on the page": "Couldn't find the phone number field.",
    "the phone country did not stick": "Couldn't set the phone country. Check it yourself.",
    "no file input": "Couldn't find the file upload field.",
    "needs a date": "Enter the required date yourself.",
    "sections like this one are not filled": "Fill in this section yourself.",
    "no cv saved in the extension": "Add your resume in Settings, then try again.",
    "greenhouse asked for an email security code": "Greenhouse sent you a security code by email. Enter it on the page to continue.",
    "blocked company": "This company is on your Never apply to list.",
    "applied to this company recently": "You applied to this company recently.",
    "already applied": "You've already applied to this job.",
}
# Extension 1.9.10 and older wrote "Needs your answer: ".
_PREFIXES = (("form errors: ", "The form needs your attention: "), ("needs answer: ", "Please answer: "), ("needs your answer: ", "Please answer: "),
             ("ashby will not take this application: ", "Ashby couldn't submit this application: "))
# The codes, and the words the extension sends in their place since it
# began reporting reasonText() instead of the code.
UNCONFIRMED = {"no confirmation after submitting", "no confirmation",
               "we couldn't confirm that the application was submitted. check the page.",
               "the form was sent, but the site didn't confirm it. look for a confirmation email.",
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
    """The queue in the user's order: jobs placed with set_order first, by
    position, then the rest as they were added."""
    rows = sorted(query_all(table, user_id, QUEUE), key=lambda r: (r.get("position") is None, int(r.get("position") or 0), r.get("added_at") or ""))
    return [{"job_id": r["job_id"], "added_at": r.get("added_at"), "position": i} for i, r in enumerate(rows)]


def set_order(table, user_id: str, job_ids: list) -> None:
    """Positions for queued jobs, in the given order. Ids not in the queue
    are ignored, so a job removed meanwhile isn't brought back."""
    for i, job_id in enumerate(job_ids or []):
        job_id = str(job_id or "")
        if not JOB_ID.match(job_id):
            raise ValueError("not a job id")
        try:
            table.update_item(Key={"user_id": user_id, "alert_id": QUEUE + job_id}, UpdateExpression="SET #p = :p",
                              ConditionExpression="attribute_exists(alert_id)", ExpressionAttributeNames={"#p": "position"},
                              ExpressionAttributeValues={":p": i})
        except table.meta.client.exceptions.ConditionalCheckFailedException:
            pass


def enqueue(table, user_id: str, job_id: str, now: datetime | None = None) -> None:
    if not JOB_ID.match(job_id):
        raise ValueError("not a job id")
    table.put_item(Item={"user_id": user_id, "alert_id": QUEUE + job_id, "job_id": job_id,
                         "added_at": (now or datetime.now(timezone.utc)).isoformat()})


def dequeue(table, user_id: str, job_id: str) -> None:
    if not JOB_ID.match(job_id):
        raise ValueError("not a job id")
    table.delete_item(Key={"user_id": user_id, "alert_id": QUEUE + job_id})
