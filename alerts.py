"""Alert evaluation: matches each active alert's filter against jobs
first-seen since its own watermark, sends one digest email per alert
with any new matches, advances the watermark. Called once per fast-poll
cycle (scrape_handler.py, right after the loader step, while jobs.db is
already fresh on /tmp -- no separate download needed here).

The owner's profile says how often: instant is every pass, daily and
weekly hold the watermark until the digest is due, at the owner's own
time of day in their own zone, so the matches pile up behind it and go
out as one email (digest_due below).

Uses job_filters.build_jobs_where() for the actual matching, the same
function /api/jobs itself uses (api/handler.py) -- an alert matches
exactly what its owner would see applying those filters on the live
board, not a second, independently-drifting approximation of it.
"""

import html
import os
import re
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote, urlencode

import boto3
from boto3.dynamodb.conditions import Attr
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from countries import label_for
from job_filters import (attach_fts, build_jobs_where, has_fts_index, has_places, register_functions,
                         salary_source_select)
import unsubscribe_token as _unsub
from profile import DIGEST_DAY, DIGEST_TIME, DIGEST_TZ, PROFILE_ID

ALERTS_TABLE = os.environ.get("ALERTS_TABLE")
FROM_EMAIL = os.environ.get("ALERTS_FROM_EMAIL", "alerts@oceanofjobs.com")
SITE_ORIGIN = os.environ.get("SITE_ORIGIN", "https://oceanofjobs.com")

_dynamodb = boto3.resource("dynamodb")
_ses = boto3.client("sesv2")


