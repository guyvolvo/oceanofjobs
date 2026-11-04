"""A job closes only after complete reads have gone without it for 6 hours
and 3 times in a row; incomplete and failed reads never count.

Run directly, no framework:  python tests/test_close_grace.py
"""

import json
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "loader"))
sys.path.insert(0, str(ROOT))

import load_to_sqlite  # noqa: E402
from load_to_sqlite import load_resolved, open_db  # noqa: E402
import probe  # noqa: E402

failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}: {name}{'' if ok else '  -- ' + detail}")
    if not ok:
        failures.append(name)


T0 = datetime(2026, 11, 3, 0, 0, tzinfo=timezone.utc)


def job(n: int) -> dict:
    return {"external_id": str(n), "ats": "greenhouse", "title": f"Engineer {n}",
            "url": f"https://acme.com/{n}", "location": "Tel Aviv, Israel"}


def read(conn, tmp: Path, at_hours: float, ids: list[int] | None, **extra) -> None:
    """One read of acme.com's board at T0 + at_hours. ids=None is a failed read."""
    stamp = (T0 + timedelta(hours=at_hours)).isoformat(timespec="seconds")
    load_to_sqlite.now_iso = lambda: stamp
    if ids is None:
        entry = {"domain": "acme.com", "ats": None, "token": None, "job_count": 0, "tried": 1,
                 "error": "timeout", "retryable": True, "jobs": []}
    else:
        entry = {"domain": "acme.com", "ats": "greenhouse", "token": "acme", "confidence": "verified",
                 "job_count": len(ids), "jobs": [job(n) for n in ids], **extra}
    path = tmp / "resolved.json"
    path.write_text(json.dumps([entry]), encoding="utf-8")
    with conn:
        load_resolved(conn, path)


def state(conn, n: int) -> dict:
    r = conn.execute("SELECT closed_at, missing_since, missing_reads FROM jobs WHERE external_id = ?", (str(n),)).fetchone()
    return dict(r)


with tempfile.TemporaryDirectory() as td:
    tmp = Path(td)
    conn = open_db(tmp / "t.db")
    read(conn, tmp, 0, [1, 2, 3, 4, 5, 6])

    read(conn, tmp, 0.25, [2, 3, 4, 5, 6])
    check("missing from one read: stays open", state(conn, 1)["closed_at"] is None, str(state(conn, 1)))
    check("and its clock started", state(conn, 1)["missing_since"] == "2026-11-03T00:15:00+00:00"
          and state(conn, 1)["missing_reads"] == 1, str(state(conn, 1)))

    for h in (1, 2, 3, 4, 5.25):
        read(conn, tmp, h, [2, 3, 4, 5, 6])
    check("missing for 5 hours over 6 reads: stays open", state(conn, 1)["closed_at"] is None, str(state(conn, 1)))

    read(conn, tmp, 6.25, [2, 3, 4, 5, 6])
    closed = state(conn, 1)["closed_at"]
    check("missing for 6 hours and 3+ reads: closed", closed == "2026-11-03T06:15:00+00:00", str(state(conn, 1)))

    read(conn, tmp, 6.5, [2, 3, 4, 5, 6])
    check("closing is idempotent: closed_at doesn't move", state(conn, 1)["closed_at"] == closed, str(state(conn, 1)))

    # Job 2 goes missing, comes back during the grace period, then goes missing again.
    read(conn, tmp, 7, [3, 4, 5, 6])
    read(conn, tmp, 10, [2, 3, 4, 5, 6])
    check("back during the grace period: clock resets", state(conn, 2)["missing_since"] is None
          and state(conn, 2)["missing_reads"] == 0, str(state(conn, 2)))
    read(conn, tmp, 11, [3, 4, 5, 6])
    read(conn, tmp, 14, [3, 4, 5, 6])
    read(conn, tmp, 16, [3, 4, 5, 6])
    check("after a reset, 6 hours count from the new miss: still open at 5h",
          state(conn, 2)["closed_at"] is None, str(state(conn, 2)))
    read(conn, tmp, 17, [3, 4, 5, 6])
    check("and closed once 6 hours have passed since it", state(conn, 2)["closed_at"] is not None, str(state(conn, 2)))

    # Job 3: a long gap between reads is not enough on its own.
    read(conn, tmp, 20, [4, 5, 6])
    read(conn, tmp, 40, [4, 5, 6])
    check("6+ hours but only 2 reads: stays open", state(conn, 3)["closed_at"] is None, str(state(conn, 3)))

    # Incomplete reads (the board is bigger than our cap) close nothing and start no clock.
    for h in range(41, 60, 3):
        read(conn, tmp, h, [5, 6], complete=False)
    check("incomplete reads: no closures", state(conn, 4)["closed_at"] is None and state(conn, 3)["closed_at"] is None,
          f"{state(conn, 3)} {state(conn, 4)}")
    check("incomplete reads: no clock for what they missed", state(conn, 4)["missing_since"] is None, str(state(conn, 4)))
    read(conn, tmp, 61, [3, 5, 6], complete=False)
    check("incomplete reads still reset what they saw", state(conn, 3)["missing_since"] is None, str(state(conn, 3)))

    # Failed reads never count as evidence.
    for h in range(62, 90, 2):
        read(conn, tmp, h, None)
    check("failed reads: no closures and no clock", state(conn, 5)["closed_at"] is None
          and state(conn, 5)["missing_since"] is None, str(state(conn, 5)))

    # An unchanged board (304) is not a read of its jobs either.
    read(conn, tmp, 90, [4, 5, 6])
    for h in range(91, 120, 2):
        read(conn, tmp, h, [], unchanged=True)
    check("304 reads don't advance the clock", state(conn, 3)["closed_at"] is None
          and state(conn, 3)["missing_reads"] == 1, str(state(conn, 3)))

    # A job that is really gone does close, in the end.
    for h in (121, 124, 128):
        read(conn, tmp, h, [4, 5])
    check("a job genuinely gone eventually closes", state(conn, 6)["closed_at"] is not None, str(state(conn, 6)))
    check("its missing_since stays, so the closure delay can be measured",
          state(conn, 6)["missing_since"] == "2026-11-08T01:00:00+00:00", str(state(conn, 6)))
    conn.close()

