"""/stats and /facets, computed on Lambda instead of on the box.

On the box this was the heaviest disk work there was: a 4GB instance
against a 7GB database, each run reading the jobs table about fifty
times, 3.5 hours a run by 2026-10-16 and the applier starved behind it.
Here the same loader/precompute.build runs against a private copy of
jobs.db restored from the Litestream replica the box already streams to
S3. Same region, so the download costs nothing, and the box's disk is
never touched.

Only jobs.db is restored. build() reads jobs, companies and meta and
never the search index, so jobs-fts.db stays in S3.

Modes. "shadow" (the default) writes precomputed-shadow/ and nothing
else, for comparing against what the box publishes. "live" writes
precomputed/ in the data bucket, which the API serves, and the two
copies at the frontend bucket's root, which the browser reads. The
PRECOMPUTE_MODE environment variable sets it; an invocation can override
it with {"mode": ...}, and {"publish": false} measures without writing.

Source version. Every artifact carries the source database's
meta.last_loaded, the moment of the apply its data came from, as
x-amz-meta-source-version. A run whose source is not newer than what is
already published writes nothing, so a delayed or retried run can never
put older data over newer. Reserved concurrency 1 means two runs never
overlap. The two files are separate objects and a reader can fetch one
from before a run and one from after; both are built from one restore,
facets.json is written first and stats.json, the one the guard reads,
last.

A run that fails publishes nothing it has not fully built and checked,
and raises, so the Lambda's Errors metric counts it.
"""

import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "loader"))
sys.path.insert(0, str(HERE))

DATA_BUCKET = os.environ.get("DATA_BUCKET", "")
FRONTEND_BUCKET = os.environ.get("FRONTEND_BUCKET", "")
REPLICA_PATH = os.environ.get("REPLICA_PATH", "litestream/v7/jobs")
REGION = os.environ.get("AWS_REGION", "il-central-1")
LITESTREAM = HERE / "bin" / "litestream"
WORK = Path(os.environ.get("WORK_DIR", "/tmp"))
PREFIXES = {"shadow": "precomputed-shadow/", "live": "precomputed/"}
# The eight facet variants build() makes. A payload missing one is
# incomplete and is not published.
FACET_KEYS = {f"{c}{s}" for c in ("verified", "all") for s in ("", ":tech", ":IL", ":tech:IL")}


def restore(dest: Path) -> None:
    """jobs.db as of the replica's latest position, into dest."""
    for p in (dest, dest.with_name(dest.name + "-wal"), dest.with_name(dest.name + "-shm")):
        p.unlink(missing_ok=True)
    cfg = WORK / "litestream.yml"
    # The path under dbs is only a name for the replica; -o is where the
    # restored file goes.
    cfg.write_text(
        "dbs:\n"
        "  - path: /var/lib/otj/jobs.db\n"
        "    replicas:\n"
        "      - type: s3\n"
        f"        bucket: {DATA_BUCKET}\n"
        f"        path: {REPLICA_PATH}\n"
        f"        region: {REGION}\n",
        encoding="utf-8",
    )
    subprocess.run([str(LITESTREAM), "restore", "-config", str(cfg), "-o", str(dest), "/var/lib/otj/jobs.db"],
                   check=True, capture_output=True, text=True, timeout=600)


def compact(db: Path) -> Path:
    """A vacuumed copy beside db, which is then removed. Returns the copy."""
    small = db.with_name("jobs-compact.db")
    small.unlink(missing_ok=True)
    conn = sqlite3.connect(db)
    try:
        conn.execute("VACUUM INTO ?", (str(small),))
    finally:
        conn.close()
    for p in (db, db.with_name(db.name + "-wal"), db.with_name(db.name + "-shm")):
        p.unlink(missing_ok=True)
    return small


def source_version(db: Path) -> str:
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        row = conn.execute("SELECT value FROM meta WHERE key = 'last_loaded'").fetchone()
    finally:
        conn.close()
    if not row or not row[0]:
        raise RuntimeError("restored database has no meta.last_loaded")
    return row[0]


def check(payloads: dict) -> None:
    """Raise unless both artifacts are complete enough to serve."""
    stats, facets = payloads.get("stats.json") or {}, payloads.get("facets.json") or {}
    if not (stats.get("totals") or {}).get("open_jobs"):
        raise RuntimeError("stats.json has no open job count")
    missing = FACET_KEYS - set(facets)
    if missing:
        raise RuntimeError(f"facets.json is missing {sorted(missing)}")


# The homepage's "Hot job posts" tiles. Senior tech roles from the last
# few days at companies big enough to be known, scored by how much of the
# title is the work people want (AI, research, infrastructure, quant),
# one per company. The page shows six at a time and shuffles through the
# rest itself, so it never asks the box.
HOT_WORDS = re.compile(
    r"\b(ai|ml|llm|genai|agents?|agentic|machine learning|deep learning|research(?:er)?|quant\w*|gpu|cuda"
    r"|inference|computer vision|nlp|robotics|autonomous|compiler|kernel|distributed|infrastructure"
    r"|platform|security|cryptograph\w*|trading|founding|staff|principal)\b", re.I)