def evaluate_alerts(jobs_db_path: Path) -> dict:
    if not ALERTS_TABLE:
        # Not every environment running scrape_handler.py needs this
        # (local testing, a future non-alerts deployment) -- absence
        # means "don't evaluate," not an error.
        return {"skipped": "ALERTS_TABLE not set"}

    table = _dynamodb.Table(ALERTS_TABLE)
    alerts = _scan_active_alerts(table)

    # Read-only, and the loader step just finished writing this same
    # file moments ago in the same invocation -- no reason to hold a
    # write lock or risk racing it.
    conn = sqlite3.connect(f"file:{jobs_db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    register_functions(conn)
    # The search index in its own file, as api/db.py attaches it, or
    # keyword alerts quietly fall back to matching titles only.
    try:
        attach_fts(conn, jobs_db_path)
    except sqlite3.Error as e:
        print(f"alerts: couldn't attach the search index: {e!r}")

    profiles = _profiles(table, {a["user_id"] for a in alerts})
    now = datetime.now(timezone.utc)
    sent = 0
    held = 0
    errors = []
    for alert in alerts:
        try:
            prof = profiles.get(alert["user_id"]) or {}
            cadence = prof.get("cadence") or "instant"
            matches = [m for m in _find_new_matches(conn, alert) if is_fresh(m, now)]
            # Before the first digest, the alert's own creation is the
            # last moment, so a daily alert made at ten waits for
            # tomorrow's nine rather than sending in the first pass.
            if matches and not digest_due(cadence, alert.get("last_digest_at") or alert.get("created_at"), now,
                                          at=prof.get("digest_time"), tz=prof.get("digest_tz"),
                                          day=prof.get("digest_day")):
                # The watermark stays where it is, so these are in the
                # digest when it is due, with whatever arrives meanwhile.
                held += 1
                continue
            update = "SET last_notified_at = :t"
            if matches:
                try:
                    _send_digest(alert, matches)
                    sent += 1
                except _ses.exceptions.MessageRejected as e:
                    # SES refuses this address on every pass (the sandbox
                    # takes verified ones only), so the digest is dropped and
                    # the watermark moves, or it is retried forever.
                    errors.append(f"{alert['user_id']}/{alert['alert_id']}: {e}")
                update += ", last_digest_at = :t"
            table.update_item(
                Key={"user_id": alert["user_id"], "alert_id": alert["alert_id"]},
                UpdateExpression=update,
                ExpressionAttributeValues={":t": now.isoformat()},
            )
        except Exception as e:
            # One user's bad filter or bounced address shouldn't stop
            # every other alert from being checked.
            errors.append(f"{alert['user_id']}/{alert['alert_id']}: {e}")

    watched = _watched_domains(alerts) | _recently_matching_domains(conn, alerts)
    conn.close()
    return {"alerts_checked": len(alerts), "digests_sent": sent, "digests_held": held, "errors": errors,
            "watched_domains": sorted(watched)}


def digest_due(cadence: str, since, now: datetime, at=None, tz=None, day=None) -> bool:
    """Whether an alert with matches waiting should send now.

    Instant always. Daily and weekly: find the most recent scheduled
    moment at or before now, in the owner's zone (today at `at`, or the
    last `day` at `at`), and send if nothing has gone out since it.
    `since` is the last digest, or the alert's creation before there
    was one. The evaluator runs every half minute, so this fires on the
    first pass after the moment and then not again until the next one.
    A zone or a time the profile could not have stored still falls back
    to the defaults rather than to never.
    """
    if cadence not in ("daily", "weekly"):
        return True
    try:
        zone = ZoneInfo(tz or DIGEST_TZ)
    except (ZoneInfoNotFoundError, ValueError, OSError):
        zone = ZoneInfo(DIGEST_TZ)
    try:
        hh, mm = (int(x) for x in str(at or DIGEST_TIME).split(":", 1))
    except ValueError:
        hh, mm = (int(x) for x in DIGEST_TIME.split(":"))
    try:
        weekday = int(day if day is not None else DIGEST_DAY) % 7
    except (TypeError, ValueError):
        weekday = DIGEST_DAY
    local = now.astimezone(zone)
    scheduled = local.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if cadence == "weekly":
        scheduled -= timedelta(days=(local.weekday() - weekday) % 7)
    if scheduled > local:
        scheduled -= timedelta(days=7 if cadence == "weekly" else 1)
    last = _parse(since)
    return last is None or last < scheduled


def _profiles(table, user_ids) -> dict[str, dict]:
    """The profile row of each owner, for its cadence. One get per
    owner rather than a scan: the active-alert scan cannot see profile
    rows (they carry no `active`), and owners are few."""
    out = {}
    for uid in user_ids:
        try:
            item = table.get_item(Key={"user_id": uid, "alert_id": PROFILE_ID}).get("Item")
        except Exception:  # noqa: BLE001 -- a missing profile is instant, the default
            item = None
        if item:
            out[uid] = item
    return out


# How far back a match counts as evidence that a board is worth watching.
#
# A board that answered somebody's alert in the last two weeks is a board
# that plausibly answers it again. Shorter and a company that posts
# monthly falls out of the fast lane between postings, which is the exact
# case this exists for.
WATCH_LOOKBACK_DAYS = 14

# Per alert, not in total. A country-wide alert matches tens of thousands
# of rows and there is no point reading them all: the fast lane is meant
# to cover the boards a reader actually hears from, and past a couple of
# hundred companies it stops being a lane and becomes the whole road.
WATCH_DOMAINS_PER_ALERT = 200


def _recently_matching_domains(conn: sqlite3.Connection, alerts: list[dict]) -> set[str]:
    """Boards that have answered somebody's alert lately.

    Reported live on 2026-09-21: a ScaleOps posting reached its reader 72
    minutes late, because ScaleOps posts rarely and had backed off to the
    four-hour ceiling. Naming the company in the alert would have fixed
    it, except that nobody does. Every active alert on the board that day
    filtered by keyword or by country, so an alert-follows-a-company rule
    covered none of them.

    This is the version that covers them. An alert for "DevOps in Israel"
    does not name a board, but the boards that answered it last fortnight
    are the boards it will most likely be answered by next, and those are
    worth polling often. Costs one bounded query per alert against a
    snapshot that is already open.
    """
    out: set[str] = set()
    since = (datetime.now(timezone.utc) - timedelta(days=WATCH_LOOKBACK_DAYS)).isoformat()
    for alert in alerts:
        try:
            where_sql, args = build_jobs_where(dict(alert.get("filter") or {}),
                                               has_fts_index(conn), has_places(conn))
            rows = conn.execute(
                f"SELECT DISTINCT company_domain FROM jobs WHERE {where_sql} AND first_seen > ? "
                f"LIMIT {WATCH_DOMAINS_PER_ALERT}", [*args, since]).fetchall()
            out.update(str(r[0]).lower() for r in rows if r[0])
        except Exception as e:
            # One unreadable filter must not cost every other alert its
            # fast lane. The worst case here is the old schedule.
            print(f"watch scan failed for {alert.get('alert_id')}: {e!r}")
    return out


def _watched_domains(alerts: list[dict]) -> set[str]:
    """The company domains somebody is actually waiting on.

    A board nobody follows can sit at the four-hour ceiling without
    anyone noticing. A board with an alert on it cannot: the reader is
    waiting for exactly the posting that ceiling delays. The sweep gives
    these a much lower ceiling of their own (see loader/scrape_state.py).

    Only alerts that name a company count. An alert on "python in
    Israel" follows no particular board, and treating it as though it
    followed all ten thousand would empty the idea of meaning.
    """
    out: set[str] = set()
    for alert in alerts:
        raw = (alert.get("filter") or {}).get("company")
        if not raw:
            continue
        # Same ',' convention build_jobs_where reads it with.
        for part in str(raw).split(","):
            part = part.strip().lower()
            if part:
                out.add(part)
    return out


def _scan_active_alerts(table) -> list[dict]:
    # No GSI on active (see infra/dynamodb.tf) -- full scan, filtered
    # client-side, cheap at this project's expected alert volume.
    items = []
    resp = table.scan(FilterExpression=Attr("active").eq(True))
    items.extend(resp.get("Items", []))
    while "LastEvaluatedKey" in resp:
        resp = table.scan(FilterExpression=Attr("active").eq(True), ExclusiveStartKey=resp["LastEvaluatedKey"])
        items.extend(resp.get("Items", []))
    return items


def _find_new_matches(conn: sqlite3.Connection, alert: dict) -> list[dict]:
    filter_params = dict(alert.get("filter") or {})
    where_sql, args = build_jobs_where(filter_params, has_fts_index(conn), has_places(conn))
    # Always present: route_create_alert (api/handler.py) sets this to
    # created_at at creation time specifically so a brand-new alert's
    # first evaluation only picks up genuinely new postings, not every
    # already-open job that happened to match on day one.
    watermark = alert["last_notified_at"]
    where_sql += " AND first_seen > ?"
    args = [*args, watermark]

    # The digest shows more than a title and a domain now: the company's
    # own name, when it closed or opened, level, workplace and pay. Each
    # guarded the way api/handler.py guards them, because this runs
    # against whatever snapshot is on disk and a column can be a merge
    # away from existing.
    try:
        has_name = any(r[1] == "company_name" for r in conn.execute("PRAGMA table_info(companies)"))
    except sqlite3.Error:
        has_name = False
    name_sql = ("(SELECT company_name FROM companies WHERE domain = jobs.company_domain) AS company_name"
                if has_name else "NULL AS company_name")
    try:
        has_logo = any(r[1] == "logo_url" for r in conn.execute("PRAGMA table_info(companies)"))
    except sqlite3.Error:
        has_logo = False
    logo_sql = ("(SELECT logo_url FROM companies WHERE domain = jobs.company_domain) AS logo_url"
                if has_logo else "NULL AS logo_url")
    # The mail says "Tel Aviv, Israel" from the listing's own city and
    # country columns, which a snapshot can predate (has_places).
    place_sql = "country, city" if has_places(conn) else "NULL AS country, NULL AS city"
    rows = conn.execute(
        f"SELECT id, title, company_domain, {name_sql}, {logo_sql}, {place_sql}, location, url, posted_at, first_seen, "
        f"seniority, workplace_type, salary_text, salary_is_estimate, {salary_source_select(conn)} FROM jobs "
        f"WHERE {where_sql} ORDER BY first_seen DESC LIMIT 50",
        args,
    ).fetchall()
    return [dict(r) for r in rows]


def _send_digest(alert: dict, matches: list[dict]) -> None:
    to_email = alert.get("email")
    if not to_email:
        return
    n = len(matches)
    subject = digest_subject(alert, matches)

    _ses.send_email(
        # A named sender. The inbox list shows the name where LinkedIn's
        # shows "LinkedIn Job Alerts", and the subject no longer has to
        # say where the mail came from, which leaves it free to say what
        # is in it.
        FromEmailAddress=FROM_EMAIL if "<" in FROM_EMAIL else f"Ocean of Jobs <{FROM_EMAIL}>",
        Destination={"ToAddresses": [to_email]},
        Content={
            "Simple": {
                "Subject": {"Data": subject},
                # Gmail and Apple Mail put an Unsubscribe control beside
                # the sender when this is present, which is the control
                # people actually reach for. See _mail_headers: one-click
                # (RFC 8058) through /api/alerts/unsubscribe when the
                # signing secret is set, the account page otherwise.
                "Headers": _mail_headers(alert),
                # Both parts of one multipart/alternative message, not two
                # separate sends -- an HTML-capable client (virtually all
                # of them, Gmail included) renders Html and ignores Text
                # entirely. Reported live: without an Html part, Gmail's
                # plain-text autolinker was turning the bare company
                # domain into its own (wrong-destination) link on top of
                # the real job URL printed below it, so every listing
                # showed two separate, differently-colored links. The
                # title is the only link in the Html version, pointed at
                # the real URL, so that duplication can't happen there.
                "Body": {
                    "Html": {"Data": _digest_html(n, matches, alert)},
                    "Text": {"Data": _digest_text(n, matches, alert)},
                },
            }
        },
    )


# Labels the board uses, kept here rather than imported from the
# frontend, which is JavaScript. Short on purpose: a digest row has one
# line for all of them.
_SENIORITY = {"intern": "Intern", "junior": "Junior", "mid": "Mid-level", "senior": "Senior", "staff": "Staff",
              "principal": "Principal", "lead": "Lead", "manager": "Manager", "director": "Director", "exec": "Executive"}
_WORKPLACE = {"remote": "Remote", "hybrid": "Hybrid", "onsite": "On-site"}

# Hebrew and Arabic script. A title in either is laid out right to left
# on its own line; the metadata under it stays left to right, because a
# domain, a salary range and a time are left-to-right things and forcing
# a whole row RTL mangles them.
_RTL_RE = re.compile(r"[\u0590-\u05FF\u0600-\u06FF]")


def _is_rtl(text: str) -> bool:
    return bool(_RTL_RE.search(text or ""))


def _parse(ts):
    if not ts:
        return None
    try:
        d = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _age(job: dict, now: datetime) -> str:
    """"Posted 2h ago", from the source's date or, failing that, when the
    board first saw it. Coarse on purpose: a digest is not a clock."""
    when = _parse(job.get("posted_at")) or _parse(job.get("first_seen"))
    if not when:
        return "Posted recently"
    mins = max(0, int((now - when).total_seconds() // 60))
    if mins < 60:
        return "Posted just now" if mins < 5 else f"Posted {mins}m ago"
    if mins < 60 * 48:
        return f"Posted {mins // 60}h ago"
    return f"Posted {mins // (60 * 24)}d ago"


def _salary(job: dict):
    """(text, is_estimate) or None. The same fallback the board makes for
    a row written before salary_source existed."""
    text = (job.get("salary_text") or "").strip()
    if not text:
        return None
    source = job.get("salary_source") or ("table" if job.get("salary_is_estimate") else "disclosed")
    return text, source != "disclosed"


def _company(job: dict) -> str:
    return (job.get("company_name") or job.get("company_domain") or "").strip()


def board_url(alert: dict) -> str:
    """The board with this alert's own filters applied. The filter keys
    are the board's query parameters (route_create_alert allows only
    those), so this is a straight encoding."""
    params = {k: v for k, v in (alert.get("filter") or {}).items() if v not in (None, "", [], False)}
    return f"{SITE_ORIGIN}/board" + (f"?{urlencode(params, doseq=True)}" if params else "")


def _filter_summary(alert: dict) -> list[str]:
    """Up to three words for the summary block: where, what, how senior.
    Reads the same keys the board's own alert panel describes."""
    f = alert.get("filter") or {}
    out = []
    countries = f.get("country") or ("IL" if f.get("israel_only") else "")
    if countries:
        out.append(", ".join(label_for(c) for c in str(countries).split(",") if c))
    for key in ("city", "department", "search", "q", "keywords", "seniority", "workplace"):
        v = f.get(key)
        if v:
            v = str(v)
            if key == "seniority":
                v = ", ".join(_SENIORITY.get(x, x) for x in v.split(","))
            elif key == "workplace":
                v = ", ".join(_WORKPLACE.get(x, x) for x in v.split(","))
            elif key in ("search", "q", "keywords"):
                v = f"\u201c{v}\u201d"
            out.append(v)
        if len(out) >= 3:
            break
    return out


def _place(job: dict, alert: dict | None = None) -> str:
    """Where, compactly. A listing posted in ten offices at once is one
    line on the board and a wall in a mail. The place shown is the one
    the alert asked about when there is one, else the first, with the
    rest counted: "Tel Aviv, Israel + 9 locations"."""
    raw = (job.get("location") or "").strip()
    if not raw:
        return "Location unknown"
    places = [x.strip() for x in raw.split(";") if x.strip()]
    if len(places) <= 1:
        return raw
    want = ""
    f = (alert or {}).get("filter") or {}
    codes = str(f.get("country") or ("IL" if f.get("israel_only") else "")).split(",")
    labels = [label_for(c).lower() for c in codes if c]
    for pl in places:
        if any(lbl and lbl in pl.lower() for lbl in labels):
            want = pl
            break
    want = want or places[0]
    rest = len(places) - 1
    return f"{want} + {rest} location{'s' if rest != 1 else ''}"


# The mail's palette as literal values, because an email client has no
# CSS variables. Dark, on purpose and throughout: the meta tags in the
# head say so, so a client that inverts light mail leaves this alone.
_PAGE = "#0a0a0b"
_CARD = "#111214"
_CARD_LINE = "#222328"
_HEAD = "#000000"
_TEXT = "#f4f1ee"
_TEXT_2 = "#9a9ca3"
_MUTED = "#8a8c93"
_LINK = "#c9cacf"
_ACCENT = "#2fb36a"
_ON_ACCENT = "#0b1a10"
_TILE = "#1c1d22"
_TILE_LINE = "#2a2b31"
# Geist where it is installed, the system face where it is not. No web
# font: Gmail strips the link and Outlook ignores it.
_FONT = "'Geist',-apple-system,'Segoe UI',Helvetica,Arial,sans-serif"
# Outlook's own renderer takes only its own font list.
_MSO_FONT = "Arial,sans-serif"
LOGO_PNG = f"{SITE_ORIGIN}/img/email-lighthouse.png"

ROWS_SHOWN = 5
# A listing first posted longer ago than this stays out of the mail,
# however recently the board happened to pick it up.
MAX_AGE_DAYS = 30


# Data cleanup, each a small function with a test in
# tests/test_alert_helpers.py.

_SUFFIX_RE = re.compile(r"\s*\(([^()]+)\)\s*$")


def strip_company_suffix(title: str, company: str) -> str:
    """'Staff Data Scientist (Armis)' -> 'Staff Data Scientist', when the
    bracketed word is the company. Any other bracket stays: '(Remote)'
    and '(m/f/d)' are part of the title."""
    title = (title or "").strip()
    m = _SUFFIX_RE.search(title)
    if m and company and m.group(1).strip().casefold() == company.strip().casefold():
        return title[:m.start()].rstrip()
    return title


_SEP_RE = re.compile(r"\s+-\s+")
_SLASH_RE = re.compile(r"(?<=\S)/(?=\S)")


def tidy_title(title: str) -> str:
    """'Staff Security Engineer - Application/Product Security' ->
    'Staff Security Engineer, Application & Product Security'.

    Only the ' - ' separator, with spaces on both sides, is read as a
    break; a hyphen inside a word ('Front-end') is left alone. The slash
    is spelled out only in the part after the break, where it lists
    alternatives, never in the role itself ('UX/UI Designer' stays)."""
    title = (title or "").strip()
    parts = _SEP_RE.split(title)
    if len(parts) == 1:
        return title
    return ", ".join([parts[0], *(_SLASH_RE.sub(" & ", p) for p in parts[1:])])


def clean_title(title: str, company: str) -> str:
    return tidy_title(strip_company_suffix(title, company))


def country_name(code: str) -> str:
    """'il' -> 'Israel'. A code the table does not know comes back as it
    was, upper-cased; a name is passed through."""
    c = (code or "").strip()
    if len(c) in (2, 3) and c.isalpha():
        return label_for(c.upper())
    return c


def _posted(job: dict):
    """When a listing was posted: the source's date, or when the board
    first saw it for a source that gives none."""
    return _parse(job.get("posted_at")) or _parse(job.get("first_seen"))


def is_fresh(job: dict, now: datetime, days: int = MAX_AGE_DAYS) -> bool:
    """Whether a listing belongs in a mail at all: posted within `days`.
    A listing with no date of any kind is let through, since nothing
    says it is old."""
    when = _posted(job)
    return when is None or (now - when) <= timedelta(days=days)


def age_label(job: dict, now: datetime) -> tuple[str, bool]:
    """('Just posted', True) inside 24 hours, else ('15d ago', False)."""
    when = _posted(job)
    if when is None:
        return "Just posted", True
    hours = max(0, (now - when).total_seconds() / 3600)
    if hours < 24:
        return "Just posted", True
    return f"{int(hours // 24)}d ago", False


def hosted_logo(job: dict) -> str | None:
    """The company's logo, served from this site: one already here as it
    is, any other through /logo/{domain}.png (api/handler.py's
    route_company_logo, cached at the edge for a week), which fetches
    it once from where the resolver found it and keeps it. A mail that
    loads images from thirty companies' own servers is a mail that
    leaks who opened it to thirty companies, and half of them 404 or
    block hot-linking anyway. No logo at all is None, and the tile
    shows the company's letter."""
    url = (job.get("logo_url") or "").strip()
    if not url:
        return None
    if url.startswith(SITE_ORIGIN + "/"):
        return url
    domain = (job.get("company_domain") or "").strip().lower()
    return f"{SITE_ORIGIN}/logo/{quote(domain)}.png" if domain else None


def _first_place(job: dict, alert: dict | None) -> tuple[str, str]:
    """(city, country code) for the row: the alert's own country when
    the listing names several, else the first named."""
    codes = [c.strip() for c in (job.get("country") or "").split(",") if c.strip()]
    cities = [c.strip() for c in (job.get("city") or "").split(",") if c.strip()]
    f = (alert or {}).get("filter") or {}
    wanted = {c.strip().upper() for c in str(f.get("country") or ("IL" if f.get("israel_only") else "")).split(",") if c.strip()}
    code = next((c for c in codes if c.upper() in wanted), codes[0] if codes else "")
    return (cities[0] if cities else ""), code


def row_place(job: dict, alert: dict | None = None) -> str:
    """'Tel Aviv, Israel'. From the listing's own city and country columns
    when the snapshot has them, else from its location text with a
    trailing country code spelled out."""
    city, code = _first_place(job, alert)
    if city or code:
        return ", ".join(x for x in (city, country_name(code)) if x)
    text = _place(job, alert)
    head, sep, tail = text.rpartition(", ")
    if sep and len(tail.split(" + ")[0]) in (2, 3) and tail.split(" + ")[0].isalpha():
        tail_code, _, rest = tail.partition(" + ")
        return f"{head}, {country_name(tail_code)}" + (f" + {rest}" if rest else "")
    return text


def since_label(alert: dict | None, now: datetime | None = None) -> str:
    """'Sep 29': the last digest, else when the alert was made."""
    a = alert or {}
    when = _parse(a.get("last_digest_at")) or _parse(a.get("last_notified_at")) or _parse(a.get("created_at"))
    when = when or now or datetime.now(timezone.utc)
    return f"{when:%b} {when.day}"


def job_page_url(job: dict) -> str:
    return f"{SITE_ORIGIN}/job/{job.get('id') or ''}"


# One-click unsubscribe (RFC 8058). The URL carries the alert's key and
# a signature over it, so the route can turn one alert off without a
# session and nobody can forge a URL for someone else's. Without a
# secret in the environment the mail keeps the older header, which
# points at the account page.
unsubscribe_token = _unsub.unsubscribe_token


def unsubscribe_url(alert: dict | None) -> str | None:
    a = alert or {}
    if not _unsub.SECRET or not a.get("user_id") or not a.get("alert_id"):
        return None
    return f"{SITE_ORIGIN}/api/alerts/unsubscribe?" + urlencode(
        {"u": a["user_id"], "a": a["alert_id"], "t": unsubscribe_token(a["user_id"], a["alert_id"])})


def _mail_headers(alert: dict | None) -> list[dict]:
    """List-Unsubscribe, one-click where the secret allows it. Gmail and
    Apple Mail show an Unsubscribe control beside the sender for either;
    with the -Post header Gmail does it in one tap and without one."""
    url = unsubscribe_url(alert)
    if not url:
        return [{"Name": "List-Unsubscribe", "Value": f"<{SITE_ORIGIN}/account>"}]
    return [{"Name": "List-Unsubscribe", "Value": f"<{url}>"},
            {"Name": "List-Unsubscribe-Post", "Value": "List-Unsubscribe=One-Click"}]


def digest_subject(alert: dict | None, matches: list[dict]) -> str:
    """The newest listing, named, the way LinkedIn's alerts do it.

    "DevOps Engineer at Silverfort" for one. Two are both named, since
    "and 1 more" hides half the mail behind a number. Three or more name
    the first and count the rest. The count and the alert's own name,
    which the subject used to carry, moved to the preheader: the inbox
    list shows that right after the subject, so nothing is lost and the
    subject gets to lead with a job rather than with arithmetic.

    Matches arrive newest first (ORDER BY first_seen DESC), so the first
    one is the one that just appeared, which is the one worth the line.
    """
    def named(j):
        company = _company(j)
        return f"{j['title']} at {company}" if company else j["title"]

    n = len(matches)
    if n == 0:
        return f'No new jobs for "{alert_name(alert)}"'
    if n == 1:
        return named(matches[0])
    if n == 2:
        return f"{named(matches[0])} and {named(matches[1])}"
    return f"{named(matches[0])} and {n - 1} more new jobs"


def alert_name(alert: dict | None) -> str:
    """What this alert is called, in the reader's terms. Alerts have no
    name field, so it is the first thing the filter summary says, which
    is the country or city they picked. "your alert" when they picked
    nothing, which reads correctly in the subject line too."""
    parts = _filter_summary(alert or {})
    return parts[0] if parts else "your alert"


def _digest_text(n: int, matches: list[dict], alert: dict | None = None, now: datetime | None = None) -> str:
    now = now or datetime.now(timezone.utc)
    alert = alert or {}
    shown = matches[:ROWS_SHOWN]
    lines = [f'{n} new job{"s" if n != 1 else ""} for "{alert_name(alert)}"',
             f"Since your last alert on {since_label(alert, now)}", ""]
    for j in shown:
        lines.append(clean_title(j["title"], _company(j)))
        lines.append("  " + " · ".join(x for x in (_company(j), row_place(j, alert), age_label(j, now)[0]) if x))
        lines.append("  Apply: " + j["url"])
        lines.append("  " + job_page_url(j))
        lines.append("")
    lines.append(f"See all {n} job{'s' if n != 1 else ''}: {board_url(alert)}")
    lines.append(f"Edit this alert: {SITE_ORIGIN}/account")
    lines.append("")
    lines.append(f'You\'re getting this because you created an alert for "{alert_name(alert)}" on oceanofjobs.com.')
    lines.append(f"Manage alerts or unsubscribe: {SITE_ORIGIN}/account")
    return "\n".join(lines)


def _button(href: str, label: str, *, pad: str, radius: int, width: int, height: int, font_px: int) -> str:
    """A solid accent button that survives Outlook: VML for Word's
    renderer, a padded link for everything else."""
    esc = html.escape
    arc = int(round(radius / height * 200))  # arcsize is a percentage of the half-height
    return (f'<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" '
            f'xmlns:w="urn:schemas-microsoft-com:office:word" href="{esc(href)}" '
            f'style="height:{height}px;v-text-anchor:middle;width:{width}px;" arcsize="{arc}%" '
            f'strokecolor="{_ACCENT}" fillcolor="{_ACCENT}"><w:anchorlock/>'
            f'<center style="color:{_ON_ACCENT};font-family:{_MSO_FONT};font-size:{font_px}px;font-weight:600;">{label}</center>'
            f'</v:roundrect><![endif]-->'
            f'<!--[if !mso]><!--><a href="{esc(href)}" style="display:inline-block; padding:{pad}; '
            f'border-radius:{radius}px; background:{_ACCENT}; color:{_ON_ACCENT}; font-family:{_FONT}; '
            f'font-size:{font_px}px; line-height:1; font-weight:600; text-decoration:none; mso-hide:all;">{label}</a>'
            f'<!--<![endif]-->')


def _logo_cell(job: dict) -> str:
    """A 48px tile: the company's mark when this site serves one, else
    its first letter, so every row lines up either way."""
    esc = html.escape
    tile = (f"width:48px; height:48px; background:{_TILE}; border:1px solid {_TILE_LINE}; border-radius:12px;")
    logo = hosted_logo(job)
    if logo:
        inner = (f'<img src="{esc(logo)}" width="48" height="48" alt="" '
                 f'style="display:block; width:48px; height:48px; border:0; border-radius:12px;" />')
        return f'<td width="48" align="center" valign="middle" style="{tile}">{inner}</td>'
    letter = (_company(job)[:1] or "?").upper()
    return (f'<td width="48" align="center" valign="middle" style="{tile} '
            f'font-family:{_FONT}; font-size:20px; line-height:1; font-weight:600; color:{_LINK};">{esc(letter)}</td>')


def _row_html(j: dict, now: datetime, alert: dict | None = None) -> str:
    """One listing: the tile, the title (a link to its page here) over
    who, where and when, and an Apply button straight to the employer.
    No rules between rows; 4px of dark between them is the separation.
    dir="auto" on the two text lines so a Hebrew title lays itself out
    to the right."""
    esc = html.escape
    company = _company(j)
    title = clean_title(j["title"], company)
    age, new = age_label(j, now)
    age_html = f'<span style="color:{_ACCENT if new else _MUTED};">{esc(age)}</span>'
    meta = " &middot; ".join(x for x in (esc(company), esc(row_place(j, alert)), age_html) if x)
    apply = _button(j["url"], "Apply&nbsp;&#8599;", pad="11px 18px", radius=8, width=92, height=38, font_px=15)
    # The phone gets its own copy of the button, under the words and
    # hidden everywhere else: a table cell cannot move below its row,
    # and the right-hand cell above is hidden by the same media query.
    # No VML in this one, since Outlook's desktop renderer never takes
    # the phone layout.
    esc_url = esc(j["url"])
    apply_mobile = (f'<div class="otj-apply-mob" style="display:none; max-height:0; overflow:hidden; mso-hide:all;">'
                    f'<a href="{esc_url}" style="display:inline-block; padding:11px 18px; border-radius:8px; background:{_ACCENT}; '
                    f'color:{_ON_ACCENT}; font-family:{_FONT}; font-size:15px; line-height:1; font-weight:600; text-decoration:none;">Apply&nbsp;&#8599;</a></div>')
    return f"""
              <tr>
                <td style="padding:0 0 4px 0;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td width="64" valign="middle" style="padding:16px 0 16px 16px; width:64px;">
                        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>{_logo_cell(j)}</tr></table>
                      </td>
                      <td valign="middle" style="padding:16px;">
                        <a href="{esc(job_page_url(j))}" dir="auto" style="display:block; font-family:{_FONT}; font-size:17px; line-height:1.3; font-weight:500; color:{_TEXT}; text-decoration:none;">{esc(title)}</a>
                        <div dir="auto" style="padding-top:4px; font-family:{_FONT}; font-size:14px; line-height:1.4; color:{_TEXT_2};">{meta}</div>
                        {apply_mobile}
                      </td>
                      <td class="otj-apply-desk" width="1" align="right" valign="middle" style="padding:16px 16px 16px 0; white-space:nowrap;">
                        {apply}
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>"""


def _digest_html(n: int, matches: list[dict], alert: dict | None = None, now: datetime | None = None) -> str:
    """The digest: a black header with the count, the rows, the button,
    then the footer under the card.

    Nested presentation tables and inline styles throughout, no flex,
    no positioning, no background images, no SVG, no web font: that is
    the subset Gmail, Outlook and Apple Mail all render the same way.
    600px centred, 40px of page around it, 16px on a phone. The head's
    style block only adds the phone layout and hover; the mail reads
    right without it.
    """
    esc = html.escape
    now = now or datetime.now(timezone.utc)
    alert = alert or {}
    shown = matches[:ROWS_SHOWN]
    rows = "".join(_row_html(j, now, alert) for j in shown)
    name = alert_name(alert)
    since = since_label(alert, now)
    plural = "s" if n != 1 else ""
    title = f'{n} new job{plural} for "{name}"'
    headline = (f'<span style="color:{_ACCENT};">{n}</span> new job{plural} for &ldquo;{esc(name)}&rdquo;')
    # The inbox list shows this after the subject; nothing else does.
    preheader = f'{n} new job{plural} matching "{esc(name)}" since {since}'
    see_all = _button(board_url(alert), f"See all {n} job{plural}", pad="14px 24px", radius=12, width=150, height=46, font_px=15)
    account = f"{SITE_ORIGIN}/account"
    link = f"font-family:{_FONT}; color:{_LINK}; text-decoration:underline;"
    return f"""<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="color-scheme" content="dark" />
  <meta name="supported-color-schemes" content="dark" />
  <title>{esc(title)}</title>
  <!--[if mso]>
  <xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml>
  <style>table, td {{ font-family: {_MSO_FONT}; }}</style>
  <![endif]-->
  <style>
    a:hover {{ color: #ffffff; }}
    @media only screen and (max-width: 480px) {{
      .otj-page {{ padding: 16px !important; }}
      .otj-head {{ font-size: 30px !important; line-height: 1.1 !important; }}
      .otj-apply-desk {{ display: none !important; }}
      .otj-apply-mob {{ display: block !important; max-height: none !important; overflow: visible !important; padding-top: 12px; }}
    }}
  </style>
</head>
<body style="margin:0; padding:0; background:{_PAGE}; -webkit-text-size-adjust:100%;">
  <div style="display:none; font-size:1px; color:{_PAGE}; line-height:1px; max-height:0; max-width:0; opacity:0; overflow:hidden; mso-hide:all;">{preheader}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:{_PAGE};">
    <tr>
      <td align="center" class="otj-page" style="padding:40px 16px;">
        <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px;">

          <tr>
            <td style="background:{_CARD}; border:1px solid {_CARD_LINE}; border-radius:20px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">

                <tr>
                  <td style="background:{_HEAD}; border-bottom:1px solid {_CARD_LINE}; border-radius:20px 20px 0 0; padding:32px 40px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="height:136px;">
                      <tr>
                        <td valign="top" style="height:28px;">
                          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                            <tr>
                              <td width="28" valign="middle" style="width:28px; padding-right:10px;"><img src="{LOGO_PNG}" width="28" height="28" alt="" style="display:block; width:28px; height:28px; border:0;" /></td>
                              <td valign="middle" style="font-family:{_FONT}; font-size:16px; line-height:1; font-weight:600; letter-spacing:-0.01em;"><a href="{SITE_ORIGIN}/" style="color:{_TEXT}; text-decoration:none;">oceanofjobs.com</a></td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                      <tr><td style="height:35px; font-size:0; line-height:0;">&nbsp;</td></tr>
                      <tr>
                        <td valign="bottom">
                          <div class="otj-head" dir="auto" style="font-family:{_FONT}; font-size:40px; line-height:1.05; font-weight:500; letter-spacing:-0.03em; color:{_TEXT};">{headline}</div>
                          <div style="padding-top:10px; font-family:{_FONT}; font-size:15px; line-height:1.4; color:{_LINK};">Since your last alert on {since}</div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td style="padding:16px 24px 0 24px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">{rows}
                    </table>
                  </td>
                </tr>

                <tr>
                  <td style="padding:28px 40px 36px 40px;">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td valign="middle">{see_all}</td>
                        <td valign="middle" style="padding-left:20px; font-family:{_FONT}; font-size:14px; line-height:1;"><a href="{account}" style="{link}">Edit this alert</a></td>
                      </tr>
                    </table>
                  </td>
                </tr>

              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:24px 40px 0 40px; font-family:{_FONT}; font-size:13px; line-height:1.6; color:{_MUTED};">
              You&rsquo;re getting this because you created an alert for &ldquo;{esc(name)}&rdquo; on oceanofjobs.com.<br />
              <span style="display:inline-block; padding-top:6px;"><a href="{account}" style="{link}">Manage alerts</a> &middot; <a href="{account}" style="{link}">Unsubscribe</a> &middot; <a href="{SITE_ORIGIN}/" style="{link}">oceanofjobs.com</a></span>
            </td>
          </tr>

        </table>
        <!--[if mso]></td></tr></table><![endif]-->
      </td>
    </tr>
  </table>
</body>
</html>"""