# Review checks (2026-11-03): incomplete reads leave running clocks alone,
# a closed job that comes back resets both fields, and a job closed before
# this change is neither reopened nor re-stamped.
with tempfile.TemporaryDirectory() as td:
    tmp = Path(td)
    conn = open_db(tmp / "t.db")
    read(conn, tmp, 0, [1, 2, 3])
    conn.execute("UPDATE jobs SET closed_at = '2026-10-20T10:00:00+00:00' WHERE external_id = '3'")
    conn.commit()

    read(conn, tmp, 1, [2])
    before = state(conn, 1)
    read(conn, tmp, 2, [2], complete=False)
    read(conn, tmp, 3, [], complete=False)
    check("an incomplete read leaves an unseen job's running clock exactly as it was",
          state(conn, 1) == before and before["missing_since"] is not None, f"{before} -> {state(conn, 1)}")

    for h in (8, 9):
        read(conn, tmp, h, [2])
    check("that clock then runs on to a normal close", state(conn, 1)["closed_at"] is not None, str(state(conn, 1)))
    read(conn, tmp, 10, [1, 2])
    reopened = conn.execute("SELECT closed_at, reopened_at FROM jobs WHERE external_id = '1'").fetchone()
    check("a closed job seen again reopens with both missing fields reset",
          reopened["closed_at"] is None and state(conn, 1)["missing_since"] is None and state(conn, 1)["missing_reads"] == 0,
          f"{dict(reopened)} {state(conn, 1)}")

    check("a job closed before this change stays closed, closed_at untouched, no clock",
          state(conn, 3) == {"closed_at": "2026-10-20T10:00:00+00:00", "missing_since": None, "missing_reads": None},
          str(state(conn, 3)))
    conn.close()

# The scraper side: a board bigger than the cap reports itself incomplete.
probe._cond_reset()
saved = probe._workday_list, probe._workday_build_job
try:
    probe._workday_list = lambda *a, **k: (5000, [{"externalPath": f"/job/x_{i}"} for i in range(3)])
    probe._workday_build_job = lambda *a, **k: a[6]
    probe.f_workday(None, "acme", "wd1", "ext", max_jobs=3000)
    check("Workday past its 3,000 cap marks the read capped", probe._cond.capped is True)
    probe._cond_reset()
    probe._workday_list = lambda *a, **k: (3, [{"externalPath": f"/job/x_{i}"} for i in range(3)])
    probe.f_workday(None, "acme", "wd1", "ext", max_jobs=3000)
    check("a board under the cap is not capped", probe._cond.capped is False)
    probe._cond_reset()
    probe._workday_list = lambda *a, **k: (2000, [{"externalPath": f"/job/x_{i}"} for i in range(3)])
    probe.f_workday(None, "acme", "wd1", "ext", max_jobs=3000)
    check("Workday's 2,000 total (its own ceiling) marks the read capped", probe._cond.capped is True)
finally:
    probe._workday_list, probe._workday_build_job = saved


def capped_resolve(domain):
    probe._capped(5000, 3000)
    return probe.Resolution(domain=domain, ats="workday")


def plain_resolve(domain):
    return probe.Resolution(domain=domain, ats="workday")


got = {r.domain: r.complete for r in probe.run_and_report(["big.com"], capped_resolve, True)}
got.update({r.domain: r.complete for r in probe.run_and_report(["small.com"], plain_resolve, True)})
check("run_and_report carries the flag onto the result", got == {"big.com": False, "small.com": True}, str(got))

print()
if failures:
    print(f"{len(failures)} failed:")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)
print("all passed")
