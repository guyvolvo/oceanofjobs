"""The regression tests api/AUTO_APPLY_CONTRACT.md requires before any
client switches to api/attempts.py: concurrent reservations, a crash after
each event, duplicate reports, expiry, dispute refunds, and periods.

Against moto's in-memory DynamoDB, which applies real condition
expressions and transactions.

Needs moto (test only):    python -m pip install "moto[dynamodb]==5.1.4"
Run directly, no framework:  python tests/test_attempts.py
"""
import os
import sys
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))
for k, v in {"AWS_DEFAULT_REGION": "il-central-1", "AWS_ACCESS_KEY_ID": "testing", "AWS_SECRET_ACCESS_KEY": "testing"}.items():
    os.environ[k] = v

import boto3  # noqa: E402
from moto import mock_aws  # noqa: E402

import apply  # noqa: E402
import attempts as at  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failures.append(name)


def raises(fn, exc):
    try:
        fn()
        return False
    except exc:
        return True


NOW = datetime(2026, 10, 21, 12, 0, tzinfo=timezone.utc)
GH = "https://job-boards.greenhouse.io/embed/job_app?for=acme&token={}"


def job(n, url=None):
    return {"job_id": f"{n:016x}", "url": url or GH.format(1000 + n), "title": "Engineer", "company": "acme.com"}


def serializable(A):
    """DynamoDB runs each transaction atomically and in isolation; moto
    applies its items one by one, visible to other threads midway. A lock
    around each transaction restores what DynamoDB guarantees, while the
    threads still race on every read and every condition."""
    lock = threading.Lock()
    real = A.client.transact_write_items

    def tx(**kw):
        with lock:
            return real(**kw)

    A.client.transact_write_items = tx
    return A


def fresh_table():
    ddb = boto3.resource("dynamodb", region_name="il-central-1")
    name = f"t{fresh_table.n}"
    fresh_table.n += 1
    t = ddb.create_table(TableName=name, KeySchema=[{"AttributeName": "user_id", "KeyType": "HASH"},
                                                   {"AttributeName": "alert_id", "KeyType": "RANGE"}],
                         AttributeDefinitions=[{"AttributeName": "user_id", "AttributeType": "S"},
                                               {"AttributeName": "alert_id", "AttributeType": "S"}],
                         BillingMode="PAY_PER_REQUEST")
    return t, serializable(at.Attempts(t))


fresh_table.n = 0


def counts(A, user="u", month="2026-10", day="2026-10-21"):
    return A.ledger(user, at.LEDGER_MONTH + month), A.ledger(user, at.LEDGER_DAY + day)


