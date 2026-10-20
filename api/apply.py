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
FILLABLE_ATS = frozenset({"greenhouse", "workable"})

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
    u = usage(table, user_id, now)
    if u["remaining"] <= 0:
        raise LimitReached(f"your {u['plan']} plan's {u['limit']} applications a {u['period']} are used")
    table.put_item(Item={"user_id": user_id, "alert_id": APPLIED + job_id, "job_id": job_id,
                         "company": _text(body.get("company"), 200), "title": _text(body.get("title"), 300),
                         "url": _text(body.get("url"), 1000), "status": "claimed", "reason": "",
                         "at": now.isoformat()})
    return {"remaining": u["remaining"] - 1}


def result(table, user_id: str, body: dict, now: datetime | None = None) -> None:
    """The outcome of a claimed job. Skipped and failed give the credit back."""
    job_id = str((body or {}).get("job_id") or "")
    status = (body or {}).get("status")
    if not JOB_ID.match(job_id) or status not in ("submitted", "skipped", "failed"):
        raise ValueError("job_id and a status of submitted, skipped or failed are required")
    key = {"user_id": user_id, "alert_id": APPLIED + job_id}
    if not table.get_item(Key=key).get("Item"):
        raise ValueError("claim the job before reporting it")
    table.update_item(Key=key, UpdateExpression="SET #s = :s, reason = :r, done_at = :t",
                      ExpressionAttributeNames={"#s": "status"},
                      ExpressionAttributeValues={":s": status, ":r": _text(body.get("reason"), 300),
                                                 ":t": (now or datetime.now(timezone.utc)).isoformat()})


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
