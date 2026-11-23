"""Does the Indexing API get new job pages crawled and indexed sooner?

A fixed cohort of new open listings that Google has not crawled yet,
split at random within each hiring system (ATS) into two arms. Treatment
URLs go to the Indexing API once; control URLs do not. Both arms are then
read daily with the URL Inspection API, which reports what Google already
knows about a page without asking it to crawl, so reading the control arm
does not treat it.

Three outcomes, kept apart because crawling and indexing are separate
problems: first crawl (the earliest lastCrawlTime seen after enrolment),
indexed (verdict PASS), and the time from enrolment to each. lastCrawlTime
is the latest crawl, so with daily reads first crawl is known to within a
day. Jobs that close during the run stay in the cohort and the report
counts them, so closures cannot quietly flatter either arm.

    python box/seo_experiment.py enroll --size 400   # once; refuses if a cohort exists
    python box/seo_experiment.py notify              # treatment URLs not yet sent
    python box/seo_experiment.py inspect             # both arms, once a day
    python box/seo_experiment.py report

Keep --size at or under twice the Indexing API's daily quota (200 by
default) so every treatment URL is sent on day 0. Enrolment inspects up
to twice --size candidates and the daily read inspects the whole cohort,
both inside the 2,000 a day URL Inspection allows per property.

Credentials: a service account added as an Owner of the Search Console
property (the Indexing API refuses anything less). GSC_KEY_FILE names its
JSON key, GSC_SITE the property (default sc-domain:oceanofjobs.com).
"""

import argparse
import json
import os
import random
import sqlite3
import statistics
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
for _p in (ROOT, ROOT / "loader", ROOT / "api"):
    sys.path.insert(0, str(_p))

DB = Path(os.environ.get("DATA_PATH", "/var/lib/otj/jobs.db"))
STATE = DB.with_name("seo-experiment.json")
S3_KEY = "seo/experiment.json"
SITE_PROPERTY = os.environ.get("GSC_SITE", "sc-domain:oceanofjobs.com")
SCOPES = "https://www.googleapis.com/auth/indexing https://www.googleapis.com/auth/webmasters.readonly"
PUBLISH = "https://indexing.googleapis.com/v3/urlNotifications:publish"
INSPECT = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect"
REREAD = timedelta(hours=20)  # a daily timer that drifts a little still reads everyone once a day


class Quota(Exception):
    """Google said 429: stop here, the rest waits for the next run."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _ts(d: datetime) -> str:
    return d.isoformat(timespec="seconds")


def _parse(s: str | None) -> datetime | None:
    if not s:
        return None
    d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def eligible(baseline: dict) -> bool:
    """Only pages Google has neither crawled nor indexed, so any crawl the
    run sees happened after enrolment."""
    return not baseline.get("crawled") and baseline.get("verdict") != "PASS"


def assign(candidates: list[dict], seed: int) -> list[dict]:
    """Random arms within each ATS, as even as the stratum allows. The
    stratum's odd member goes to a coin flip rather than always to one arm."""
    rng = random.Random(seed)
    out = []
    by_ats: dict[str, list[dict]] = {}
    for c in candidates:
        by_ats.setdefault(c["ats"] or "unknown", []).append(c)
    for ats in sorted(by_ats):
        group = sorted(by_ats[ats], key=lambda c: c["id"])
        rng.shuffle(group)
        first, second = ("treatment", "control") if rng.random() < 0.5 else ("control", "treatment")
        out += [{**c, "arm": first if i % 2 == 0 else second} for i, c in enumerate(group)]
    return out