with mock_aws():
    # Concurrent reservations for the last credit: exactly one succeeds.
    t, A = fresh_table()
    for i in range(29):
        A.reserve("u", f"pre-{i:04d}", job(i), NOW)
    results, lock = [], threading.Lock()

    def race(i):
        try:
            A.reserve("u", f"race-{i:04d}", job(100 + i), NOW)
            r = "ok"
        except at.LimitReached:
            r = "limit"
        except Exception as e:  # noqa: BLE001
            r = repr(e)
        with lock:
            results.append(r)

    threads = [threading.Thread(target=race, args=(i,)) for i in range(8)]
    [th.start() for th in threads]
    [th.join() for th in threads]
    m, _ = counts(A)
    check("eight tabs race for the last free credit: exactly one gets it", results.count("ok") == 1 and results.count("limit") == 7,
          repr(results))
    check("and the ledger holds exactly 30", m["held"] == 30, repr(m))

    # Concurrent reservations for one job: exactly one succeeds.
    t, A = fresh_table()
    results = []

    def same_job(i):
        try:
            A.reserve("u", f"same-{i:04d}", job(7), NOW)
            r = "ok"
        except at.JobTaken:
            r = "taken"
        except Exception as e:  # noqa: BLE001
            r = repr(e)
        with lock:
            results.append(r)

    threads = [threading.Thread(target=same_job, args=(i,)) for i in range(6)]
    [th.start() for th in threads]
    [th.join() for th in threads]
    check("six attempts at one job at once: one gets it", results.count("ok") == 1 and results.count("taken") == 5, repr(results))
    check("and holds one credit", counts(A)[0]["held"] == 1, repr(counts(A)))
    check("the same job from a careers page counts as the same job",
          raises(lambda: A.reserve("u", "careers-0001", job(99, "https://acme.com/careers?gh_jid=1007"), NOW), at.JobTaken))

    # A crash after each event.
    t, A = fresh_table()
    A.reserve("u", "crash-res-01", job(1), NOW)
    A.expire("u", NOW + timedelta(minutes=29))
    check("reserved, crash: still held at 29 minutes", counts(A)[0]["held"] == 1)
    A.expire("u", NOW + timedelta(minutes=31))
    m, d = counts(A)
    check("reserved, crash: abandoned and released at 31 minutes, nothing charged", m == {"held": 0, "charged": 0, "disputes": 0}
          and d["held"] == 0, repr((m, d)))
    check("and the job can be tried again with a new attempt id",
          A.reserve("u", "crash-res-02", job(1), NOW + timedelta(minutes=32))["state"] == at.RESERVED)

    A.reserve("u", "crash-sub-01", job(2), NOW)
    A.submission_started("u", "crash-sub-01", NOW + timedelta(minutes=1))
    A.expire("u", NOW + timedelta(minutes=29))
    check("submission started, crash: still open at 29 minutes", A._get("u", at.ATTEMPT + "crash-sub-01")["state"] == at.STARTED)
    A.expire("u", NOW + timedelta(minutes=31))
    a = A._get("u", at.ATTEMPT + "crash-sub-01")
    m, _ = counts(A)
    check("submission started, crash: unconfirmed and charged once at 31 minutes", a["state"] == at.UNCONFIRMED and m["charged"] == 1,
          repr((a["state"], m)))
    check("and never retried: a new attempt for the job is refused",
          raises(lambda: A.reserve("u", "crash-sub-02", job(2), NOW + timedelta(minutes=40)), at.JobTaken))

    A.reserve("u", "crash-set-01", job(3), NOW)
    A.submission_started("u", "crash-set-01", NOW)
    A.settle("u", "crash-set-01", at.SUBMITTED, "", NOW)
    A.settle("u", "crash-set-01", at.SUBMITTED, "", NOW)  # the report retried after a lost response
    check("settled, then the report retried: still one charge", counts(A)[0]["charged"] == 2, repr(counts(A)))
    A.expire("u", NOW + timedelta(hours=2))
    check("and expiry leaves a settled attempt alone", A._get("u", at.ATTEMPT + "crash-set-01")["state"] == at.SUBMITTED)

    # Duplicate reports.
    t, A = fresh_table()
    first = A.reserve("u", "dup-000001", job(1), NOW)
    again = A.reserve("u", "dup-000001", job(1), NOW + timedelta(seconds=5))
    check("a reservation retried after a lost response: same attempt, one credit held",
          first["reserved_at"] == again["reserved_at"] and counts(A)[0]["held"] == 1, repr(counts(A)))
    check("the same attempt id for another job is refused", raises(lambda: A.reserve("u", "dup-000001", job(2), NOW), at.Conflict))
    A.submission_started("u", "dup-000001", NOW)
    check("submission start repeated: acknowledged again, nothing changes",
          A.submission_started("u", "dup-000001", NOW)["state"] == at.STARTED and counts(A)[0]["held"] == 1)
    A.settle("u", "dup-000001", at.UNCONFIRMED, "no confirmation", NOW)
    A.settle("u", "dup-000001", at.UNCONFIRMED, "no confirmation", NOW)
    check("unconfirmed reported twice: charged once", counts(A)[0]["charged"] == 1, repr(counts(A)))
    check("a different outcome after settling is refused", raises(lambda: A.settle("u", "dup-000001", at.FAILED, "", NOW), at.Conflict))
    A.settle("u", "dup-000001", at.SUBMITTED, "confirmation seen later", NOW)
    check("unconfirmed then confirmed later: still one charge", counts(A)[0]["charged"] == 1 and counts(A)[0]["held"] == 1)
    check("a failure can't follow a confirmed submission", raises(lambda: A.settle("u", "dup-000001", at.FAILED, "", NOW), at.Conflict))

    A.reserve("u", "dup-000002", job(2), NOW)
    check("a reserved attempt can't be settled as submitted without a submission start",
          raises(lambda: A.settle("u", "dup-000002", at.SUBMITTED, "", NOW), at.Conflict))
    A.settle("u", "dup-000002", at.NEEDS_INPUT, "Needs your answer: Why us?", NOW)
    A.settle("u", "dup-000002", at.NEEDS_INPUT, "Needs your answer: Why us?", NOW)
    check("a release reported twice releases once", counts(A)[0]["held"] == 1, repr(counts(A)))

    # Expiry and submission start.
    t, A = fresh_table()
    A.reserve("u", "exp-000001", job(1), NOW)
    check("submission start at 29 minutes is acknowledged",
          A.submission_started("u", "exp-000001", NOW + timedelta(minutes=29))["state"] == at.STARTED)
    A.reserve("u", "exp-000002", job(2), NOW)
    check("submission start at 31 minutes is refused: the extension must not submit",
          raises(lambda: A.submission_started("u", "exp-000002", NOW + timedelta(minutes=31)), at.Expired))
    check("and that attempt is abandoned and released", A._get("u", at.ATTEMPT + "exp-000002")["state"] == at.ABANDONED
          and counts(A)[0]["held"] == 1, repr(counts(A)))
    A.reserve("u", "exp-000003", job(3), NOW)
    check("the refused start also settled the user's other expired attempt", A._get("u", at.ATTEMPT + "exp-000001")["state"] == at.UNCONFIRMED)
    A.reserve("v", "exp-000003", job(3), NOW)  # another user, who never calls in again
    n = A.sweep(NOW + timedelta(minutes=45))
    check("the periodic sweep settles expired attempts of users who never call in", n == 2
          and A._get("u", at.ATTEMPT + "exp-000003")["state"] == at.ABANDONED
          and A._get("v", at.ATTEMPT + "exp-000003")["state"] == at.ABANDONED, repr(n))

    # Disputes.
    t, A = fresh_table()
    for i in range(7):
        A.reserve("u", f"dis-{i:06d}", job(i), NOW)
        A.submission_started("u", f"dis-{i:06d}", NOW)
        A.settle("u", f"dis-{i:06d}", at.UNCONFIRMED, "no confirmation", NOW)
    check("seven unconfirmed: seven charged", counts(A)[0]["charged"] == 7)
    A.dispute("u", "dis-000000", NOW + timedelta(days=1))
    m, d = counts(A)
    check("a dispute refunds at once", m["charged"] == 6 and m["held"] == 6 and m["disputes"] == 1 and d["charged"] == 6, repr((m, d)))
    a = A._get("u", at.ATTEMPT + "dis-000000")
    check("and keeps the attempt and its audit trail", a["state"] == at.DISPUTED
          and [e["event"] for e in a["audit"]] == ["reserved", "submission_started", "unconfirmed", "disputed_refunded"], repr(a["audit"]))
    A.dispute("u", "dis-000000", NOW + timedelta(days=1))
    check("disputing it again refunds nothing", counts(A)[0]["charged"] == 6 and counts(A)[0]["disputes"] == 1, repr(counts(A)))
    for i in range(1, 5):
        A.dispute("u", f"dis-{i:06d}", NOW + timedelta(days=1))
    check("the sixth dispute request in the period is refused",
          raises(lambda: A.dispute("u", "dis-000005", NOW + timedelta(days=1)), at.NotDisputable) and counts(A)[0]["charged"] == 2,
          repr(counts(A)))
    check("a dispute after 14 days is refused", raises(lambda: A.dispute("u", "dis-000006", NOW + timedelta(days=15)), at.NotDisputable))
    A.reserve("u", "dis-confirmd", job(50), NOW)
    A.submission_started("u", "dis-confirmd", NOW)
    A.settle("u", "dis-confirmd", at.SUBMITTED, "", NOW)
    check("a confirmed submission can't be disputed", raises(lambda: A.dispute("u", "dis-confirmd", NOW), at.NotDisputable))
    check("a disputed job can be queued again by the user, as a new attempt",
          A.reserve("u", "dis-retry-01", job(0), NOW + timedelta(days=2))["state"] == at.RESERVED)

    # Periods and time zones.
    t, A = fresh_table()
    late = datetime(2026, 10, 31, 21, 50, tzinfo=timezone.utc)  # 23:50 in Jerusalem
    A.reserve("u", "per-000001", job(1), late, tz="Asia/Jerusalem")
    A.submission_started("u", "per-000001", late)
    A.settle("u", "per-000001", at.SUBMITTED, "", datetime(2026, 11, 1, 1, 0, tzinfo=timezone.utc))
    check("a settle delayed past midnight charges the month it was reserved in",
          A.ledger("u", at.LEDGER_MONTH + "2026-10")["charged"] == 1 and A.ledger("u", at.LEDGER_MONTH + "2026-11")["charged"] == 0)
    check("in the user's time zone, not UTC", A._get("u", at.ATTEMPT + "per-000001")["day"] == "2026-10-31")
    A.reserve("u", "per-000002", job(2), late, tz="America/New_York")
    check("a time zone change applies to new attempts only", A._get("u", at.ATTEMPT + "per-000002")["day"] == "2026-10-31"
          and A._get("u", at.ATTEMPT + "per-000001")["tz"] == "Asia/Jerusalem")
    check("an unknown time zone falls back to UTC", at.periods(late, "Mars/Base") == ("2026-10", "2026-10-31"))

    # Limits: Pro per day, and the user's own daily maximum on any plan.
    t, A = fresh_table()
    t.put_item(Item={"user_id": "u", "alert_id": apply.PLAN_ROW, "plan": "pro", "status": "active"})
    for i in range(50):
        A.reserve("u", f"pro-{i:06d}", job(i), NOW)
    check("Pro stops at 50 a day", raises(lambda: A.reserve("u", "pro-x00051", job(51), NOW), at.LimitReached))
    check("and starts again the next day", A.reserve("u", "pro-x00052", job(52), NOW + timedelta(days=1))["state"] == at.RESERVED)
    t, A = fresh_table()
    apply.put_profile(t, "u", {"settings": {"guardrails": {"daily_limit": 3}}})
    for i in range(3):
        A.reserve("u", f"own-{i:06d}", job(i), NOW)
    check("the user's own daily maximum holds on the free plan too", raises(lambda: A.reserve("u", "own-x00004", job(4), NOW), at.LimitReached))
    s = A.summary("u", NOW)
    check("the summary shows what's held and what's left", s["in_progress"] == 3 and s["remaining"] == 0 and s["used"] == 0
          and s["daily_max"] == 3 and s["plan"] == "free" and s["period"] == "month", repr(s))

    # Applications submitted through the old path are respected.
    t, A = fresh_table()
    t.put_item(Item={"user_id": "u", "alert_id": apply.APPLIED + job(9)["job_id"], "job_id": job(9)["job_id"], "url": job(9)["url"],
                     "status": "submitted", "at": NOW.isoformat()})
    check("a job submitted through the old claim path can't be reserved", raises(lambda: A.reserve("u", "old-000001", job(9), NOW), at.JobTaken))

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
