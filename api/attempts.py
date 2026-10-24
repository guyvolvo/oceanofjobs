"""Application attempts: reservation, submission start, settlement, expiry
and disputes, as api/AUTO_APPLY_CONTRACT.md defines them.

Extension 1.9 and later reserve, gate and settle through these, and call
apply.result only to record a skip. 1.8 and earlier (1.7.0 is still the
store's public version on 2026-10-22) use apply.claim and apply.result, so
every reserve and summary counts those rows too.

Rows, all in the alerts table under the user's id:
- #attempt#<id>: one attempt. Its job, the period and time zone fixed at
  reservation, its state, when it expires, and an audit trail.
- #joblock#<canonical job>: present while an attempt for the job is open,
  or once it is Submitted or Submission unconfirmed (R2).
- #ledger#month#<YYYY-MM> and #ledger#day#<YYYY-MM-DD>: "held" (reserved
  plus charged) and "charged" for that period, and "disputes" on months.
  DynamoDB conditions can't add two numbers, so "held < limit" is the
  single condition that keeps concurrent attempts inside the allowance.

Every state change is one transaction over the attempt, its ledgers and
its job lock, conditioned on the attempt's current state, so a repeated or
racing request can't charge, release or refund twice.
"""

import hashlib
import re
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

import apply

ATTEMPT = "#attempt#"
JOBLOCK = "#joblock#"
LEDGER_MONTH = "#ledger#month#"
LEDGER_DAY = "#ledger#day#"
HOLD = timedelta(minutes=30)
DISPUTE_WINDOW = timedelta(days=14)
DISPUTES_PER_PERIOD = 5
ATTEMPT_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")

# (limit per month, limit per day) by plan, from apply.LIMITS. R14.
PLAN_LIMITS = {plan: (n, None) if period == "month" else (None, n) for plan, (period, n) in apply.LIMITS.items()}

RESERVED, STARTED = "reserved", "submission_started"
SUBMITTED, UNCONFIRMED = "submitted", "unconfirmed"
FAILED, SKIPPED, NEEDS_INPUT, ABANDONED, DISPUTED = "failed", "skipped", "needs_input", "abandoned", "not_sent_disputed"
FILLED = "filled"
OPEN = (RESERVED, STARTED)
CHARGED = (SUBMITTED, UNCONFIRMED)

# Allowed settlements: (from state, outcome) -> credit effect. R4 to R7.
# "release" returns the held credit; "charge" keeps it held and counts it
# charged; "none" changes no credit (an unconfirmed one later confirmed).
SETTLE = {
    (RESERVED, FAILED): "release", (RESERVED, SKIPPED): "release", (RESERVED, NEEDS_INPUT): "release",
    (RESERVED, ABANDONED): "release",
    (STARTED, SUBMITTED): "charge", (STARTED, UNCONFIRMED): "charge", (STARTED, FAILED): "release",
    (UNCONFIRMED, SUBMITTED): "none",
}


class Conflict(Exception):
    """The same attempt id with a different request, or a transition the
    contract doesn't allow."""


class NotFound(Exception):
    """No attempt with this id for this user. Another user's attempt reads
    the same: rows live under the caller's own user id."""


class NotEligible(Conflict):
    """Submission start for an attempt that is already settled or past
    submission start: don't submit."""


class LimitReached(Exception):
    pass


class JobTaken(Exception):
    """Another attempt for this job is open, or it was already submitted."""


class Expired(Exception):
    """The reservation ran out before submission start: don't submit."""


class NeedsReview(Exception):
    """An AI answer the user hasn't approved is in the form, and their agent
    says new AI answers wait for review: no submit."""

    def __init__(self, questions):
        super().__init__("new AI answers wait for your review before this application is sent")
        self.questions = questions


MAX_SNAPSHOT = 20


class NotDisputable(Exception):
    pass


