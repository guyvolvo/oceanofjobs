"""Answer the two expensive aggregate routes once per merge, not per request.

Measured with the edge cache bypassed, /api/stats took 7.03s and
/api/facets 5.02s, against 0.44s for /api/jobs. Both fire on every page
load. Between them they were most of the API's compute bill, and none of
it was work that differs between one visitor and the next: the same
snapshot produces the same answer until the next merge replaces it.

So the applier computes them against the snapshot it just built and
writes the results next to it. The API reads a finished number.

What is NOT precomputed here is anything filtered. Facets are counted
with the caller's other active filters applied, so only the unfiltered
case has a single answer, and handler.py falls back to computing the
rest live. Stats vary only by israel_only, and only in one field, so
both versions of that field ship in the same object.

Writing these is best effort by design. A failure here must not fail a
merge or hold up a snapshot: the API treats a missing file as "compute
it yourself", which is also what it does in the window between deploying
that code and this ever running.
"""

import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

# Two layouts to satisfy. In the repo these live under api/; in the
# deployed package the workflow flattens them next to the handler, one
# level above this file. Both go on the path so the same import works
# from a checkout and from a Lambda.
_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))
sys.path.insert(0, str(_ROOT / "api"))

from aggregates import (compute_facets, compute_scoped_stats, compute_stats,  # noqa: E402
                        scoped_variant_key, top_companies_with_logos)
from job_filters import register_functions  # noqa: E402

# Overridable so a second applier (the box, running beside the Lambda
# during the migration) publishes under its own prefix and the two
# never overwrite each other's answers. handler.py reads the same
# variable, so an API and the applier feeding it agree by env, not by
# convention.
PREFIX = os.environ.get("PRECOMPUTED_PREFIX", "precomputed/")

# How stale these are allowed to get before a run recomputes them.
#
# This is the whole cost control. Measured in the applier: building both
# artifacts takes 26.7 seconds, against a snapshot push that finishes in
# under one. Running it on every five-minute apply made it three
# quarters of the applier's entire duration.
#
# Nothing here needs five-minute resolution. The panels show 14-day
# trends, headline counts in the tens of thousands, and facet counts
# used to populate dropdowns. Fifteen minutes is invisible in all three,
# and it turns 288 builds a day into 96.
#
# Thirty, since the box. Measured there on a quiet machine: build()
# takes 114s against the 26.7s this comment was written about, because
# the file is 2.66GB rather than 600MB, there are eight facet variants
# rather than four, and the instance is IO-bound. At fifteen minutes
# that is a 13% duty cycle of the heaviest IO on the box, held inside
# an apply. The argument above still holds at thirty: a dropdown count
# and a 14-day trend do not know the difference, and it halves the
# cost.
MAX_AGE_S = 1800


def record_company_day(db_path: Path) -> bool:
    """One row per company per day: its open roles, and how many of them
    were first seen in the last day. The directory's sparklines and
    "+N this week" read it (api/aggregates.py company_profile).

    Written into the live database by the publish run, which already
    holds the box's lock, once a day: a second call the same day is a
    no-op. One GROUP BY over the open rows, a few seconds on the box.
    True when a day was written.
    """
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS company_daily ("
            "day TEXT NOT NULL, domain TEXT NOT NULL, open_n INTEGER NOT NULL, new_n INTEGER NOT NULL, "
            "PRIMARY KEY (day, domain))")
        now = datetime.now(timezone.utc)
        today = now.date().isoformat()
        from datetime import timedelta
        backfilled = False
        # Before today's own check: a box that wrote today's rows before
        # the backfill existed still has no past, and must get one.
        if not conn.execute("SELECT 1 FROM company_daily WHERE day < ? LIMIT 1", (today,)).fetchone():
            backfilled = True
            # A table with no past in it (first run, or only today's
            # rows) fills in the past twelve weeks, one row a week, from
            # what the jobs table already knows: a role was
            # open on a day if it had been seen by then and not closed
            # by then. Closed rows that archive.py has since moved out
            # make the oldest weeks read a little low; the daily rows
            # from here on are exact.
            for k in range(12, 0, -1):
                day = (now - timedelta(days=7 * k)).date()
                end = f"{day.isoformat()}T23:59:59"
                before = f"{(day - timedelta(days=1)).isoformat()}T23:59:59"
                conn.execute(
                    """
                    INSERT OR REPLACE INTO company_daily (day, domain, open_n, new_n)
                    SELECT ?, company_domain, COUNT(*), SUM(CASE WHEN first_seen > ? THEN 1 ELSE 0 END)
                    FROM jobs
                    WHERE first_seen <= ? AND (closed_at IS NULL OR closed_at > ?)
                      AND company_domain IS NOT NULL AND company_domain != ''
                    GROUP BY company_domain
                    """,
                    (day.isoformat(), before, end, end))
        if conn.execute("SELECT 1 FROM company_daily WHERE day = ? LIMIT 1", (today,)).fetchone():
            conn.commit()
            return backfilled
        day_ago = (now - timedelta(days=1)).isoformat()
        conn.execute(
            """
            INSERT OR REPLACE INTO company_daily (day, domain, open_n, new_n)
            SELECT ?, company_domain, COUNT(*), SUM(CASE WHEN first_seen >= ? THEN 1 ELSE 0 END)
            FROM jobs
            WHERE closed_at IS NULL AND company_domain IS NOT NULL AND company_domain != ''
            GROUP BY company_domain
            """,
            (today, day_ago))
        conn.commit()
        return True
    finally:
        conn.close()


