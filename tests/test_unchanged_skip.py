"""The loader skips listings the upsert would not change, and nothing else.

A fragment carries the whole board of every company that changed at
all, and on 2026-10-21 96% of its listings matched the stored row. The
loader now leaves those alone and only moves last_seen. This replays
random payloads through the skipping path and through the plain upsert
on two copies of one database and requires the same rows, search index
and meta afterwards, so a change to upsert_job that would_not_change
does not mirror fails here. Then the closing, reopening and last_seen
rules by name.

Run directly, no framework:  python tests/test_unchanged_skip.py
"""

import json
import os
import random
import sqlite3
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "loader"))
os.environ.pop("DATA_BUCKET", None)

import load_to_sqlite as lts  # noqa: E402

# Descriptions "upload" without S3, so a stored hash survives the load.
lts.DESCRIPTIONS_BUCKET = "test-bucket"
lts.put_many = lambda bucket, items: {jid for jid, _ in items}
real_now, real_skip = lts.now_iso, lts.would_not_change

failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}: {name}{'' if ok else '  -- ' + detail}")
    if not ok:
        failures.append(name)


def load(conn, tmp: Path, payload: list[dict], ts: str | None = None, skip: bool = True) -> None:
    lts.now_iso = (lambda: ts) if ts else real_now
    lts.would_not_change = real_skip if skip else (lambda *a: False)
    path = tmp / "resolved.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    try:
        with conn:
            lts.load_resolved(conn, path, drop_description=True)
    finally:
        lts.now_iso, lts.would_not_change = real_now, real_skip


def state(conn) -> tuple:
    cols = [r[1] for r in conn.execute("PRAGMA table_info(jobs)") if r[1] != "last_seen"]
    jobs = conn.execute(f"SELECT {', '.join(cols)} FROM jobs ORDER BY id").fetchall()
    fts = conn.execute("SELECT id, sz FROM jobs_fts_docsize ORDER BY id").fetchall()
    meta = conn.execute("SELECT key, value FROM meta ORDER BY key").fetchall()
    return [tuple(r) for r in jobs], [tuple(r) for r in fts], [tuple(r) for r in meta]


ATS = {"acme.com": "greenhouse", "wd.com": "workday", "cm.com": "comeet"}
SALARIES = [(None, 0, None), ("", 0, None), ("₪20,000", 0, "disclosed"), ("₪18,000", 1, "table"),
            ("₪25,000", 1, "estimated"), (None, 1, "estimated"), ("$100k", 0, None)]


# Recent enough for a Workday repost to count, and the "30+ Days Ago" bucket.
RECENT = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
THIRTY = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()


def job(rng: random.Random, n: int, ats: str) -> dict:
    text, est, source = rng.choice(SALARIES)
    j = {"external_id": str(n), "ats": ats, "title": rng.choice(["Engineer", "Engineer II", "PM"]) + f" {n}",
         "location": rng.choice(["Tel Aviv, Israel", "Haifa, Israel", "Remote", None, "2 Locations", "3 Locations   |   Glass"]),
         "department": rng.choice(["R&D", None]), "url": rng.choice([f"https://x.com/{n}", "javascript:x"]),
         "posted_at": rng.choice(["2026-09-01T00:00:00+00:00", "2026-09-02T00:00:00+00:00", None, RECENT, THIRTY]),
         "description": rng.choice([None, "", "Build things.", f"Build {n} things."]),
         "skills": rng.choice([[], ["python"], ["python", "go"]]),
         "seniority": rng.choice(["senior", None]), "workplace_type": rng.choice(["remote", "hybrid", None]),
         "salary_text": text, "salary_is_estimate": est}
    if source:
        j["salary_source"] = source
    if rng.random() < 0.3:
        j["description_chars"] = rng.choice([0, 10, 900])
    if rng.random() < 0.2:
        j["country"] = rng.choice(["IL", "US"])
    return j


def mutate(rng: random.Random, j: dict) -> dict:
    """Mostly the same listing, sometimes one field moved."""
    j = dict(j)
    if rng.random() < 0.5:
        other = job(rng, int(j["external_id"]), j["ats"])
        key = rng.choice(list(other))
        j[key] = other[key]
    return j