def summarize(state: dict) -> dict:
    """Per arm: size, closed, notified, crawled, indexed, and the medians."""
    start = _parse(state["enrolled_at"])
    arms: dict[str, dict] = {}
    for m in state["members"]:
        a = arms.setdefault(m["arm"], {"n": 0, "closed": 0, "notified": 0, "crawled": 0, "indexed": 0,
                                       "crawl_h": [], "index_d": []})
        a["n"] += 1
        a["closed"] += bool(m.get("closed_at"))
        a["notified"] += m.get("notify_status") == 200
        crawls = [c for c in (_parse(o.get("crawled")) for o in m.get("obs", [])) if c and c > start]
        if crawls:
            a["crawled"] += 1
            a["crawl_h"].append((min(crawls) - start).total_seconds() / 3600)
        passed = [_parse(o["at"]) for o in m.get("obs", []) if o.get("verdict") == "PASS"]
        if passed:
            a["indexed"] += 1
            a["index_d"].append((min(passed) - start).total_seconds() / 86400)
    for a in arms.values():
        crawl_h, index_d = a.pop("crawl_h"), a.pop("index_d")
        a["median_crawl_h"] = round(statistics.median(crawl_h), 1) if crawl_h else None
        a["median_index_d"] = round(statistics.median(index_d), 1) if index_d else None
    return arms


def _load() -> dict | None:
    try:
        return json.loads(STATE.read_text())
    except FileNotFoundError:
        return None


def _save(state: dict) -> None:
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=1))
    tmp.replace(STATE)
    bucket = os.environ.get("DATA_BUCKET")
    if bucket:  # the box is one disk and Litestream does not carry this file
        try:
            import boto3

            boto3.client("s3").put_object(Bucket=bucket, Key=S3_KEY, Body=STATE.read_bytes())
        except Exception as e:  # noqa: BLE001 -- the local copy is already written
            print(f"S3 copy failed: {e!r}", file=sys.stderr)


class Google:
    def __init__(self):
        import jwt
        import requests

        key = json.loads(Path(os.environ["GSC_KEY_FILE"]).read_text())
        now = int(time.time())
        assertion = jwt.encode({"iss": key["client_email"], "scope": SCOPES, "aud": key["token_uri"],
                                "iat": now, "exp": now + 3600}, key["private_key"], algorithm="RS256")
        r = requests.post(key["token_uri"], timeout=30, data={
            "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": assertion})
        r.raise_for_status()
        self.s = requests.Session()
        self.s.headers["Authorization"] = "Bearer " + r.json()["access_token"]

    def _post(self, url: str, body: dict):
        r = self.s.post(url, json=body, timeout=30)
        if r.status_code == 429:
            raise Quota(r.text[:200])
        return r

    def inspect(self, url: str) -> dict:
        r = self._post(INSPECT, {"inspectionUrl": url, "siteUrl": SITE_PROPERTY})
        r.raise_for_status()
        s = r.json().get("inspectionResult", {}).get("indexStatusResult", {})
        return {"at": _ts(_now()), "verdict": s.get("verdict"), "coverage": s.get("coverageState"),
                "crawled": s.get("lastCrawlTime"), "canonical": s.get("googleCanonical")}

    def publish(self, url: str) -> int:
        return self._post(PUBLISH, {"url": url, "type": "URL_UPDATED"}).status_code


def _ro():
    return sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=30)


def enroll(size: int, hours: int, seed: int | None) -> int:
    from page_chrome import SITE
    from sitemap import open_clause

    if _load() is not None:
        print(f"a cohort already exists in {STATE}; the cohort is fixed, delete the file to start over")
        return 1
    seed = seed if seed is not None else random.SystemRandom().randrange(2**31)
    since = _ts(_now() - timedelta(hours=hours))
    conn = _ro()
    try:
        rows = conn.execute(f"SELECT id, ats FROM jobs WHERE {open_clause(conn)} AND first_seen >= ?",
                            (since,)).fetchall()
    finally:
        conn.close()
    pool = sorted(rows)
    random.Random(seed).shuffle(pool)
    g = Google()
    kept = []
    for jid, ats in pool[:2 * size]:
        url = f"{SITE}/job/{jid}"
        try:
            base = g.inspect(url)
        except Quota:
            print("inspection quota reached while screening; enrolling what was screened")
            break
        if eligible(base):
            kept.append({"id": jid, "ats": ats, "url": url, "baseline": base})
        if len(kept) >= size:
            break
    members = assign(kept, seed)
    state = {"enrolled_at": _ts(_now()), "seed": seed, "first_seen_since": since,
             "site": SITE_PROPERTY, "screened": min(len(pool), 2 * size), "members": members}
    _save(state)
    print(f"{len(pool)} new open listings, {len(kept)} not yet crawled, enrolled "
          f"{sum(m['arm'] == 'treatment' for m in members)} treatment, "
          f"{sum(m['arm'] == 'control' for m in members)} control (seed {seed})")
    return notify()