DULL_WORDS = re.compile(
    r"\b(intern|internship|student|support|technician|help ?desk|tester|qa|manual|administrator"
    r"|sales|account|consultant|recruit\w*|coordinator|assistant|clerk)\b", re.I)
HOT_LEVELS = {"staff": 3, "principal": 3, "lead": 2, "senior": 2, "manager": 1, "director": 1}
HOT_POOL = 48


def hot_jobs(db: Path, now: datetime | None = None) -> dict:
    since = ((now or datetime.now(timezone.utc)) - timedelta(days=4)).strftime("%Y-%m-%dT%H:%M:%S")
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT j.id, j.title, j.company_domain, co.company_name, co.logo_source, co.domain_verified, co.job_count, j.location,"
            " j.posted_at, j.first_seen, j.seniority, j.workplace_type, j.skills, j.salary_text,"
            " j.salary_is_estimate FROM jobs j JOIN companies co ON co.domain = j.company_domain"
            " WHERE j.closed_at IS NULL AND j.role_class = 'tech' AND co.job_count >= 15"
            " AND (j.posted_at >= ? OR (j.posted_at IS NULL AND j.first_seen >= ?))",
            (since, since),
        ).fetchall()
    finally:
        conn.close()

    def score(r):
        title = r["title"] or ""
        s = 2 * len({m.group(0).lower() for m in HOT_WORDS.finditer(title)})
        s += HOT_LEVELS.get(r["seniority"] or "", 0) + (1 if r["salary_text"] else 0)
        return s + min(r["job_count"] or 0, 400) / 200

    # One per company, counting a company's second domain (aws.amazon.com
    # and amazon.com) as the same one by its shown name, and no title twice.
    picked, seen = [], set()
    for r in sorted((r for r in rows if not DULL_WORDS.search(r["title"] or "")), key=score, reverse=True):
        card = hot_card(r)
        keys = {r["company_domain"], card["company"].lower(), card["title"].lower()}
        if keys & seen:
            continue
        seen |= keys
        picked.append(card)
        if len(picked) == HOT_POOL:
            break
    return {"generated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "jobs": picked}


def hot_card(r) -> dict:
    domain = r["company_domain"]
    name = r["company_name"] or ""
    if not name or name == domain:
        name = domain.split(".")[-2 if domain.count(".") else 0].capitalize()
    badges = []
    salary = r["salary_text"] or ""
    # Estimates outside Israel are monthly figures that read as absurd
    # yearly pay on a card; the shekel table is the market's own unit.
    if salary and (not r["salary_is_estimate"] or salary.startswith("₪")):
        badges.append(salary.replace(" - ", "–") + (" est." if r["salary_is_estimate"] else ""))
    if r["workplace_type"] in ("remote", "hybrid"):
        badges.append(r["workplace_type"].capitalize())
    if r["seniority"] in HOT_LEVELS:
        badges.append(r["seniority"].capitalize())
    # A company's own product is not a skill it offers: "Datadog" on a Datadog job.
    own = name.lower() + " " + domain
    skills = [s.strip() for s in (r["skills"] or "").split(",") if s.strip() and s.strip().lower() not in own]
    if skills:
        badges.append(" · ".join(skills[:2]))
    return {
        "id": r["id"], "title": (r["title"] or "").strip(), "company": name, "domain": domain,
        # Not yet looked up (NULL) is still worth a try: /logo/ answers 404
        # when it has none and the card keeps the initial.
        "logo": r["logo_source"] != "none" and r["domain_verified"] != 0,
        "location": (r["location"] or "").split(";")[0].strip()[:48],
        "posted": r["posted_at"] or r["first_seen"], "badges": badges[:3],
    }


def published_version(s3, bucket: str, key: str) -> str | None:
    """The source version on the object already there. None when there is
    no object, and "" when there is one without a version: the box's,
    which predates this and loses to any versioned run."""
    from botocore.exceptions import ClientError

    try:
        head = s3.head_object(Bucket=bucket, Key=key)
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
            return None
        raise
    return head.get("Metadata", {}).get("source-version", "")


def newer(version: str, published: str | None) -> bool:
    # ISO 8601 UTC at second resolution, all written by one now_iso(),
    # so string order is time order.
    return published is None or version > published


def publish(s3, payloads: dict, version: str, mode: str) -> list[str]:
    prefix = PREFIXES[mode]
    targets = [(DATA_BUCKET, prefix)]
    if mode == "live" and FRONTEND_BUCKET:
        targets.append((FRONTEND_BUCKET, ""))
    written = []
    for bucket, pre in targets:
        for name in ("facets.json", "stats.json"):
            s3.put_object(
                Bucket=bucket, Key=f"{pre}{name}",
                Body=json.dumps(payloads[name], default=str, ensure_ascii=False).encode("utf-8"),
                ContentType="application/json",
                CacheControl="public, max-age=60",
                Metadata={"source-version": version},
            )
            written.append(f"{bucket}/{pre}{name}")
    # The homepage tiles have no box version to compare against, so they
    # go live in shadow mode too.
    if FRONTEND_BUCKET and "hot.json" in payloads:
        s3.put_object(
            Bucket=FRONTEND_BUCKET, Key="hot.json",
            Body=json.dumps(payloads["hot.json"], ensure_ascii=False).encode("utf-8"),
            ContentType="application/json", CacheControl="public, max-age=300",
            Metadata={"source-version": version},
        )
        written.append(f"{FRONTEND_BUCKET}/hot.json")
    if mode == "live":
        s3.delete_object(Bucket=DATA_BUCKET, Key=f"{prefix}force")
    return written


def metric(name: str, value: float, unit: str, mode: str) -> None:
    import boto3

    boto3.client("cloudwatch").put_metric_data(Namespace="OceanOfJobs", MetricData=[{
        "MetricName": name, "Value": value, "Unit": unit,
        "Dimensions": [{"Name": "Mode", "Value": mode}],
    }])


def lambda_handler(event=None, context=None) -> dict:
    import boto3

    import precompute

    event = event or {}
    mode = event.get("mode") or os.environ.get("PRECOMPUTE_MODE", "shadow")
    if mode not in PREFIXES:
        raise ValueError(f"unknown mode {mode!r}")
    db = WORK / "jobs.db"
    out = {"mode": mode}
    started = time.monotonic()
    try:
        t = time.monotonic()
        restore(db)
        out["restore_s"] = round(time.monotonic() - t, 1)
        out["db_mb"] = round(db.stat().st_size / 1048576)
        out["tmp_used_mb"] = round(shutil.disk_usage(WORK).used / 1048576)
        version = out["source_version"] = source_version(db)
        if event.get("compact", os.environ.get("PRECOMPUTE_COMPACT", "1") == "1"):
            # The live file's pages are about half empty (3,344MB restored
            # against 1,463MB vacuumed), and the build reads the table some
            # fifty times. Measured 2026-10-16 at 3008MB: without this the
            # build took 760s and the run 876s of the 900s limit; with it,
            # compaction 56s, build 183s, run 347s.
            t = time.monotonic()
            db = compact(db)
            out["compact_s"] = round(time.monotonic() - t, 1)
            out["compact_mb"] = round(db.stat().st_size / 1048576)

        s3 = boto3.client("s3")
        key = f"{PREFIXES[mode]}stats.json"
        if event.get("publish", True) and not newer(version, published_version(s3, DATA_BUCKET, key)):
            # Nothing new since the last run: the box has not applied.
            # Still a number for the alarm, and one that keeps growing.
            out["skipped"] = "published artifacts are from this source or a newer one"
            lag = (datetime.now(timezone.utc) - datetime.fromisoformat(version)).total_seconds()
            metric("PrecomputeSourceLagSeconds", lag, "Seconds", mode)
            return out

        t = time.monotonic()
        payloads = precompute.build(db)
        out["build_s"] = round(time.monotonic() - t, 1)
        check(payloads)
        payloads["hot.json"] = hot_jobs(db)
        try:
            import resource  # Linux only; the Lambda has it, a Windows test run does not
            out["peak_rss_mb"] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024)
        except ImportError:
            out["peak_rss_mb"] = None

        if event.get("publish", True):
            # Read again just before writing: the build took minutes.
            if not newer(version, published_version(s3, DATA_BUCKET, key)):
                out["skipped"] = "a newer source was published while this one built"
                return out
            out["written"] = publish(s3, payloads, version, mode)
            # How old the data behind the published files is. The
            # freshness alarm reads this; a run that never gets here
            # leaves a gap, which that alarm counts as breaching.
            lag = (datetime.now(timezone.utc) - datetime.fromisoformat(version)).total_seconds()
            out["source_lag_s"] = round(lag)
            metric("PrecomputeSourceLagSeconds", lag, "Seconds", mode)
        out["total_s"] = round(time.monotonic() - started, 1)
        metric("PrecomputeDurationSeconds", out["total_s"], "Seconds", mode)
        return out
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"litestream restore failed: {(e.stderr or '').strip()[-2000:]}") from e
    finally:
        print(json.dumps(out), flush=True)
        for name in ("jobs.db", "jobs.db-wal", "jobs.db-shm", "jobs-compact.db"):
            (WORK / name).unlink(missing_ok=True)