def board(rng: random.Random, jobs: dict[str, list[dict]], keep: float) -> list[dict]:
    out = []
    for domain, js in jobs.items():
        listed = [mutate(rng, j) for j in js if rng.random() < keep]
        if listed and rng.random() < 0.2:
            # One id twice in one payload, as Workable sends a multi-city post.
            listed.append(dict(listed[0], location="Jerusalem, Israel"))
        out.append({"domain": domain, "ats": ATS[domain], "token": domain.split(".")[0],
                    "job_count": len(listed), "jobs": listed})
    return out


def day(n: int) -> str:
    return (datetime(2026, 9, 1, tzinfo=timezone.utc) + timedelta(days=n)).isoformat(timespec="seconds")


with tempfile.TemporaryDirectory() as td:
    tmp = Path(td)
    mismatches = []
    for seed in range(60):
        rng = random.Random(seed)
        jobs = {d: [job(rng, n, a) for n in range(12)] for d, a in ATS.items()}
        a, b = lts.open_db(tmp / f"a{seed}.db"), lts.open_db(tmp / f"b{seed}.db")
        # Day 0 everything, day 1 a partial board (closes some), day 4 a
        # board that brings some back after more than two days.
        for i, (when, keep) in enumerate([(day(0), 1.0), (day(1), 0.6)]):
            p = board(random.Random(seed * 100 + i), jobs, keep)
            load(a, tmp, p, when)
            load(b, tmp, p, when)
        last = board(random.Random(seed * 100 + 9), jobs, 0.9)
        load(a, tmp, last, day(4))
        load(b, tmp, last, day(4), skip=False)
        if state(a) != state(b):
            mismatches.append(seed)
        a.close()
        b.close()
    check("skipping and upserting leave the same rows, index and meta (60 random boards)",
          not mismatches, f"seeds {mismatches}")
    # The equivalence above holds just as well if nothing is ever
    # skipped, so also check that ordinary listings are.
    calls = []
    lts.would_not_change = lambda *args: calls.append(real_skip(*args)) or calls[-1]
    plain = [{"external_id": str(n), "ats": "greenhouse", "title": f"Engineer {n}", "url": f"https://x.com/{n}",
              "location": "Tel Aviv, Israel", "description": f"Build {n} things.", "skills": ["python"],
              "salary_text": "₪20,000" if n % 2 else None, "seniority": "senior"} for n in range(20)]
    c = lts.open_db(tmp / "count.db")
    path = tmp / "resolved.json"
    path.write_text(json.dumps([{"domain": "acme.com", "ats": "greenhouse", "token": "acme", "jobs": plain}]),
                    encoding="utf-8")
    for _ in range(2):
        with c:
            lts.load_resolved(c, path, drop_description=True)
    lts.would_not_change = real_skip
    check("an identical second load skips every ordinary listing", calls[-20:] == [True] * 20, str(calls[-20:]))
    c.close()

    # The rules by name, on one small board.
    conn = lts.open_db(tmp / "rules.db")

    def g(n, **kw):
        return dict({"external_id": str(n), "ats": "greenhouse", "title": f"Engineer {n}",
                     "url": f"https://acme.com/{n}", "location": "Tel Aviv, Israel"}, **kw)

    def acme(*jobs):
        return [{"domain": "acme.com", "ats": "greenhouse", "token": "acme", "job_count": len(jobs), "jobs": list(jobs)}]

    def row(n):
        jid = lts.job_id("acme.com", "greenhouse", str(n), None, "")
        return conn.execute("SELECT * FROM jobs WHERE id = ?", (jid,)).fetchone()

    now = datetime.now(timezone.utc)
    load(conn, tmp, acme(g(1), g(2), g(3)), (now - timedelta(hours=2)).isoformat(timespec="seconds"))
    load(conn, tmp, acme(g(1), g(2)), (now - timedelta(minutes=30)).isoformat(timespec="seconds"))
    check("a listing missing from the board still closes when the rest are skipped",
          row(3)["closed_at"] is not None and row(1)["closed_at"] is None and row(2)["closed_at"] is None)
    check("an unchanged listing seen two hours ago moves last_seen",
          row(1)["last_seen"] == (now - timedelta(minutes=30)).isoformat(timespec="seconds"), row(1)["last_seen"])
    load(conn, tmp, acme(g(1), g(2, title="Staff Engineer 2")))
    check("an unchanged listing seen within the hour keeps its last_seen",
          row(1)["last_seen"] == (now - timedelta(minutes=30)).isoformat(timespec="seconds"), row(1)["last_seen"])
    check("a changed listing is written, last_seen included",
          row(2)["title"] == "Staff Engineer 2" and row(2)["last_seen"] > row(1)["last_seen"])
    conn.execute("UPDATE jobs SET closed_at = ? WHERE id = ?",
                 ((now - timedelta(days=3)).isoformat(timespec="seconds"), row(3)["id"]))
    conn.commit()
    load(conn, tmp, acme(g(1), g(2, title="Staff Engineer 2"), g(3)))
    check("a closed listing that comes back unchanged reopens",
          row(3)["closed_at"] is None and row(3)["reopened_at"] is not None, str(dict(row(3))))
    first_seen = row(1)["first_seen"]
    check("first_seen never moves on a skip", first_seen == (now - timedelta(hours=2)).isoformat(timespec="seconds"))

    # Workday: the "N Locations" placeholder and the repost.
    def w(**kw):
        return [{"domain": "wd.com", "ats": "workday", "token": "wd", "job_count": 1,
                 "jobs": [dict({"external_id": "JR1", "ats": "workday", "title": "Engineer", "url": "https://wd.com/JR1",
                                "location": "Haifa, Israel", "posted_at": (now - timedelta(days=60)).isoformat()}, **kw)]}]

    def wrow():
        return conn.execute("SELECT * FROM jobs WHERE id = ?", (lts.job_id("wd.com", "workday", "JR1", None, ""),)).fetchone()

    load(conn, tmp, w())
    stored = wrow()
    for placeholder in ("2 Locations", "3 Locations   |   Glass - Michigan"):
        load(conn, tmp, w(location=placeholder))
        check(f"a Workday '{placeholder}' keeps the location, city and country an earlier poll resolved",
              (wrow()["location"], wrow()["city"], wrow()["country"]) == (stored["location"], stored["city"], stored["country"]),
              str(dict(wrow())))
    load(conn, tmp, w(location="Tel Aviv, Israel"))
    check("a real new location still moves the job", wrow()["location"] == "Tel Aviv, Israel" and wrow()["city"] == stored["city"].replace("Haifa", "Tel Aviv"),
          str(dict(wrow())))
    sixty = wrow()["posted_at"]
    load(conn, tmp, w(location="Tel Aviv, Israel", posted_at=(now - timedelta(days=59)).isoformat()))
    check("a day of bucket drift leaves the first Workday date", wrow()["posted_at"] == sixty)
    load(conn, tmp, w(location="Tel Aviv, Israel", posted_at=(now - timedelta(days=30)).isoformat()))
    check("the 30+ bucket is never a repost", wrow()["posted_at"] == sixty)
    check("drift and the 30+ bucket count no repost", (wrow()["reposts"], wrow()["first_posted_at"]) == (None, None),
          str((wrow()["reposts"], wrow()["first_posted_at"])))
    first = (now - timedelta(days=10)).isoformat()
    load(conn, tmp, w(location="Tel Aviv, Israel", posted_at=first))
    check("a Workday repost (two months stored, posted ten days ago now) takes the new date", wrow()["posted_at"] == first, wrow()["posted_at"])
    check("a repost keeps the date it replaced and counts once", (wrow()["reposts"], wrow()["first_posted_at"]) == (1, sixty),
          str((wrow()["reposts"], wrow()["first_posted_at"])))
    repost = (now - timedelta(days=1)).isoformat()
    load(conn, tmp, w(location="Tel Aviv, Israel", posted_at=repost))
    check("a second repost counts again and keeps the first date", (wrow()["posted_at"], wrow()["reposts"], wrow()["first_posted_at"]) == (repost, 2, sixty),
          str((wrow()["posted_at"], wrow()["reposts"], wrow()["first_posted_at"])))
    load(conn, tmp, w(location="Tel Aviv, Israel", posted_at=None))
    check("a poll with no date never blanks a stored one", wrow()["posted_at"] == repost, str(wrow()["posted_at"]))
    check("nor counts as a repost", wrow()["reposts"] == 2, str(wrow()["reposts"]))
    conn.close()

sys.exit(1 if failures else 0)
