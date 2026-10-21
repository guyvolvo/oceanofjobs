"""The custom AI agent's settings (api/AI_AGENT_DESIGN.md, step 1): how
answers sound, facts the user states about themselves, fixed answers by
topic, things never to claim, and whether new AI answers wait for review.

One row per agent, #agent#<agent_id>; v1 has "default" only, so profiles
can point at agents later without moving anything. Saves are conditional
on the version the editor loaded, so a second tab gets a conflict instead
of overwriting. Basic and Pro only (ai_answers.CAPS).

Nothing here calls the model yet; ai_answers.draft starts reading this row
in step 2.
"""

import re
from datetime import datetime, timezone

import apply
from ai_answers import CAPS

AGENT = "#agent#"
DEFAULT_ID = "default"
TONES = ("plain", "warm", "formal")
LENGTHS = ("short", "medium")
LANGUAGES = ("question", "en")
REVIEW = ("pause", "use")
ACTIONS = ("answer", "ai", "ask")
# v1's topics: the most common unanswered questions. why_company and why_role
# are job-specific (apply.job_specific), so they can't have one fixed answer.
TOPICS = ("referral_source", "start_date", "relocation", "onsite_days", "why_company", "why_role")
JOB_TOPICS = ("why_company", "why_role")
MAX_NOTES, MAX_FACTS, MAX_FACT, MAX_NEVER, MAX_NEVER_LEN, MAX_VALUE = 500, 20, 300, 30, 100, 300
# Facts the profile already holds. One place per fact, so the prompt never
# carries two answers to one question.
PROFILE_FACT = re.compile(r"\b(salary|notice period|sponsorship|work visa|work permit|authori[sz]ed to work|right to work|"
                          r"citizenship|i live in|i (am|m) (based|located) in)\b")


class Conflict(Exception):
    """Saved meanwhile from somewhere else: reload and try again."""


class NotIncluded(Exception):
    pass


def defaults() -> dict:
    return {"version": 0, "updated_at": None,
            "style": {"tone": "plain", "length": "short", "language": "question", "notes": ""},
            "facts": [], "topics": {t: {"action": "ai", "value": ""} for t in TOPICS},
            "never_claim": [], "review": "pause"}


def _choice(value, allowed, field):
    if value not in allowed:
        raise ValueError(f"{field} must be one of: {', '.join(allowed)}")
    return value


def _text(value, limit, field):
    text = str(value or "").strip()
    if len(text) > limit:
        raise ValueError(f"{field} can be at most {limit} characters")
    return text


def clean(body: dict) -> dict:
    """The agent as stored. Every field bounded, every choice from a closed
    list; a bad field is refused with its name, not silently dropped."""
    body = body if isinstance(body, dict) else {}
    out = defaults()
    style = body.get("style") or {}
    out["style"] = {"tone": _choice(style.get("tone", "plain"), TONES, "style.tone"),
                    "length": _choice(style.get("length", "short"), LENGTHS, "style.length"),
                    "language": _choice(style.get("language", "question"), LANGUAGES, "style.language"),
                    "notes": _text(style.get("notes"), MAX_NOTES, "style.notes")}
    facts = body.get("facts") or []
    if len(facts) > MAX_FACTS:
        raise ValueError(f"facts can have at most {MAX_FACTS} entries")
    out["facts"] = []
    for i, f in enumerate(facts):
        text = _text((f or {}).get("text"), MAX_FACT, f"facts[{i}]")
        if not text:
            continue
        if PROFILE_FACT.search(apply.normalise_question(text)):
            raise ValueError(f"facts[{i}]: salary, notice period, work authorization, sponsorship and location "
                             "belong in your profile, so the agent has one answer for each")
        out["facts"].append({"id": str((f or {}).get("id") or i)[:40], "text": text})
    topics = body.get("topics") or {}
    for name, rule in topics.items():
        if name not in TOPICS:
            raise ValueError(f"topics: unknown topic {name}")
        action = _choice((rule or {}).get("action", "ai"), ACTIONS, f"topics.{name}.action")
        if action == "answer" and name in JOB_TOPICS:
            raise ValueError(f"topics.{name}: this question is about one company or role, so it can't have one fixed answer")
        value = _text((rule or {}).get("value"), MAX_VALUE, f"topics.{name}.value")
        if action == "answer" and not value:
            raise ValueError(f"topics.{name}.value is required to answer it")
        out["topics"][name] = {"action": action, "value": value if action == "answer" else ""}
    never = body.get("never_claim") or []
    if len(never) > MAX_NEVER:
        raise ValueError(f"never_claim can have at most {MAX_NEVER} entries")
    out["never_claim"] = [t for t in (_text(n, MAX_NEVER_LEN, f"never_claim[{i}]") for i, n in enumerate(never)) if t]
    out["review"] = _choice(body.get("review", "pause"), REVIEW, "review")
    return out


def get(table, user_id: str, agent_id: str = DEFAULT_ID) -> dict:
    """The agent, or the defaults at version 0 if never saved, and whether
    this plan can change it."""
    row = table.get_item(Key={"user_id": user_id, "alert_id": AGENT + agent_id}, ConsistentRead=True).get("Item")
    agent = {k: row[k] for k in defaults()} if row else defaults()
    agent["version"] = int(agent["version"])
    return {**agent, "editable": apply.plan_of(table, user_id) in CAPS}


def put(table, user_id: str, body: dict, now: datetime | None = None, agent_id: str = DEFAULT_ID) -> dict:
    """Saves the agent if it's still at body["version"]; Conflict if it was
    saved meanwhile. The version goes up by one."""
    now = now or datetime.now(timezone.utc)
    if apply.plan_of(table, user_id) not in CAPS:
        raise NotIncluded("Your own AI agent is part of Basic and Pro")
    try:
        expected = int((body or {}).get("version"))
    except (TypeError, ValueError):
        raise ValueError("version is required: the one the agent was loaded at") from None
    item = {**clean(body), "version": expected + 1, "updated_at": now.isoformat(), "user_id": user_id, "alert_id": AGENT + agent_id}
    cond = ({"ConditionExpression": "attribute_not_exists(alert_id)"} if expected == 0 else
            {"ConditionExpression": "version = :v", "ExpressionAttributeValues": {":v": expected}})
    try:
        table.put_item(Item=item, **cond)
    except Exception as e:  # noqa: BLE001
        if getattr(e, "response", {}).get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            raise Conflict("The agent was changed somewhere else. Reload to see the latest version.") from None
        raise
    return get(table, user_id, agent_id)