def build(db_path: Path) -> dict[str, dict]:
    """{filename: payload} for everything worth precomputing."""
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    register_functions(conn)
    try:
        stats = compute_stats(conn, {})
        # The one field israel_only changes. Computed from the same
        # connection rather than a second pass over the whole route.
        stats["top_locations_israel"] = compute_stats(
            conn, {"israel_only": "1"})["top_locations"]
        # For the landing page's row of logos. Only here, not in compute_stats: the page
        # reads the static file, and the live /api/stats has no use for it.
        stats["top_companies_logos"] = top_companies_with_logos(conn)
        # Keyed by confidence, because that is the one filter the page
        # always sends and never leaves empty. The board defaults to
        # "all" (verified plus best-effort, shown with a badge), while
        # the API defaults to verified only. Precomputing just one of
        # those meant the artifact existed and the page never used it:
        # /facets?x=1 answered in 0.34s while the request the browser
        # actually makes still took 7.18s.
        facets = {c: compute_facets(conn, {"confidence": c}) for c in ("verified", "all")}
        # The tech view (roles=tech, the board's default since
        # 2026-09-21) is a second variant of each, and a scoped stats
        # block of its own, so the plain page load never computes live.
        for c in ("verified", "all"):
            facets[f"{c}:tech"] = compute_facets(conn, {"confidence": c, "roles": "tech"})
            # The Israeli board, which is the product's first audience
            # and the one view a place filter cannot be precomputed
            # away from: its location tree drops the country filter and
            # so costs a pass over every open row, 10 seconds measured
            # on 723k of them, on every facets call from every Israeli
            # visitor. route_facets serves these when country=IL is the
            # only thing narrowing the board.
            facets[f"{c}:IL"] = compute_facets(conn, {"confidence": c, "country": "IL"})
            facets[f"{c}:tech:IL"] = compute_facets(conn, {"confidence": c, "roles": "tech", "country": "IL"})
        stats["scoped_tech"] = compute_scoped_stats(conn, {"confidence": "all", "roles": "tech"})
        # The board's common first clicks, so they answer from the artifact
        # instead of scanning the table live: measured 2026-09-27, a cold
        # scoped block took 57 to 64 seconds on the box (4.5GB database,
        # 3.8GB of memory), 4s once warm. The ten biggest countries and
        # eight biggest categories, each with and without roles=tech.
        variants = {}
        countries = [r[0] for r in conn.execute(
            "SELECT country, COUNT(*) n FROM jobs WHERE closed_at IS NULL AND country IS NOT NULL "
            "AND length(country) = 2 GROUP BY country ORDER BY n DESC LIMIT 10")]
        # Israel always: the board's first audience, and not in the top ten
        # by volume, so without this its first click was the slow one.
        if "IL" not in countries:
            countries.append("IL")
        categories = [r["value"] for r in (facets.get("all:tech") or {}).get("categories", [])[:8]]
        # "All roles" is no roles parameter at all, the way the board asks.
        for roles in ("tech", None):
            for key, values in (("country", countries), ("department", categories)):
                for v in values:
                    p = {"confidence": "all", key: v, **({"roles": roles} if roles else {})}
                    variants[scoped_variant_key(p)] = compute_scoped_stats(conn, p)
        stats["scoped_variants"] = variants
    finally:
        conn.close()
    return {"stats.json": stats, "facets.json": facets}


