"""The verified-only count index, and the skills match driven from its
covering index: every request shape still runs, with the same totals,
and the hint names an index only where the query can use it.

INDEXED BY an index the WHERE cannot use is the error "no query
solution", a 500 on the board, so each shape is run for real against a
database the loader built, with the box's own indexes.

Run directly, no framework:  python tests/test_verified_index.py
"""

import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "loader"))
sys.path.insert(0, str(ROOT / "api"))
for k, v in {"ALERTS_TABLE": "test-alerts", "DATA_BUCKET": "test-bucket", "DATA_KEY": "jobs.db",
             "AWS_DEFAULT_REGION": "il-central-1", "AWS_ACCESS_KEY_ID": "testing", "AWS_SECRET_ACCESS_KEY": "testing"}.items():
    os.environ.setdefault(k, v)

import load_to_sqlite as lts  # noqa: E402
import handler  # noqa: E402
import job_filters  # noqa: E402

failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}: {name}{'' if ok else '  -- ' + detail}")
    if not ok:
        failures.append(name)


def job(n, location, skills):
    return {"external_id": str(n), "ats": "greenhouse", "title": f"Engineer {n}", "url": f"https://acme.com/{n}",
            "location": location, "skills": skills, "department": "Engineering"}


SHAPES = [
    {}, {"confidence": "all"}, {"confidence": "best_effort"}, {"country": "US"}, {"country": "US", "confidence": "all"},
    {"include_closed": "1"}, {"company": "acme.com"}, {"skills": "Python", "sort": "match"},
    {"skills": "Python", "sort": "age", "country": "IL"}, {"skills": "Python", "include_closed": "1"},
    {"skills": "Python", "confidence": "all"},
]


def expected(conn, p):
    """The same question asked the slow, obvious way."""
    rows = conn.execute("SELECT confidence, closed_at, country, skills, department FROM jobs").fetchall()
    conf = p.get("confidence", "verified")
    n = 0
    for r in rows:
        if r["closed_at"] and not p.get("include_closed"):
            continue
        if conf != "all" and r["confidence"] != conf:
            continue
        if p.get("country") and p["country"] not in (r["country"] or "").split(","):
            continue
        if p.get("skills") and "python" not in (r["skills"] or "").lower().split(","):
            continue
        n += 1
    return n


with tempfile.TemporaryDirectory() as td:
    tmp = Path(td)
    conn = lts.open_db(tmp / "t.db")
    path = tmp / "resolved.json"
    path.write_text(json.dumps([{"domain": "acme.com", "ats": "greenhouse", "token": "acme", "confidence": "verified",
                                 "job_count": 6, "jobs": [
                                     job(1, "Tel Aviv, Israel", ["Python", "Go"]), job(2, "Tel Aviv, Israel", ["Java"]),
                                     job(3, "New York, NY, United States", ["Python"]), job(4, "Austin, TX, United States", []),
                                     job(5, "Haifa, Israel", ["Python"]), job(6, "Berlin, Germany", ["Python"])]}]),
                    encoding="utf-8")
    with conn:
        lts.load_resolved(conn, path)
        conn.execute("UPDATE jobs SET confidence = 'best_effort' WHERE external_id = '5'")
        conn.execute("UPDATE jobs SET closed_at = '2026-10-01T00:00:00+00:00' WHERE external_id = '6'")
        lts.normalize_posted_at(conn)
        lts.ensure_box_indexes(conn, optimize=False)
    job_filters.register_functions(conn)
    handler.get_connection = lambda: conn

    caps = job_filters._read_caps(conn)
    check("the loader builds the verified index and the API sees it", caps.verified_index and caps.board_indexes)
    hint = job_filters.count_index_hint
    check("a verified request with no filter of its own names the verified index",
          hint({}, caps) == " INDEXED BY idx_jobs_open_verified_posted" and hint({"country": "US"}, caps).endswith("verified_posted"))
    check("confidence=all keeps the board's index", hint({"confidence": "all"}, caps) == " INDEXED BY idx_jobs_open_posted")
    check("closed rows or a selective filter get no hint",
          hint({"include_closed": "1"}, caps) == "" and hint({"department": "X"}, caps) == "" and hint({"skills": "Python"}, caps) == "")

    for p in SHAPES:
        try:
            got = handler.route_jobs(dict(p))["total"]
            check(f"{json.dumps(p)} runs and counts {expected(conn, p)}", got == expected(conn, p), f"got {got}")
        except Exception as e:  # noqa: BLE001
            check(f"{json.dumps(p)} runs", False, repr(e))

    # The API can ship before the loader's next apply builds the index. A
    # fresh connection's capabilities are read anew (the cache is per
    # connection, for _CAPS_TTL_S), which is what clearing it stands for.
    conn.execute("DROP INDEX idx_jobs_open_verified_posted")
    job_filters._caps_cache.clear()
    caps = job_filters._read_caps(conn)
    check("without the index the hint falls back to the board's", not caps.verified_index and hint({}, caps) == " INDEXED BY idx_jobs_open_posted")
    for p in ({}, {"country": "US"}, {"skills": "Python", "sort": "match"}):
        try:
            got = handler.route_jobs(dict(p))["total"]
            check(f"without the index, {json.dumps(p)} still counts {expected(conn, p)}", got == expected(conn, p), f"got {got}")
        except Exception as e:  # noqa: BLE001
            check(f"without the index, {json.dumps(p)} runs", False, repr(e))
    conn.close()

print()
if failures:
    print(f"{len(failures)} failed")
    sys.exit(1)
print("all passed")