def _utc(now: datetime | None) -> datetime:
    """Now in UTC: stored times are compared as ISO strings, which only
    works with one offset."""
    return (now or datetime.now(timezone.utc)).astimezone(timezone.utc)


def _zone(tz: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(tz or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def periods(now: datetime, tz: str | None) -> tuple[str, str]:
    """(YYYY-MM, YYYY-MM-DD) of now in the user's time zone. R13."""
    local = now.astimezone(_zone(tz))
    return local.strftime("%Y-%m"), local.strftime("%Y-%m-%d")


def billing_period(now: datetime, tz: str | None) -> str:
    """The period the dispute allowance counts in (R12). The calendar month
    in the user's time zone for now; the one place to change when it
    follows Paddle's billing periods instead."""
    return periods(now, tz)[0]


def log(event: str, user_id: str, attempt_id: str = "", detail: str = "") -> None:
    """One line for the box journal and Lambda logs. The user only as a
    short hash, and never reasons, answers, CVs or tokens."""
    who = hashlib.sha256(user_id.encode()).hexdigest()[:10]
    print(f"attempts {event} user={who} attempt={attempt_id} {detail}".rstrip(), flush=True)


def legacy_used(table, user_id: str, month: str, day: str, tz: str | None, now: datetime, applied=None) -> tuple[int, int]:
    """(this month, this day) of credits the old claim and result path
    holds (apply.py's #applied# rows), in the user's time zone, so the old
    and new paths share one allowance while both exist."""
    m = d = 0
    for r in apply._applied(table, user_id) if applied is None else applied:
        if not apply._counts(r, now):
            continue
        rm, rd = periods(datetime.fromisoformat(r["at"]), tz)
        m += rm == month
        d += rd == day
    return m, d


def limits(table, user_id: str, plan: str | None = None) -> tuple[int | None, int | None]:
    """(monthly, daily) limits in force: the plan's, with the user's own
    daily maximum on top on every plan. R14."""
    month, day = PLAN_LIMITS[plan or apply.plan_of(table, user_id)]
    own = (apply.get_profile(table, user_id)["settings"]["guardrails"] or {}).get("daily_limit")
    if own:
        day = min(day, int(own)) if day else int(own)
    return month, day


class Attempts:
    def __init__(self, table):
        self.table = table
        self.client = table.meta.client
        self.name = table.name

    def _get(self, user_id: str, alert_id: str) -> dict | None:
        return self.table.get_item(Key={"user_id": user_id, "alert_id": alert_id}, ConsistentRead=True).get("Item")

    def _key(self, user_id: str, alert_id: str) -> dict:
        return {"user_id": user_id, "alert_id": alert_id}

    def _transact(self, items: list[dict]) -> list[str] | None:
        """Runs the writes (plain Python values: the table's client
        converts them to DynamoDB types itself); on a failed condition returns each item's
        cancellation code ("None" for those that weren't the cause)."""
        try:
            self.client.transact_write_items(TransactItems=items)
            return None
        except ClientError as e:
            if e.response["Error"]["Code"] != "TransactionCanceledException":
                raise
            reasons = e.response.get("CancellationReasons") or []
            return [r.get("Code", "None") for r in reasons] or ["Unknown"]

    def _ledger_update(self, user_id: str, alert_id: str, held: int, charged: int, limit: int | None = None,
                       disputes: int = 0, dispute_cap: int | None = None) -> dict:
        sets, values, conds = [], {":z": 0}, []
        for name, n in (("held", held), ("charged", charged), ("disputes", disputes)):
            if n:
                sets.append(f"{name} = if_not_exists({name}, :z) + :{name}")
                values[f":{name}"] = n
        if limit is not None:
            conds.append("(attribute_not_exists(held) OR held < :limit)")
            values[":limit"] = limit
        if dispute_cap is not None:
            conds.append("(attribute_not_exists(disputes) OR disputes < :cap)")
            values[":cap"] = dispute_cap
        upd = {"TableName": self.name, "Key": self._key(user_id, alert_id), "UpdateExpression": "SET " + ", ".join(sets),
               "ExpressionAttributeValues": values}
        if conds:
            upd["ConditionExpression"] = " AND ".join(conds)
        return {"Update": upd}

    def _audit(self, event: str, now: datetime) -> dict:
        return {"at": now.isoformat(), "event": event}

    # R1, R2, R10, R13, R14
    def reserve(self, user_id: str, attempt_id: str, job: dict, now: datetime | None = None, tz: str | None = None) -> dict:
        now = _utc(now)
        if not ATTEMPT_ID.match(attempt_id or ""):
            raise ValueError("attempt_id is required")
        job_id = str(job.get("job_id") or "")
        if not apply.JOB_ID.match(job_id):
            raise ValueError("job_id is not a job id")
        existing = self._get(user_id, ATTEMPT + attempt_id)
        if existing:
            if existing["job_id"] != job_id:
                raise Conflict("this attempt id belongs to another job")
            return self.view(existing)
        self.expire(user_id, now)
        # Applications submitted through the old claim and result path have
        # no job lock; until it's retired they're checked here.
        if apply.submitted_already(self.table, user_id, job_id, job.get("url")):
            raise JobTaken("this job was already submitted")
        canon = apply.canonical_job(job.get("url")) or "id:" + job_id
        month, day = periods(now, tz)
        month_limit, day_limit = limits(self.table, user_id)
        old_m, old_d = legacy_used(self.table, user_id, month, day, tz, now)
        month_limit = None if month_limit is None else month_limit - old_m
        day_limit = None if day_limit is None else day_limit - old_d
        if (month_limit is not None and month_limit <= 0) or (day_limit is not None and day_limit <= 0):
            raise LimitReached("no applications left in this period")
        attempt = {"user_id": user_id, "alert_id": ATTEMPT + attempt_id, "attempt_id": attempt_id, "job_id": job_id,
                   "canon": canon, "title": apply._text(job.get("title"), 300), "company": apply._text(job.get("company"), 200),
                   "url": apply._text(job.get("url"), 1000), "tz": str(_zone(tz)), "month": month, "day": day,
                   "state": RESERVED, "reserved_at": now.isoformat(), "expires_at": (now + HOLD).isoformat(),
                   "audit": [self._audit("reserved", now)]}
        items = [
            {"Put": {"TableName": self.name, "Item": attempt, "ConditionExpression": "attribute_not_exists(alert_id)"}},
            {"Put": {"TableName": self.name, "Item": ({"user_id": user_id, "alert_id": JOBLOCK + canon, "attempt_id": attempt_id,
                                                            "job_id": job_id, "state": RESERVED, "at": now.isoformat()}),
                     "ConditionExpression": "attribute_not_exists(alert_id)"}},
            self._ledger_update(user_id, LEDGER_MONTH + month, 1, 0, month_limit),
            self._ledger_update(user_id, LEDGER_DAY + day, 1, 0, day_limit),
        ]
        reasons = self._transact(items)
        if reasons is None:
            return self.view(attempt)
        if reasons[0] == "ConditionalCheckFailed":
            again = self._get(user_id, ATTEMPT + attempt_id)  # the same id, racing itself
            if again and again["job_id"] == job_id:
                return self.view(again)
            raise Conflict("this attempt id belongs to another job")
        if reasons[1] == "ConditionalCheckFailed":
            raise JobTaken("this job already has an open or submitted application")
        if "ConditionalCheckFailed" in reasons[2:]:
            raise LimitReached("no applications left in this period")
        raise RuntimeError(f"reservation failed: {reasons}")

    # R3, R10
    def snapshot(self, user_id: str, answers: list, mode: str | None) -> list[dict]:
        """The AI answers in a form about to be submitted, as they are now,
        each with what allowed it: the user approved that text ("approved"),
        the user pressed Submit on the card themselves ("user_submit"), or
        their agent uses AI answers automatically ("automatic"). NeedsReview
        when none applies. Which answers are the AI's comes from the saved
        answers where they match; the client's word only for one that isn't
        saved (a suggestion on the card)."""
        import agent  # noqa: PLC0415 -- agent imports ai_answers, which imports apply; kept out of module load
        profile = apply.get_profile(self.table, user_id)
        saved = {apply.answer_key(a): a for a in profile["answers"]}
        review = agent.load(self.table, user_id)["review"]
        out, waiting = [], []
        for given in (answers or [])[:50]:
            if not isinstance(given, dict):
                continue
            question, text = apply._text(given.get("question"), apply.MAX_TEXT), apply._text(given.get("answer"), 800)
            job = str(given.get("job_id") or "") if apply.job_specific(question) else ""
            row = saved.get((apply.normalise_question(question), job))
            mine = row if row and row["answer"].strip() == text else None
            if not (mine and mine["source"] == "ai") and not (mine is None and given.get("source") == "ai"):
                continue
            approval = mine["approval"] if mine else "pending"
            # A company-motivation draft is never sent unreviewed (agent.MOTIVATION).
            always = bool(mine and mine.get("always_review"))
            allowed = ("approved" if approval == "approved" else "user_submit" if mode == "card"
                       else "automatic" if review == "use" and approval != "rejected" and not always else None)
            if allowed is None:
                waiting.append(question)
            out.append({"question": question, "answer": text, "source": "ai", "approval": approval, "allowed_by": allowed,
                        **({"agent_version": mine["agent_version"]} if mine and mine.get("agent_version") else {})})
        if waiting:
            raise NeedsReview(waiting)
        return out[:MAX_SNAPSHOT]

    def submission_started(self, user_id: str, attempt_id: str, now: datetime | None = None, answers: list | None = None,
                           mode: str | None = None) -> dict:
        """The gate. With `answers` (extension 1.9.5 on), the AI answers among
        them must be allowed (snapshot), and the copy is kept on the attempt
        as what was submitted."""
        now = _utc(now)
        a = self._get(user_id, ATTEMPT + attempt_id)
        if not a:
            raise NotFound("no such attempt")
        if a["state"] == STARTED:
            return self.view(a)
        snap = self.snapshot(user_id, answers, mode) if answers is not None else None
        if a["state"] != RESERVED:
            raise NotEligible(f"an attempt that is {a['state']} can't start a submission")
        if a["expires_at"] <= now.isoformat():
            self.expire(user_id, now)
            raise Expired("the reservation expired; don't submit")
        try:
            self.table.update_item(
                Key={"user_id": user_id, "alert_id": ATTEMPT + attempt_id},
                UpdateExpression="SET #s = :started, started_at = :t, audit = list_append(audit, :ev)"
                                 + (", ai_answers = :snap" if snap else ""),
                ConditionExpression="#s = :reserved AND expires_at > :t",
                ExpressionAttributeNames={"#s": "state"},
                ExpressionAttributeValues={":started": STARTED, ":reserved": RESERVED, ":t": now.isoformat(),
                                           ":ev": [self._audit("submission_started", now)], **({":snap": snap} if snap else {})})
        except ClientError as e:
            if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise
            again = self._get(user_id, ATTEMPT + attempt_id)
            if again["state"] == STARTED:
                return self.view(again)  # started by a racing report
            raise Expired("the reservation expired; don't submit")
        a["state"], a["started_at"] = STARTED, now.isoformat()
        if snap:
            a["ai_answers"] = snap
        return self.view(a)

    # R4 to R7, R10
    def settle(self, user_id: str, attempt_id: str, outcome: str, reason: str = "", now: datetime | None = None,
               questions: list | None = None) -> dict:
        return self._settle(user_id, attempt_id, outcome, reason, now, questions)[0]

    def _settle(self, user_id: str, attempt_id: str, outcome: str, reason: str, now: datetime | None,
                questions: list | None = None) -> tuple[dict, bool]:
        """(the attempt, whether this call changed it)."""
        now = _utc(now)
        a = self._get(user_id, ATTEMPT + attempt_id)
        if not a:
            raise NotFound("no such attempt")
        if a["state"] == outcome:
            return self.view(a), False  # the same report again
        effect = SETTLE.get((a["state"], outcome))
        if effect is None:
            raise Conflict(f"an attempt that is {a['state']} can't become {outcome}")
        key = {"user_id": user_id, "alert_id": ATTEMPT + attempt_id}
        upd = {"TableName": self.name, "Key": self._key(**key),
               "UpdateExpression": "SET #s = :to, reason = :r, settled_at = :t, questions = :q, audit = list_append(audit, :ev)",
               "ConditionExpression": "#s = :from", "ExpressionAttributeNames": {"#s": "state"},
               "ExpressionAttributeValues": ({":to": outcome, ":from": a["state"], ":r": apply._text(reason, 300),
                                                   ":q": [apply._text(q, 300) for q in (questions or [])[:20] if str(q or "").strip()],
                                                   ":t": now.isoformat(), ":ev": [self._audit(outcome, now)]})}
        items = [{"Update": upd}]
        lock = self._key(user_id, JOBLOCK + a["canon"])
        if effect == "release":
            items += [self._ledger_update(user_id, LEDGER_MONTH + a["month"], -1, 0),
                      self._ledger_update(user_id, LEDGER_DAY + a["day"], -1, 0),
                      {"Delete": {"TableName": self.name, "Key": lock, "ConditionExpression": "attempt_id = :a",
                                  "ExpressionAttributeValues": ({":a": attempt_id})}}]
        elif effect == "charge":
            items += [self._ledger_update(user_id, LEDGER_MONTH + a["month"], 0, 1),
                      self._ledger_update(user_id, LEDGER_DAY + a["day"], 0, 1)]
        if effect in ("charge", "none"):
            items.append({"Update": {"TableName": self.name, "Key": lock, "UpdateExpression": "SET #s = :to",
                                     "ConditionExpression": "attempt_id = :a", "ExpressionAttributeNames": {"#s": "state"},
                                     "ExpressionAttributeValues": ({":to": outcome, ":a": attempt_id})}})
        reasons = self._transact(items)
        if reasons is not None:
            again = self._get(user_id, ATTEMPT + attempt_id)
            if again["state"] == a["state"]:
                log("settle_failed", user_id, attempt_id, f"from={a['state']} to={outcome} reasons={reasons}")
                raise RuntimeError(f"settlement failed: {reasons}")
            return self._settle(user_id, attempt_id, outcome, reason, now, questions)  # moved by a racing report: decide again
        a.update(state=outcome, reason=reason, settled_at=now.isoformat())
        return self.view(a), True

    # R9
    def expire(self, user_id: str, now: datetime | None = None, rows: list | None = None) -> int:
        """Settles this user's open attempts past their expiry: Abandoned
        before submission start, Submission unconfirmed after."""
        now = _utc(now)
        n = 0
        for a in self._attempts(user_id) if rows is None else rows:
            if a["state"] in OPEN and a["expires_at"] <= now.isoformat():
                to = ABANDONED if a["state"] == RESERVED else UNCONFIRMED
                try:
                    n += self._settle(user_id, a["attempt_id"], to, "expired", now)[1]
                except Conflict:
                    pass  # settled by its own report meanwhile
                except Exception as e:  # noqa: BLE001
                    # Left open and still holding its credit, which can't
                    # overspend; the next read or sweep tries again.
                    log("expire_failed", user_id, a["attempt_id"], repr(e)[:200])
        return n

    def sweep(self, now: datetime | None = None) -> int:
        """Expiry for every user, for a periodic job, so it never depends
        on a client calling in. Safe to repeat and to overlap: every
        settlement is conditioned on the attempt's state, so a second run
        finds nothing left to do, and one user's failure doesn't stop the
        others.

        shortcut: a full table scan, fine while the alerts table is small
        (50 items, 57KB on 2026-10-21); past about 100k items, give open
        attempts a sparse index and query that instead."""
        now = _utc(now)
        users, kw = set(), {"FilterExpression": "begins_with(alert_id, :p) AND #s IN (:r, :st) AND expires_at <= :t",
                            "ExpressionAttributeNames": {"#s": "state"},
                            "ExpressionAttributeValues": {":p": ATTEMPT, ":r": RESERVED, ":st": STARTED, ":t": now.isoformat()},
                            "ProjectionExpression": "user_id"}
        while True:
            page = self.table.scan(**kw)
            users.update(i["user_id"] for i in page.get("Items", []))
            if "LastEvaluatedKey" not in page:
                break
            kw["ExclusiveStartKey"] = page["LastEvaluatedKey"]
        settled = 0
        for u in users:
            try:
                settled += self.expire(u, now)
            except Exception as e:  # noqa: BLE001
                log("sweep_user_failed", u, "", repr(e)[:200])
        return settled

    # R12
    def dispute(self, user_id: str, attempt_id: str, now: datetime | None = None, tz: str | None = None) -> dict:
        now = _utc(now)
        a = self._get(user_id, ATTEMPT + attempt_id)
        if not a:
            raise NotFound("no such attempt")
        if a["state"] == DISPUTED:
            return self.view(a)  # refunded once already; a repeat refunds nothing
        if a["state"] != UNCONFIRMED:
            raise NotDisputable("Only an unconfirmed application can be refunded.")
        if now - datetime.fromisoformat(a["settled_at"]) > DISPUTE_WINDOW:
            raise NotDisputable("The 14 days to refund this credit have passed.")
        billing = billing_period(now, tz or a.get("tz"))
        items = [
            {"Update": {"TableName": self.name, "Key": self._key(user_id, ATTEMPT + attempt_id),
                        "UpdateExpression": "SET #s = :to, refunded_at = :t, audit = list_append(audit, :ev)",
                        "ConditionExpression": "#s = :from", "ExpressionAttributeNames": {"#s": "state"},
                        "ExpressionAttributeValues": ({":to": DISPUTED, ":from": UNCONFIRMED, ":t": now.isoformat(),
                                                            ":ev": [self._audit("disputed_refunded", now)]})}},
            # The refund comes off the periods the charge was made in (R13).
            self._ledger_update(user_id, LEDGER_MONTH + a["month"], -1, -1),
            self._ledger_update(user_id, LEDGER_DAY + a["day"], -1, -1),
            {"Delete": {"TableName": self.name, "Key": self._key(user_id, JOBLOCK + a["canon"]),
                        "ConditionExpression": "attempt_id = :a", "ExpressionAttributeValues": ({":a": attempt_id})}},
        ]
        # The dispute allowance counts in the period the dispute is made.
        cap = self._ledger_update(user_id, LEDGER_MONTH + billing, 0, 0, disputes=1, dispute_cap=DISPUTES_PER_PERIOD)
        if billing == a["month"]:
            merged = self._ledger_update(user_id, LEDGER_MONTH + a["month"], -1, -1, disputes=1, dispute_cap=DISPUTES_PER_PERIOD)
            items[1] = merged
        else:
            items.append(cap)
        reasons = self._transact(items)
        if reasons is None:
            a.update(state=DISPUTED, refunded_at=now.isoformat())
            return self.view(a)
        if reasons[0] == "ConditionalCheckFailed":
            return self.dispute(user_id, attempt_id, now, tz)  # disputed meanwhile: answer as a repeat
        raise NotDisputable(f"You've used all {DISPUTES_PER_PERIOD} refunds this month.")

    # R8
    def filled(self, user_id: str, attempt_id: str, job: dict, now: datetime | None = None) -> dict:
        """A fill the user will check and send themselves: in History as
        Filled, with no reservation, no charge and no job lock."""
        now = _utc(now)
        if not ATTEMPT_ID.match(attempt_id or ""):
            raise ValueError("attempt_id is required")
        job_id = str(job.get("job_id") or "")
        if not apply.JOB_ID.match(job_id):
            raise ValueError("job_id is not a job id")
        row = {"user_id": user_id, "alert_id": ATTEMPT + attempt_id, "attempt_id": attempt_id, "job_id": job_id,
               "canon": apply.canonical_job(job.get("url")) or "id:" + job_id, "title": apply._text(job.get("title"), 300),
               "company": apply._text(job.get("company"), 200), "url": apply._text(job.get("url"), 1000),
               "state": FILLED, "reserved_at": now.isoformat(), "settled_at": now.isoformat(), "audit": [self._audit("filled", now)]}
        try:
            self.table.put_item(Item=row, ConditionExpression="attribute_not_exists(alert_id)")
        except ClientError as e:
            if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise
            existing = self._get(user_id, ATTEMPT + attempt_id)
            if existing["job_id"] != job_id or existing["state"] != FILLED:
                raise Conflict("this attempt id belongs to another attempt")
            return self.view(existing)
        return self.view(row)

    def needs(self, user_id: str, queued=frozenset(), rows: list | None = None) -> list[dict]:
        """Jobs waiting on the user: the latest attempt per job is Needs
        input and the job isn't back in the queue already."""
        latest, filled = {}, {}
        for a in self._attempts(user_id) if rows is None else rows:
            if a["state"] == FILLED:
                filled[a["job_id"]] = max(filled.get(a["job_id"], ""), a["reserved_at"])
                continue
            if a["job_id"] not in latest or a["reserved_at"] > latest[a["job_id"]]["reserved_at"]:
                latest[a["job_id"]] = a
        out = []
        for a in latest.values():
            if a["state"] != NEEDS_INPUT or a["job_id"] in queued:
                continue
            qs = list(a.get("questions") or [])
            if not qs and str(a.get("reason") or "").lower().startswith("needs your answer: "):
                qs = [q.strip() for q in a["reason"].split(":", 1)[1].split(";") if q.strip()]
            # Filled with every answer, held back by the site's human check:
            # the user opens it and presses Submit (extension/background.js).
            ready = not qs and str(a.get("reason") or "").lower().startswith("ready to submit")
            # The user has since filled it in with the extension, to send it themselves.
            if ready and filled.get(a["job_id"], "") > (a.get("settled_at") or ""):
                continue
            out.append({"attempt_id": a["attempt_id"], "job_id": a["job_id"], "title": a.get("title") or "",
                        "company": a.get("company") or "", "url": a.get("url") or "", "questions": qs, "at": a.get("settled_at"),
                        **({"ready": True} if ready else {})})
        return sorted(out, key=lambda n: n["at"] or "", reverse=True)

    def history(self, user_id: str, now: datetime | None = None) -> list[dict]:
        """Every attempt as a History row, in the shape apply.history uses."""
        now = _utc(now)
        shown = {RESERVED: "in_progress", STARTED: "in_progress"}
        rows = []
        for a in self._attempts(user_id):
            state = a["state"]
            settled = a.get("settled_at")
            rows.append({"job_id": a["job_id"], "attempt_id": a["attempt_id"], "company": a.get("company") or "",
                         "title": a.get("title") or "", "url": a.get("url") or "", "status": shown.get(state, state),
                         "reason": a.get("reason") or "", "at": settled or a["reserved_at"],
                         "disputable": state == UNCONFIRMED and bool(settled) and now - datetime.fromisoformat(settled) <= DISPUTE_WINDOW,
                         # The AI answers as they were sent, not as saved answers read now.
                         **({"ai_answers": [{k: (int(v) if isinstance(v, Decimal) else v) for k, v in x.items()} for x in a["ai_answers"]]}
                            if a.get("ai_answers") else {})})
        return rows

    def _attempts(self, user_id: str) -> list[dict]:
        return apply.query_all(self.table, user_id, ATTEMPT, ConsistentRead=True)

    def ledger(self, user_id: str, alert_id: str) -> dict:
        row = self._get(user_id, alert_id) or {}
        return {k: int(row.get(k, 0)) for k in ("held", "charged", "disputes")}

    def summary(self, user_id: str, now: datetime | None = None, tz: str | None = None, queued: int = 0,
                queued_ids=frozenset()) -> dict:
        """The one set of numbers every client shows: the popup, the badge,
        the board, the account page and /apply. Old-path applications are
        included while that path still exists."""
        now = _utc(now)
        # Each read once: the extension asks for this every 15 minutes and on every popup.
        attempts = self._attempts(user_id)
        if self.expire(user_id, now, attempts):
            attempts = self._attempts(user_id)
        month, day = periods(now, tz)
        m, d = self.ledger(user_id, LEDGER_MONTH + month), self.ledger(user_id, LEDGER_DAY + day)
        plan = apply.plan_of(self.table, user_id)
        month_limit, day_limit = limits(self.table, user_id, plan)
        plan_month, plan_day = PLAN_LIMITS[plan]
        applied = apply._applied(self.table, user_id)
        old_m, old_d = legacy_used(self.table, user_id, month, day, tz, now, applied)
        old_sub_m = old_sub_d = 0
        for r in applied:
            if r.get("status") == "submitted":
                rm, rd = periods(datetime.fromisoformat(r["at"]), tz)
                old_sub_m += rm == month
                old_sub_d += rd == day
        left = [lim - led["held"] - old for lim, led, old in ((month_limit, m, old_m), (day_limit, d, old_d)) if lim is not None]
        period_led, period_old = (d, old_sub_d) if plan_day else (m, old_sub_m)
        from ai_answers import CAPS, _month_row  # noqa: PLC0415 -- ai_answers imports apply as well; kept out of module load
        ai_used = int((self._get(user_id, _month_row(now)) or {}).get("n", 0))
        return {"plan": plan, "period": "day" if plan_day else "month", "limit": plan_day or plan_month,
                "daily_max": day_limit if day_limit != plan_day else None,
                "used": period_led["charged"] + period_old,
                "in_progress": max(0, (m["held"] - m["charged"]) + (old_m - old_sub_m)),
                "remaining": max(0, min(left)) if left else None,
                "applied_today": d["charged"] + old_sub_d,
                # Jobs the extension filled in today, sent or left to send, each once.
                "filled_today": old_sub_d + len({a["job_id"] for a in attempts if a["state"] in (FILLED, SUBMITTED, UNCONFIRMED)
                                                 and periods(datetime.fromisoformat(a["reserved_at"]), tz)[1] == day}),
                "unconfirmed": sum(1 for a in attempts if a["state"] == UNCONFIRMED),
                "needs_input": len(self.needs(user_id, queued_ids, attempts)), "queued": queued,
                "disputes_left": max(0, DISPUTES_PER_PERIOD - self.ledger(user_id, LEDGER_MONTH + billing_period(now, tz))["disputes"]),
                "ai": {"used": ai_used, "limit": CAPS.get(plan)}, "tz": str(_zone(tz))}

    @staticmethod
    def view(a: dict) -> dict:
        return {k: (int(v) if isinstance(v, Decimal) else v) for k, v in a.items()
                if k in ("attempt_id", "job_id", "state", "reserved_at", "expires_at", "started_at", "settled_at", "month", "day", "reason",
                         "ai_answers")}