def _fresh_enough(s3, bucket: str) -> bool:
    """Whether the existing artifacts are recent enough to leave alone.

    One HEAD against the object we would overwrite. Missing or
    unreadable means build it, which is the right answer for a first run
    and for anything that has gone wrong.
    """
    # precomputed/force asks for a rebuild on the next run whatever the
    # age. That, not deleting stats.json, is how to force one: deleting
    # the live artifact left /api/stats computing everything on every
    # request when the next run was skipped for the lock (2026-09-27,
    # 125s per request until the rebuild landed). publish() removes the
    # marker once the new artifacts are written.
    try:
        s3.head_object(Bucket=bucket, Key=f"{PREFIX}force")
        print("precomputed/force is set, rebuilding", file=sys.stderr)
        return False
    except Exception:
        pass
    try:
        head = s3.head_object(Bucket=bucket, Key=f"{PREFIX}stats.json")
    except Exception:
        return False
    age = (datetime.now(timezone.utc) - head["LastModified"]).total_seconds()
    if age < MAX_AGE_S:
        print(f"precomputed artifacts are {age:.0f}s old, leaving them", file=sys.stderr)
        return True
    return False


def publish(bucket: str, db_path: Path, frontend_bucket: str = "") -> list[str]:
    """Write them to S3. Returns the keys written, [] on any failure.

    Two destinations, for two different readers.

    The data bucket copy is what /api/stats and /api/facets serve, so
    anyone calling the API keeps getting the same answer from the same
    place. The frontend bucket copy is fetched straight from CloudFront
    by the browser, which is where the saving is: the page polls these
    every two minutes per open tab, and every one of those was invoking
    a Lambda to hand back bytes that were already sitting in S3.

    Same trick bootstrap.json has used all along, and the same posture:
    best effort, because a merge that has already pushed a snapshot must
    not fail over a dashboard.
    """
    if not bucket:
        return []

    # Everything from here is inside the guard, client construction
    # included. This is called from a merge that has already pushed a
    # snapshot, and nothing about a dashboard is worth failing that over.
    try:
        import boto3

        s3 = boto3.client("s3")
        if _fresh_enough(s3, bucket):
            return []
        payloads = build(db_path)
    except Exception as e:
        print(f"precompute failed, API will keep computing live: {e!r}", file=sys.stderr)
        return []

    written = []
    for name, payload in payloads.items():
        body = json.dumps(payload, default=str, ensure_ascii=False).encode("utf-8")
        for target, key in ((bucket, f"{PREFIX}{name}"),
                            (frontend_bucket, name) if frontend_bucket else (None, None)):
            if not target:
                continue
            try:
                # 60s max-age: the browser holds it for less than half a
                # write cycle, so a reload inside that window costs no
                # network at all and still cannot show a stale figure for
                # longer than the data takes to change.
                s3.put_object(
                    Bucket=target, Key=key, Body=body,
                    ContentType="application/json",
                    CacheControl="public, max-age=60",
                )
                written.append(f"{target}/{key}")
            except Exception as e:
                print(f"couldn't write {key} to {target} (non-fatal): {e!r}", file=sys.stderr)
    if written:
        try:
            s3.delete_object(Bucket=bucket, Key=f"{PREFIX}force")
        except Exception:
            pass  # no marker, or no delete right: the age rule takes over again
    return written


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--db", type=Path, required=True)
    ap.add_argument("--bucket")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--out", type=Path, help="write the files to this directory instead of the bucket "
                                              "(scripts/dev_server.py reads loader/precomputed)")
    args = ap.parse_args()

    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)
        for name, payload in build(args.db).items():
            (args.out / name).write_text(json.dumps(payload, default=str, ensure_ascii=False), encoding="utf-8")
            print(f"wrote {args.out / name}")
    elif args.dry_run or not args.bucket:
        for name, payload in build(args.db).items():
            body = json.dumps(payload, default=str, ensure_ascii=False)
            print(f"{name}: {len(body):,} bytes, {len(payload)} top-level keys")
    else:
        print("\n".join(publish(args.bucket, args.db)) or "nothing written")