def notify() -> int:
    state = _load()
    if state is None:
        print("no cohort yet")
        return 0
    todo = [m for m in state["members"] if m["arm"] == "treatment" and "notified_at" not in m]
    if not todo:
        return 0
    g = Google()
    sent = 0
    try:
        for m in todo:
            m["notify_status"] = g.publish(m["url"])
            m["notified_at"] = _ts(_now())
            sent += 1
    except Quota:
        print("Indexing API quota reached; the rest goes out on the next run")
    _save(state)
    print(f"sent {sent} of {len(todo)} treatment URLs")
    return 0


def inspect() -> int:
    state = _load()
    if state is None:
        print("no cohort yet")
        return 0
    now = _now()
    todo = [m for m in state["members"]
            if not m.get("obs") or now - _parse(m["obs"][-1]["at"]) >= REREAD]
    ids = [m["id"] for m in state["members"]]
    conn = _ro()
    try:
        closed = dict(conn.execute(f"SELECT id, closed_at FROM jobs WHERE id IN ({','.join('?' * len(ids))})",
                                   ids).fetchall()) if ids else {}
    finally:
        conn.close()
    for m in state["members"]:
        m["closed_at"] = closed.get(m["id"]) or m.get("closed_at")
    g = Google() if todo else None
    done = 0
    try:
        for m in todo:
            m.setdefault("obs", []).append(g.inspect(m["url"]))
            done += 1
    except Quota:
        print("inspection quota reached; the rest is read on the next run")
    _save(state)
    print(f"inspected {done} of {len(todo)} due")
    return 0


def report() -> int:
    state = _load()
    if state is None:
        print("no cohort yet")
        return 0
    days = (_now() - _parse(state["enrolled_at"])).total_seconds() / 86400
    print(f"enrolled {state['enrolled_at']} ({days:.1f} days ago), seed {state['seed']}")
    for arm, a in sorted(summarize(state).items()):
        print(f"{arm:9}  n={a['n']}  closed={a['closed']}  notified={a['notified']}  "
              f"crawled={a['crawled']} (median {a['median_crawl_h']}h)  "
              f"indexed={a['indexed']} (median {a['median_index_d']}d)")
    by_ats: dict[str, dict] = {}
    for m in state["members"]:
        by_ats.setdefault(m["ats"] or "unknown", {"members": []})["members"].append(m)
    for ats, part in sorted(by_ats.items()):
        arms = summarize({"enrolled_at": state["enrolled_at"], "members": part["members"]})
        print("  " + ats + ": " + ", ".join(f"{arm} {a['crawled']}/{a['n']} crawled {a['indexed']}/{a['n']} indexed"
                                           for arm, a in sorted(arms.items())))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("enroll")
    e.add_argument("--size", type=int, default=400)
    e.add_argument("--hours", type=int, default=24, help="listings first seen within this many hours")
    e.add_argument("--seed", type=int)
    for name in ("notify", "inspect", "report"):
        sub.add_parser(name)
    args = ap.parse_args()
    if args.cmd == "enroll":
        return enroll(args.size, args.hours, args.seed)
    return {"notify": notify, "inspect": inspect, "report": report}[args.cmd]()


if __name__ == "__main__":
    sys.exit(main())
