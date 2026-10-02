"""
Ocean of Jobs API. One Lambda behind CloudFront (/api/* routes here, see
infra/cloudfront.tf).

No framework: a handful of routes over a small SQLite file plus a
DynamoDB table, and an if/elif router is as clear as a micro-framework
without the extra weight.

Job data itself stays read-only, from the batch loader
(loader/load_to_sqlite.py) alone. The write surfaces are all under
/me/: alerts, the profile, and saved jobs. Each is Cognito-authenticated
(see infra/apigateway.tf's JWT authorizer, attached only to those
routes), DynamoDB-backed, and scoped to the caller's own sub claim.
Every other route stays fully public, no auth required, matching this
project's original "no accounts" framing minus the few features that
genuinely needed one -- see PRODUCT.md.
"""

import json
from collections import Counter
import traceback
import math
import os
import re
from pathlib import Path
import time
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, quote

import boto3
from boto3.dynamodb.conditions import Key

from aggregates import (scoped_variant_key, company_directory, company_profile, compute_facets,
                        compute_scoped_stats, compute_stats, has_board_filters, place_rows, search_companies,
                        skill_counts, skills_history)
from db import get_connection, status as db_status
from help_page import HELP_HTML
from openapi import spec as openapi_spec
import company_page
import job_page
from profile import (CADENCE, DASHBOARD_ID, PROFILE_ID, SENIORITY, SKILLS, WORKPLACE, clean_profile,
                     empty_profile)
import dashboard
from saved import is_saved_id, job_id_of, saved_id
from skills import spec as skill_spec
from job_filters import (FRESH_CLAUSE, IL_KEYWORDS, MAX_SEARCH_TERMS, bool_param, category_sql,
                         count_index_hint,
                         build_jobs_where, has_fts_index, has_places, has_role_class,
                         is_job_id, relevance_score_sql, salary_source_select, search_mode,
                         search_terms, skills_score_sql, wanted_city_pairs, wanted_skills)

_alerts_table = boto3.resource("dynamodb").Table(os.environ["ALERTS_TABLE"])

# What build_jobs_where() actually reads -- rejecting anything else at
# creation time catches a typo'd filter key immediately instead of it
# silently matching nothing forever, since the evaluator (alerts.py)
# just feeds this same dict straight into that same function.
_ALLOWED_FILTER_KEYS = {
    "search", "q", "keywords", "ats", "company", "department", "seniority", "location", "country",
    "city", "workplace", "confidence", "israel_only", "include_closed", "include_outdated",
    "min_age_days", "max_age_days", "skills", "ids", "search_mode", "roles",
    "salary_min", "salary_max", "salary_known", "salary_disclosed",
}

# Best matches: how many days since posting cost one matched skill in the
# ranking. See the sort_key == "match" branch in route_jobs.
MATCH_RECENCY_DAYS = 14

# Relevance: how many days since posting cost RELEVANCE_AGE_PENALTY
# points of search score. Five is the weight of one field match
# (department), so a fortnight of age is worth about one field.
RELEVANCE_RECENCY_DAYS = 14
RELEVANCE_AGE_PENALTY = 5

# The link a Greenhouse listing's Apply button opens. Not the stored url,
# which is the absolute_url Greenhouse reports: for most companies that
# is their own careers site with a ?gh_jid= on it, and whether that page
# can find the job is up to the site. Taboola's cannot. Every one of its
# job links, with or without gh_jid, redirects to its generic jobs list.
# Reported live. Greenhouse's own embedded application page answers for
# every board, checked against Taboola, Navan, JFrog, Lightricks and
# Similarweb, and always shows the job.
#
# Built here rather than only in probe.py, so rows stored before the change
# get the working link as well. Falls back to the stored url when the
# company row has no Greenhouse token (a demoted alias).
GREENHOUSE_APPLY_URL_SQL = """CASE
    WHEN jobs.ats = 'greenhouse' AND jobs.external_id IS NOT NULL AND (
        SELECT c.token FROM companies c WHERE c.domain = jobs.company_domain AND c.ats = 'greenhouse'
    ) IS NOT NULL
    THEN 'https://job-boards.greenhouse.io/embed/job_app?for=' || (
        SELECT c.token FROM companies c WHERE c.domain = jobs.company_domain AND c.ats = 'greenhouse'
    ) || '&token=' || jobs.external_id
    ELSE jobs.url END AS url"""


def _apply_url_select(conn) -> str:
    # Same deploy-skew guard as company_name and logo_url: a snapshot or a
    # test database without the companies columns gets the stored url.
    try:
        has_external_id = any(r[1] == "external_id" for r in conn.execute("PRAGMA table_info(jobs)"))
    except Exception:
        has_external_id = False
    if has_external_id and _has_company_column(conn, "token") and _has_company_column(conn, "ats"):
        return GREENHOUSE_APPLY_URL_SQL
    return "url"

# How long CloudFront may serve a cached answer, as distinct from how
# long a browser may. Kept below the interval at which the underlying
# snapshot can change, so a reader never sees an answer older than the
# data could be.
EDGE_CACHE_SECONDS = 180

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
}

SORT_COLUMNS = {
    "age": "posted_at",
    "company": "company_domain",
    "title": "title",
    "location": "location",
    "ats": "ats",
}

# IL_KEYWORDS/FRESH_CLAUSE/BOARD_MAX_AGE_DAYS now live in job_filters.py --
# shared with the alert evaluator, which needs the exact same matching
# logic, not a second copy that quietly drifts from this one.


def route_company_page(domain: str):
    """GET /company/{domain}: the employer's own HTML page (api/company_page.py)."""
    domain = domain.lower().strip("/")
    if not company_page.is_domain(domain):
        return _html_response(404, company_page.render_missing(domain), cache_seconds=60,
                              extra_headers={"X-Robots-Tag": "noindex"})
    conn = get_connection()
    ccols = {r[1] for r in conn.execute("PRAGMA table_info(companies)")}
    pick = ", ".join(c for c in ("domain", "ats", "error", "first_seen", "company_name", "logo_url") if c in ccols)
    # NOCASE: a handful of domains are stored with capitals
    # (ServiceNow.com, 642 open jobs), and the URL is lowercased above,
    # so an exact match 404'd every one of them.
    row = conn.execute(f"SELECT {pick} FROM companies WHERE domain = ? COLLATE NOCASE", (domain,)).fetchone()
    company = dict(row) if row else None
    if company:
        domain = company["domain"]
    status = company_page.status_for(company)
    if status == 404:
        return _html_response(404, company_page.render_missing(domain), cache_seconds=60,
                              extra_headers={"X-Robots-Tag": "noindex"})
    if status == 301:
        target = company_page.redirect_target(company)
        return _html_response(301, company_page.render_redirect(target), cache_seconds=3600,
                              extra_headers={"Location": company_page.canonical_url(target)})
    cols = {r[1] for r in conn.execute("PRAGMA table_info(jobs)")}
    place_select = "country, city" if {"country", "city"} <= cols else "NULL AS country, NULL AS city"
    jobs = [dict(r) for r in conn.execute(
        f"""
        SELECT id, title, location, department, seniority, workplace_type, posted_at, first_seen, {place_select}
        FROM jobs
        WHERE company_domain = ? AND closed_at IS NULL AND {FRESH_CLAUSE}
        ORDER BY posted_at IS NULL, datetime(posted_at) DESC, datetime(first_seen) DESC, id
        LIMIT ?
        """, (domain, company_page.MAX_LISTED + 1)).fetchall()]
    total, since, closed = conn.execute(
        "SELECT COUNT(*), MIN(first_seen), SUM(closed_at IS NOT NULL) FROM jobs WHERE company_domain = ?", (domain,)).fetchone()
    last_open = None
    if not jobs:
        last_open = conn.execute(
            "SELECT MAX(closed_at) FROM jobs WHERE company_domain = ?", (domain,)).fetchone()[0]
    # The last four weeks of arrivals, open or since closed, for the
    # tiles and the chart; one read of the company's rows by index.
    now = datetime.now(timezone.utc)
    recent = [r[0] for r in conn.execute(
        "SELECT first_seen FROM jobs WHERE company_domain = ? AND first_seen >= ?",
        (domain, (now - timedelta(days=35)).isoformat())).fetchall()]
    week_ago, two_weeks = (now - timedelta(days=7)).isoformat(), (now - timedelta(days=14)).isoformat()
    # The most common category among the open rows already fetched: a
    # GROUP BY over the company's rows would read each one from the
    # table (Domino's has 26,000), for a line under the name.
    cats = Counter(j.get("category") for j in jobs if j.get("category"))
    facts = {"total": total or 0, "since": (since or company.get("first_seen") or "")[:10], "last_open": last_open,
             "closed": closed or 0, "new_7d": sum(1 for t in recent if t and t >= week_ago),
             "new_prev_7d": sum(1 for t in recent if t and two_weeks <= t < week_ago),
             "weeks": company_page.week_buckets(recent, now),
             "category": cats.most_common(1)[0][0] if cats else None}
    extra = None if jobs else {"X-Robots-Tag": "noindex"}
    # Same ten minutes at the edge as a listing's page: the page changes
    # as roles open and close, and the sitemap carries the lastmod.
    return _html_response(200, company_page.render(company, jobs, facts), cache_seconds=600, edge_seconds=600,
                          extra_headers=extra)


def route_job_page(job_id: str):
    """GET /job/{id}: the listing as its own HTML page (api/job_page.py).

    Its own query rather than route_job_detail's, because the page shows
    salary and the derived place columns that the JSON route leaves out,
    and because the JSON route's shape is a public surface that should
    not grow to serve a page.
    """
    if not is_job_id(job_id):
        return _html_response(404, job_page.render_missing(404, job_id), cache_seconds=60,
                              extra_headers={"X-Robots-Tag": "noindex"})
    conn = get_connection()
    company_name_select = (
        "(SELECT company_name FROM companies WHERE domain = jobs.company_domain) AS company_name"
        if _has_company_name(conn) else "NULL AS company_name"
    )
    logo_select = (
        "(SELECT logo_url FROM companies WHERE domain = jobs.company_domain) AS logo_url"
        if _has_company_column(conn, "logo_url") else "NULL AS logo_url"
    )
    cols = {r[1] for r in conn.execute("PRAGMA table_info(jobs)")}
    place_select = "country, city" if {"country", "city"} <= cols else "NULL AS country, NULL AS city"
    row = conn.execute(
        f"""
        SELECT id, company_domain, ats, external_id, title, location, department,
               {category_sql(conn)} AS category, seniority, workplace_type,
               {_apply_url_select(conn)}, posted_at, description, first_seen, last_seen, closed_at,
               salary_text, salary_is_estimate, {salary_source_select(conn)}, {place_select},
               {company_name_select}, {logo_select}, {"role_class" if has_role_class(conn) else "NULL AS role_class"}
        FROM jobs WHERE id = ?
        """,
        (job_id,),
    ).fetchone()
    job = dict(row) if row else None
    status = job_page.status_for(job)
    if status != 200:
        return _html_response(status, job_page.render_missing(status, job_id), cache_seconds=60,
                              extra_headers={"X-Robots-Tag": "noindex"})
    blob = _description_from_s3(job_id)
    if blob:
        job["description"] = blob
    extra = {"X-Robots-Tag": "noindex"} if job.get("closed_at") else None
    sidebar = _job_page_sidebar(conn, job) if not job.get("closed_at") else None
    # Ten minutes at the edge: a listing's page changes when it closes,
    # and the sitemap tells crawlers about new ones, so nothing here
    # needs the API's three-minute window.
    return _html_response(200, job_page.render(job, extra=sidebar), cache_seconds=600, edge_seconds=600, extra_headers=extra)


def _job_page_sidebar(conn, job) -> dict:
    """What the listing page shows beside the text: how many roles the
    company has open and three of them, and three roles like this one.

    Every query here is bounded, because a job page is served to
    crawlers at any id, cached or not, while the applier may be writing.
    The company count and its three newest rows are walks of the open
    company index (first_seen is in it; posted_at is not). The similar
    roles come from the newest 300 index entries of the same category
    and role verdict in the last two weeks, then filtered by country and
    company in Python-sized numbers: the unbounded form read every open
    row of the category from the table (134,000 for Software
    Engineering) and sorted them, 0.4s warm and seconds cold."""
    domain = job.get("company_domain") or ""
    pick = "id, title, company_domain, city, location, posted_at, first_seen"
    name_sel = ("(SELECT company_name FROM companies WHERE domain = jobs.company_domain) AS company_name"
                if _has_company_name(conn) else "NULL AS company_name")
    logo_sel = ("(SELECT logo_url FROM companies WHERE domain = jobs.company_domain) AS logo_url"
                if _has_company_column(conn, "logo_url") else "NULL AS logo_url")
    out = {"company_open": 0, "company_jobs": [], "similar": [], "company_category": None}
    try:
        out["company_open"] = conn.execute(
            "SELECT COUNT(*) FROM jobs WHERE company_domain = ? AND closed_at IS NULL", (domain,)).fetchone()[0]
        out["company_jobs"] = [dict(r) for r in conn.execute(
            f"SELECT {pick}, {name_sel}, {logo_sel} FROM jobs WHERE company_domain = ? AND closed_at IS NULL AND id != ? "
            "ORDER BY first_seen DESC LIMIT 3", (domain, job["id"])).fetchall()]
        out["company_category"] = job.get("category")
        category = job.get("category")
        country = (job.get("country") or "").split(",")[0]
        caps = has_fts_index(conn)
        if category and country and caps.category_col and caps.board_indexes:
            since = (datetime.now(timezone.utc) - timedelta(days=14)).isoformat(timespec="seconds")
            out["similar"] = [dict(r) for r in conn.execute(
                f"SELECT {pick}, {name_sel}, {logo_sel} FROM jobs WHERE id IN ("
                "  SELECT id FROM jobs INDEXED BY idx_jobs_open_category WHERE closed_at IS NULL AND category = ? "
                "  AND role_class IS ? AND posted_at >= ? ORDER BY posted_at DESC LIMIT 300) "
                "AND company_domain != ? AND (',' || COALESCE(country, '') || ',') LIKE ? "
                "ORDER BY posted_at DESC LIMIT 3",
                (category, job.get("role_class"), since, domain, f"%,{country},%")).fetchall()]
    except Exception as e:  # noqa: BLE001 - the sidebar is a nicety; the page is not
        print(f"job page sidebar: {e!r}")
    return out


def lambda_handler(event, context):
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    if method == "OPTIONS":
        return _response(204, "")

    path = event.get("rawPath") or "/"
    # The one route this Lambda serves outside /api: a listing's own HTML
    # page. Before the prefix strip, since it has no prefix.
    if path.startswith("/job/") and len(path) > len("/job/"):
        try:
            return route_job_page(path[len("/job/"):].split("?")[0])
        except Exception as e:  # noqa: BLE001 -- a page must answer, not 502
            print(f"job page failed: {e!r}")
            return _html_response(500, job_page.render_missing(404, ""), extra_headers={"X-Robots-Tag": "noindex"})
    if path.startswith("/company/") and len(path) > len("/company/"):
        try:
            return route_company_page(path[len("/company/"):].split("?")[0])
        except Exception as e:  # noqa: BLE001
            print(f"company page failed: {e!r}")
            return _html_response(500, company_page.render_missing(""), extra_headers={"X-Robots-Tag": "noindex"})
    # A company's logo, at its own path rather than under /api/, because
    # Cloudflare rate-limits /api/* per address and a page shows fifty
    # of these. /api/logo/ below still answers, for mail already sent.
    if path.startswith("/logo/") and len(path) > len("/logo/"):
        return route_company_logo(path[len("/logo/"):])
    if path.startswith("/api"):
        path = path[4:] or "/"
    params = _query_params(event)
    if "roles" in params and not has_role_class(get_connection()):
        params.pop("roles")  # a snapshot from before the verdict column: every role, not an error

    try:
        if path == "/help":
            # The one non-JSON route this Lambda serves -- see
            # help_page.py's own docstring for why it lives here instead
            # of as a static frontend page.
            #
            # 300s, down from 3600. The old value came with the reasoning
            # that this content "only changes on a deploy, not with the
            # data underneath it", which was fair while the page changed
            # once in months. It changed three times in one session on
            # 2026-09-16, and every time the edge went on serving the
            # previous copy while the origin was already correct:
            # measured at Age 1140 on a page two versions behind, with
            # max_ttl on the /api/* behavior at 3600 to match. An hour of
            # showing people the wrong documentation is a bad trade for
            # the few Lambda invocations it saves on a page almost nobody
            # loads twice.
            return _html_response(200, HELP_HTML, cache_seconds=300)
        if path == "/openapi.json":
            # The document /help renders, and a fetchable description in
            # its own right: a client generator wants this, not the page.
            # Same 300s as the page, and for the same reason -- both
            # change on a deploy and an hour of serving the previous
            # copy is an hour of documenting an API that has moved.
            return _response(200, json.dumps(openapi_spec()), cache_seconds=300)
        if path == "/jobs":
            return _response(200, json.dumps(route_jobs(params), default=str), cache_seconds=60)
        if path == "/jobs/skill_counts":
            try:
                return _response(200, json.dumps(skill_counts(get_connection(), params)), cache_seconds=600)
            except ValueError as e:
                return _response(400, json.dumps({"error": str(e)}))
        if path == "/jobs/history":
            # Before /jobs/<id>, which would read "history" as an id.
            try:
                return _response(200, json.dumps(skills_history(get_connection(), params)), cache_seconds=600)
            except ValueError as e:
                return _response(400, json.dumps({"error": str(e)}))
        if path.startswith("/jobs/") and len(path) > len("/jobs/"):
            job = route_job_detail(path[len("/jobs/"):])
            if job is None:
                return _response(404, json.dumps({"error": "no job with that id"}))
            return _response(200, json.dumps(job, default=str), cache_seconds=60)
        if path == "/companies/search":
            # Before /companies. Cached at the edge like the facets: the
            # same question from the next visitor gets the same answer.
            return _response(200, json.dumps(search_companies(get_connection(), params), default=str),
                             cache_seconds=60)
        if path == "/companies/directory":
            # The /companies page's list: cached at the edge like the
            # facets, since every visitor's first question is the same.
            return _response(200, json.dumps(company_directory(get_connection(), params), default=str),
                             cache_seconds=300)
        if path == "/companies":
            return _response(200, json.dumps(route_companies(params), default=str), cache_seconds=60)
        if path.startswith("/companies/") and len(path) > len("/companies/"):
            profile = company_profile(get_connection(), path[len("/companies/"):].strip("/").lower())
            if profile is None:
                return _response(404, json.dumps({"error": "no company with that domain"}))
            return _response(200, json.dumps(profile, default=str), cache_seconds=300)
        if path == "/stats":
            return _response(200, json.dumps(route_stats(params), default=str), cache_seconds=60)
        if path == "/facets":
            return _response(200, json.dumps(route_facets(params), default=str), cache_seconds=60)
        if path == "/health":
            return _response(200, json.dumps(route_health(), default=str), cache_seconds=60)
        if path == "/contact":
            if method != "POST":
                return _response(405, json.dumps({"error": "method not allowed"}))
            status, body = route_contact(json.loads(event.get("body") or "{}"))
            return _response(status, json.dumps(body))
        if path.startswith("/logo/") and len(path) > len("/logo/"):
            # A company's logo, served from this domain: what the alert
            # mail's tiles point at (alerts.hosted_logo), since a mail that
            # loads images from thirty companies' own servers is a mail
            # that leaks who opened it, and half of them refuse hot-links.
            return route_company_logo(path[len("/logo/"):])
        if path == "/alerts/unsubscribe":
            # The List-Unsubscribe target in every alert mail (alerts.py's
            # _mail_headers): a POST turns the one alert off, no session
            # needed, on the strength of the signature in the URL. A GET
            # is a person who followed the link: a page with the button.
            q = _query_params(event)
            if method == "POST":
                status, body = route_unsubscribe(q.get("u"), q.get("a"), q.get("t"))
                return _response(status, json.dumps(body))
            if method == "GET":
                return _html_response(200, unsubscribe_page(q.get("u"), q.get("a"), q.get("t")),
                                      extra_headers={"X-Robots-Tag": "noindex"})
            return _response(405, json.dumps({"error": "method not allowed"}))
        if path == "/pipeline-status":
            return _response(200, json.dumps(route_pipeline_status(), default=str))
        if path == "/geo":
            # No cache_seconds, deliberately: the answer is per-viewer,
            # and CloudFront's own /api/geo behavior disables caching
            # for the same reason (infra/cloudfront.tf).
            return _response(200, json.dumps(route_geo(event)))
        if path == "/me/profile":
            claims = _authenticated_claims(event)
            if method == "GET":
                return _response(200, json.dumps(route_get_profile(claims["sub"]), default=str))
            if method == "PUT":
                body = json.loads(event.get("body") or "{}")
                return _response(200, json.dumps(route_put_profile(claims["sub"], body), default=str))
            return _response(405, json.dumps({"error": "method not allowed"}))
        if path == "/me/dashboard":
            claims = _authenticated_claims(event)
            if method != "GET":
                return _response(405, json.dumps({"error": "method not allowed"}))
            return _response(200, json.dumps(route_dashboard(claims["sub"], bool_param(params, "refresh")), default=str))
        if path == "/me/alerts":
            claims = _authenticated_claims(event)
            if method == "GET":
                return _response(200, json.dumps(route_list_alerts(claims["sub"]), default=str))
            if method == "POST":
                body = json.loads(event.get("body") or "{}")
                return _response(201, json.dumps(route_create_alert(claims, body), default=str))
            return _response(405, json.dumps({"error": "method not allowed"}))
        if path == "/me/saved":
            user_id = _authenticated_claims(event)["sub"]
            if method == "GET":
                return _response(200, json.dumps(route_list_saved(user_id), default=str))
            return _response(405, json.dumps({"error": "method not allowed"}))
        if path.startswith("/me/saved/") and len(path) > len("/me/saved/"):
            user_id = _authenticated_claims(event)["sub"]
            job_id = path[len("/me/saved/"):]
            # No unquoting: a job id is hex (see job_filters.is_job_id),
            # so anything percent-encoded is not one and gets a 400 from
            # the validation below rather than being decoded into a row.
            if method == "PUT":
                route_save_job(user_id, job_id)
                return _response(204, "")
            if method == "DELETE":
                route_unsave_job(user_id, job_id)
                return _response(204, "")
            return _response(405, json.dumps({"error": "method not allowed"}))
        if path.startswith("/me/alerts/") and len(path) > len("/me/alerts/"):
            user_id = _authenticated_claims(event)["sub"]
            alert_id = path[len("/me/alerts/"):]
            if method == "PATCH":
                body = json.loads(event.get("body") or "{}")
                updated = route_update_alert(user_id, alert_id, body)
                if updated is None:
                    return _response(404, json.dumps({"error": "no alert with that id"}))
                return _response(200, json.dumps(updated, default=str))
            if method == "DELETE":
                route_delete_alert(user_id, alert_id)
                return _response(204, "")
            return _response(405, json.dumps({"error": "method not allowed"}))
        return _response(404, json.dumps({"error": f"no route for {path}"}))
    except ValueError as e:
        return _response(400, json.dumps({"error": str(e)}))
    except Exception as e:  # last resort: never leak a raw traceback to callers
        traceback.print_exc()  # the log gets it; the caller gets one line
        return _response(500, json.dumps({"error": "internal error", "detail": str(e)}))


def _authenticated_claims(event) -> dict:
    """API Gateway's JWT authorizer (infra/apigateway.tf) already
    validated the token's signature and expiry before this Lambda ever
    ran -- these routes are only reachable at all with a genuine Cognito
    JWT. This just reads the claims it already checked. sub (not
    username) is the stable per-user id used everywhere below: identical
    whether the caller signed in with Google, GitHub, or email, unlike
    username (which for GitHub is "github_<id>", for email is the
    address itself).
    """
    claims = event.get("requestContext", {}).get("authorizer", {}).get("jwt", {}).get("claims", {})
    if not claims.get("sub"):
        raise ValueError("missing authenticated user")
    return claims


def _query_params(event) -> dict:
    # Parse rawQueryString directly rather than trust the event's own
    # flattened queryStringParameters: more predictable for repeated keys.
    raw = event.get("rawQueryString") or ""
    parsed = parse_qs(raw, keep_blank_values=True)
    return {k: v[-1] for k, v in parsed.items()}


def _response(status: int, body: str, cache_seconds: int | None = None):
    # cache_seconds reaches the actual BROWSER's own HTTP cache -- CloudFront
    # already caches these paths for 120s at the edge (infra/cloudfront.tf's
    # own cache policy) regardless of this header, but confirmed live
    # (2026-09-08) that policy never forwarded a Cache-Control to the
    # client, so every page load meant a fresh network round-trip even
    # within CloudFront's own freshness window. 60s (matching db.py's own
    # S3_RECHECK_SECONDS, so the browser's cache window tracks how fresh
    # the underlying data actually could be) turns a revisit inside that
    # window into an instant from-disk response, no network at all.
    # Explicitly opt-in, not a blanket default: /pipeline-status exists
    # specifically to show whether a sync is happening RIGHT NOW, and the
    # /me/* alert routes are per-user and must never be shared/cached.
    #
    # s-maxage is the edge's own window and browsers ignore it, so the two
    # can differ. The comment above was written believing CloudFront
    # cached for 120s whatever this header said; it does not, it honours
    # the origin, so max-age=60 was also pinning the edge at 60 and every
    # minute meant a fresh Lambda invocation per edge per URL. The API was
    # the largest line on the bill at roughly 20,000 GB-seconds a day.
    #
    # 180s costs nothing real: the snapshot behind these answers changes
    # when the applier runs, which after batching is every five to nine
    # minutes, so a three-minute edge window is still well inside how
    # often the data itself can move.
    headers = {"Content-Type": "application/json", **CORS_HEADERS}
    if cache_seconds is not None:
        headers["Cache-Control"] = f"public, max-age={cache_seconds}, s-maxage={EDGE_CACHE_SECONDS}"
    return {
        "statusCode": status,
        "headers": headers,
        "body": body,
    }


def _html_response(status: int, body: str, cache_seconds: int | None = None,
                   edge_seconds: int | None = None, extra_headers: dict | None = None):
    """Same shape as _response, just text/html: /help and the job pages.

    edge_seconds sets s-maxage separately from the browser's max-age,
    the same split _response makes. extra_headers is for X-Robots-Tag on
    the pages that must not be indexed.
    """
    headers = {"Content-Type": "text/html; charset=utf-8", **CORS_HEADERS, **(extra_headers or {})}
    if cache_seconds is not None:
        headers["Cache-Control"] = f"public, max-age={cache_seconds}" + (
            f", s-maxage={edge_seconds}" if edge_seconds is not None else "")
    return {
        "statusCode": status,
        "headers": headers,
        "body": body,
    }


def _int_param(params: dict, name: str, default: int, lo: int, hi: int) -> int:
    raw = params.get(name)
    if raw is None or raw == "":
        return default
    try:
        v = int(raw)
    except ValueError:
        raise ValueError(f"{name} must be an integer")
    return max(lo, min(hi, v))


# /jobs

def _has_company_name(conn) -> bool:
    """Whether the snapshot in hand carries companies.company_name.

    Never assume it does. This Lambda's code and the database it reads
    are deployed on completely separate clocks: code ships in seconds via
    deploy-api.yml, while jobs-read.db only gains a new column when the
    merge next rebuilds it, up to an hour later. Referencing the column
    unconditionally took /api/jobs down with "no such column:
    company_name" for exactly that window, confirmed live. Degrading to
    NULL instead means the board shows domains for one merge cycle rather
    than 500ing, and a rollback of the loader can't break the API either.
    """
    return _has_company_column(conn, "company_name")


def _has_company_column(conn, name: str) -> bool:
    """Generalised from the above, for logo_url, which arrives the same
    way and would take the API down the same way if assumed.
    """
    try:
        return any(r[1] == name for r in conn.execute("PRAGMA table_info(companies)"))
    except Exception:
        return False


def route_jobs(params: dict) -> dict:
    conn = get_connection()
    # A place filter is found once, into a temp table of row ids, and
    # the count and the page both read it (aggregates.place_rows, the
    # same thing the facets do). Without it the page query walked the
    # posted_at index testing two LIKEs on every row until it had fifty
    # hits, and two cities in Argentina took 103 seconds (2026-10-01).
    #
    # Only for a request naming cities, though. For a country alone the
    # page query walks the posted_at index and stops at fifty hits, which
    # for any common country is milliseconds; building the rowset first
    # is a scan of every open row on every call, and it made the US page
    # five seconds idle and twenty under an apply (2026-10-01, the
    # regression of the morning's city fix). A rare country still walks
    # the whole index, as it always did; the side table in the plan is
    # what fixes that.
    # (And place_rows itself stands down once the box's indexes carry
    # city, see aggregates.place_rows.)
    if wanted_city_pairs(params):
        with place_rows(conn, params):
            return _route_jobs(conn, params)
    return _route_jobs(conn, params)


def _route_jobs(conn, params: dict) -> dict:
    company_name_select = (
        "(SELECT company_name FROM companies WHERE domain = jobs.company_domain) AS company_name"
        if _has_company_name(conn) else "NULL AS company_name"
    )
    # Same deploy-skew guard as company_name above: the column only
    # exists once the merge has rebuilt jobs-read.db with it.
    logo_select = (
        "(SELECT logo_url FROM companies WHERE domain = jobs.company_domain) AS logo_url"
        if _has_company_column(conn, "logo_url") else "NULL AS logo_url"
    )

    caps = has_fts_index(conn)
    where_sql, args = build_jobs_where(params, caps, has_places(conn))

    # The CV match. build_jobs_where has already narrowed the list to
    # rows carrying at least one of these; this counts how many, so the
    # board can lead with the closest fit rather than the newest one.
    wanted = wanted_skills(params)
    score_sql, score_args = skills_score_sql(wanted)

    sort_key = params.get("sort", "age")
    # "match" is a real sort key, not a default that applies when nobody
    # asked for one. The board always sends an explicit sort, so a
    # server-side default could never reach it, and ranked results came
    # back in date order with the ranking silently discarded.
    if sort_key == "match" and not wanted:
        sort_key = "age"
    # Same rule for relevance: nothing to rank against without a search,
    # so it reads as the default order rather than erroring a shared link.
    rank_sql, rank_args = relevance_score_sql(params, caps)
    if sort_key == "relevance" and rank_sql == "0":
        sort_key = "age"
    if sort_key not in SORT_COLUMNS and sort_key not in ("match", "relevance"):
        raise ValueError(f"sort must be one of: {', '.join(SORT_COLUMNS)}, match, relevance")
    sort_col = SORT_COLUMNS.get(sort_key, SORT_COLUMNS["age"])
    sort_dir = "DESC" if params.get("dir", "asc").lower() == "desc" else "ASC"
    # age and posted_at run in opposite directions: a lower age means a
    # more recent posted_at, so "age ASC" (default, newest first) needs
    # posted_at DESC. Flip only for this column.
    # "match" shares this: inside a band of equally-good matches the
    # rows are read newest first, same as everywhere else on the board.
    if sort_key in ("age", "match", "relevance"):
        sort_dir = "ASC" if sort_dir == "DESC" else "DESC"
    # NULLS LAST regardless of direction: SQLite treats NULL as smaller
    # than everything else, which would put it first on an ASC sort. The
    # non-age branch needs a genuine no-op constant, not a bare "0":
    # SQLite reads a bare integer literal in ORDER BY as a 1-indexed
    # column-position reference, and "0" is out of range there.
    null_order = "posted_at IS NULL" if sort_key in ("age", "match", "relevance") else "NULL"
    # datetime() belongs to the date column alone. It used to wrap every
    # sort column, and datetime('Senior Backend Engineer') is NULL, so
    # every row tied and the board came back in scan order. Sorting by
    # title silently did nothing on the live site until a test asked it
    # to put three rows in alphabetical order and it refused.
    #
    # datetime() on posted_at is not decoration: the column is TEXT, and
    # rows written before _normalize_date() started forcing UTC (see
    # probe.py) carry other offsets, which a lexicographic sort gets
    # wrong even though each row's own age is right. NOCASE on the text
    # columns so "adobe" and "Adobe" are not two separate alphabets.
    # TRIM because a handful of ATSes serve titles with a leading space,
    # which otherwise sorts them above the letter A.
    sort_expr = (f"datetime({sort_col})" if sort_key in ("age", "match", "relevance")
                 else f"TRIM({sort_col}) COLLATE NOCASE")
    order_sql = f"{null_order}, {sort_expr} {sort_dir}"
    if caps.posted_at_utc and sort_key in ("age", "match", "relevance"):
        # Every posted_at is stored in one canonical UTC form (see
        # fresh_clause), so the bare column sorts correctly and the
        # posted_at index can hand back the page in order. Newest first
        # needs no NULL guard: NULL is the smallest value SQLite knows,
        # so DESC already puts it last. Oldest first keeps the guard,
        # and pays for a sort, which nobody asks for by default.
        order_sql = (f"{sort_col} DESC" if sort_dir == "DESC"
                     else f"{null_order}, {sort_col} ASC")
    order_args: list = []
    # Overlap first, date second. The ten closest fits are the whole
    # point of asking for a match, and any other order scatters them
    # through two thousand rows.
    # Recency counts too. Ranked on overlap alone, the top of an Israeli
    # DevOps match was postings 29 to 42 days old, with a three-day-old
    # role sharing one skill fewer below all of them. Reported live, asking
    # for Best matches to sort by age as well. So every
    # MATCH_RECENCY_DAYS since posting costs one matched skill: a fresh
    # 4-of-7 now ranks above a six-week-old 5-of-7, and a fresh 1-of-7
    # still cannot jump a strong match. Ties go newest first, as before.
    # match_score in the response stays the plain count, which is what the
    # row's "4 of your 7 skills" says.
    if sort_key == "relevance":
        # Score first, then newest inside a band of equally relevant rows.
        #
        # Freshness used to be the tiebreaker and nothing more, on the
        # argument that a good older listing should not lose to a barely
        # matching new one. Measured live on "machine learning engineer":
        # five listings aged 7 to 62 days scored 115 and sat above two
        # posted that morning scoring 110, and the whole gap was a
        # department reading "Machine Learning Engineering" rather than
        # "Machine Learning", worth five points for the word engineer.
        # Exact ties are rare enough at this granularity that the
        # tiebreaker almost never got to act.
        #
        # So age costs points, the way it already costs a matched skill
        # in the match sort above. At these weights a fresh listing
        # overtakes an equal one about two months older, and a title
        # holding the whole phrase (+40) still cannot be jumped by a
        # weaker fresh match for about four months.
        age_steps = (f"CAST(MAX(0, julianday('now') - julianday(COALESCE(posted_at, first_seen)))"
                     f" / {RELEVANCE_RECENCY_DAYS} AS INTEGER)")
        order_sql = f"({rank_sql} - {RELEVANCE_AGE_PENALTY} * {age_steps}) DESC, {order_sql}"
        order_args = list(rank_args)

    if sort_key == "match":
        age_steps = (f"CAST(MAX(0, julianday('now') - julianday(COALESCE(posted_at, first_seen)))"
                     f" / {MATCH_RECENCY_DAYS} AS INTEGER)")
        order_sql = f"({score_sql} - {age_steps}) DESC, {order_sql}"
        order_args = list(score_args)

    # The last word goes to id. Many listings share a posted_at to the
    # second (Workday and Amazon often post a date with no time), and
    # SQLite is free to order tied rows differently from one query to the
    # next, so with LIMIT/OFFSET a listing could land on two pages and
    # another on none. A unique last key makes every page a clean slice of
    # one fixed order. loader/bootstrap.py ends its first page the same way.
    order_sql = f"{order_sql}, id DESC"

    limit = _int_param(params, "limit", default=100, lo=1, hi=500)
    offset = _int_param(params, "offset", default=0, lo=0, hi=10_000_000)

    # The count runs the whole WHERE a second time, and for a search that
    # WHERE is the expensive part: four substring scans over every row.
    # Paying it twice put a typed search at three seconds. The board now
    # asks for the rows without it and asks again for the count while the
    # reader is already reading, so "count=skip" answers with total null
    # and "count=only" answers with nothing but the number.
    #
    # Anything else, including every caller that does not know this
    # parameter, gets both in one response exactly as before.
    count_mode = (params.get("count") or "").strip().lower()
    if count_mode == "skip":
        total = None
    else:
        total = conn.execute(
            f"SELECT COUNT(*) FROM jobs{count_index_hint(params, caps)} WHERE {where_sql}", args
        ).fetchone()[0]
        if count_mode == "only":
            return {"jobs": [], "total": total, "limit": 0, "offset": 0,
                    "matched_skills": [], "count_only": True}

    # The same hint the count takes, for the same reason: with no
    # selective filter and a place, the planner scanned the table and
    # sorted it (All roles in Israel, 33s under an apply, 2026-10-01)
    # rather than walk the open-rows index newest-first and stop at
    # fifty hits. Only on the newest-first orders the index provides;
    # another sort would be a sort either way.
    page_index_hint = count_index_hint(params, caps) if sort_key in ("age",) else ""
    rows = conn.execute(
        f"""
        SELECT id, company_domain, ats, title, location, department,
               {category_sql(conn)} AS category, seniority, workplace_type,
               {_apply_url_select(conn)},
               posted_at, confidence, first_seen, last_seen, closed_at,
               skills, salary_text, salary_is_estimate, {salary_source_select(conn)},
               -- The company's own name as its ATS reports it.
               -- company_domain is often a hostname discovery guessed and
               -- never verified (see resolve_company_names.py), so this is
               -- what belongs anywhere a human reads it. NULL for ATSes
               -- that expose no name (Lever, Workday), and the UI falls
               -- back to the domain.
               --
               -- A scalar subquery rather than a LEFT JOIN, deliberately:
               -- jobs and companies share ats, confidence and first_seen,
               -- and build_jobs_where emits bare unqualified column names
               -- because it is shared with the alert evaluator, which
               -- queries jobs on its own. Joining would make every one of
               -- those filters ambiguous and error the whole route out.
               {company_name_select},
               {logo_select},
               {score_sql} AS match_score
        FROM jobs{page_index_hint}
        WHERE {where_sql}
        -- See sort_expr above for why the date column is wrapped and the
        -- text ones are not.
        ORDER BY {order_sql}
        LIMIT ? OFFSET ?
        """,
        # In the order SQLite binds them: the SELECT's score expression,
        # then WHERE, then the same expression again in ORDER BY.
        [*score_args, *args, *order_args, limit, offset],
    ).fetchall()

    return {
        "jobs": [dict(r) for r in rows],
        "total": total,
        "limit": limit,
        "offset": offset,
        # Echoed back so the board can mark which chips on a row are the
        # ones that put it there, and can say what it is matching on
        # without re-parsing the URL it was handed.
        "matched_skills": wanted,
        # What the search actually asked, so the board can say so rather
        # than leave a reader guessing: the terms used, any past the
        # limit that were not, and whether every term had to appear.
        "search": {
            "terms": search_terms(params.get("search") or ""),
            "ignored": search_terms(params.get("search") or "", limit=None)[MAX_SEARCH_TERMS:],
            "mode": search_mode(params),
        },
    }


# /jobs/{id}: a stable permalink, separate from job.url (which the ATS
# can 404 once a role closes). Always resolves, answering with closed_at
# set if the job has closed, so a saved link never just dead-ends.

def _description_from_s3(job_id: str) -> str | None:
    """The job's description blob, or None for anything unusable.

    Silent on failure on purpose: this is one of two places the text can
    live, and the caller still has the column. A missing blob is the
    normal state for every job written before this shipped.
    """
    bucket = os.environ.get("DATA_BUCKET")
    if not bucket:
        return None
    try:
        body = _status_s3.get_object(Bucket=bucket, Key=f"descriptions/{job_id}.json")["Body"].read()
        return json.loads(body).get("description") or None
    except Exception:
        return None


def route_job_detail(job_id: str) -> dict | None:
    """One listing, including its full description.

    The description is read from its own S3 object first and falls back
    to the column. Descriptions are ~94% of jobs-read.db's 1.2GB, and
    every reader of that file has to fit it in Lambda's 10GB /tmp, so
    they are moving out to make the snapshot small enough to rebuild
    often and cheap enough to pull inside a request. This route's own
    response shape does not change: /api/jobs/{id} is a public surface
    (see PRODUCT.md) and callers should never have to know where the
    text is stored.

    S3 is tried first deliberately, even while the column is still
    populated, so the new path is exercised in production now rather
    than the first time the column goes away.
    """
    conn = get_connection()
    # Same two company columns the list route selects, and guarded the
    # same way. Without logo_url here the detail drawer had nothing to
    # render and fell back to the browser guessing an icon, so the same
    # company could show a resolved logo in one place and a lettered
    # square in the other. Reported live from a screenshot showing
    # exactly that, in reverse: the list had the resolved URL and it was
    # the resolved URL that was failing.
    company_name_select = (
        "(SELECT company_name FROM companies WHERE domain = jobs.company_domain) AS company_name"
        if _has_company_name(conn) else "NULL AS company_name"
    )
    logo_select = (
        "(SELECT logo_url FROM companies WHERE domain = jobs.company_domain) AS logo_url"
        if _has_company_column(conn, "logo_url") else "NULL AS logo_url"
    )
    row = conn.execute(
        f"""
        SELECT id, company_domain, ats, external_id, title, location, department,
               {category_sql(conn)} AS category, seniority,
               workplace_type, {_apply_url_select(conn)},
               posted_at, description, confidence, first_seen, last_seen, closed_at,
               {company_name_select},
               {logo_select}
        FROM jobs WHERE id = ?
        """,
        (job_id,),
    ).fetchone()
    if not row:
        return None
    job = dict(row)
    blob = _description_from_s3(job_id)
    if blob:
        job["description"] = blob
    return job


# /health

_status_s3 = boto3.client("s3")


def _read_status(bucket: str, key: str, stale_minutes: float) -> dict:
    """Shared logic for reading a status.json-shaped file (phase/detail/at,
    written by _write_status in scrape_handler.py, scrape_workday_handler.py,
    or scrape_maintenance_handler.py) and flagging a stuck/orphaned
    non-idle write as stale rather than trusting it forever.
    """
    try:
        obj = _status_s3.get_object(Bucket=bucket, Key=key)
        status = json.loads(obj["Body"].read())
    except Exception:
        # No such file yet (first deploy of this feature), or S3
        # hiccuped -- "unknown" is honest here, not a fabricated phase.
        return {"phase": "unknown", "detail": "", "at": None}

    # A non-idle, non-error phase that's been sitting for a long time is
    # an orphaned write from a crashed/killed run, not one still actually
    # in progress.
    stale = False
    try:
        age_minutes = (datetime.now(timezone.utc) - datetime.fromisoformat(status["at"])).total_seconds() / 60
        stale = status.get("phase") not in ("idle", "error") and age_minutes > stale_minutes
    except (KeyError, ValueError, TypeError):
        pass
    if stale:
        return {**status, "phase": "unknown", "detail": "last status update is stale"}
    return status


def route_pipeline_status() -> dict:
    """What the scrape pipeline is actually doing right now -- both the
    scrape side (scraping/loading/sending alerts/idle/error, status.json,
    written by scrape_handler.py and scrape_workday_handler.py) and the
    merge side (merging/idle/error, merge-status.json, written by
    scrape_maintenance_handler.py) -- not just "when was jobs-read.db
    last updated," which says nothing about whether a run is even in
    progress. Reported live: "syncing..." with a countdown reads as
    "something might be happening" regardless of whether anything
    actually is.

    Two separate keys/staleness thresholds, not one shared file: the
    scrape side runs every 5-10 minutes; the merge side runs hourly.
    Sharing one file would mean the merge's own "merging" phase gets
    overwritten by the very next fast-poll write within seconds -- the
    exact scenario the staleness check below exists to catch for a
    genuinely crashed run, just happening on nearly every real merge
    instead of only on a crash.
    """
    bucket = os.environ.get("DATA_BUCKET")
    if not bucket:
        empty = {"phase": "unknown", "detail": "", "at": None}
        return {"scrape": {**empty, "run": None}, "merge": empty}
    return {
        # Both pipelines finish well under this in practice (the
        # fast-poll in under a minute, discover in ~20).
        "scrape": _read_status(bucket, "status.json", stale_minutes=30),
        # A real merge finishes in well under 2 minutes -- 15 is generous
        # headroom, not a guess at the actual duration.
        "merge": _read_status(bucket, "merge-status.json", stale_minutes=15),
    }


def route_geo(event: dict) -> dict:
    """The viewer's own country, for the frontend to offer a local
    default without imposing one. X-Viewer-Country first: the viewer's
    CF-IPCountry as CloudFront's request function saved it, because the
    box sits behind Cloudflare too and CF-IPCountry arrives here
    re-stamped with the CloudFront edge's country. CF-IPCountry second,
    right whenever nothing sits between Cloudflare and this code.
    CloudFront-Viewer-Country last: while the zone is proxied through
    Cloudflare, CloudFront only ever sees Cloudflare's own IP, so ITS
    header reports whichever Cloudflare PoP took the request, not where
    the person actually is. None of them reaches this code unless
    /api/geo's own cache behavior forwards it -- /api/* strips every
    header (see infra/cloudfront.tf).

    Answers null rather than guessing. An absent or unusable value
    means the frontend shows no prompt at all, which is the right
    failure: a wrong country guess is worse than none, and this is
    only ever a suggestion the visitor can ignore.
    """
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    for key in ("x-viewer-country", "cf-ipcountry", "cloudfront-viewer-country"):
        raw = (headers.get(key) or "").strip().upper()
        # XX is Cloudflare's own "couldn't tell", T1 is Tor. Both are
        # real values it sends, neither is a country.
        if len(raw) == 2 and raw.isalpha() and raw not in ("XX", "T1"):
            return {"country": raw, "source": key}
    return {"country": None, "source": None}


# How many clustering warnings /api/health hands back. See route_health.
HEALTH_WARNING_SAMPLE = 20


def route_health() -> dict:
    """Confirms the DB is actually reachable and reports pipeline
    freshness, not just "the Lambda is running." A 200 with ok=True here
    only means the process started; the real liveness signal is whether
    the query below succeeds and how old last_checked is.
    """
    conn = get_connection()
    # The job counts come from meta when the loader has written them
    # (update_meta, since the box), and are counted here otherwise. The
    # two table scans were the whole cost of this route on a file too
    # big for the page cache.
    meta_counts = dict(conn.execute(
        "SELECT key, value FROM meta WHERE key IN ('jobs_total', 'jobs_open')"
    ).fetchall())
    if "jobs_total" in meta_counts and "jobs_open" in meta_counts:
        counts_sql = f"{int(meta_counts['jobs_total'])} AS jobs_total, {int(meta_counts['jobs_open'])} AS jobs_open,"
    else:
        counts_sql = ("(SELECT COUNT(*) FROM jobs) AS jobs_total, "
                      "(SELECT COUNT(*) FROM jobs WHERE closed_at IS NULL) AS jobs_open,")
    row = conn.execute(
        f"""
        SELECT
          {counts_sql}
          (SELECT COUNT(*) FROM companies WHERE ats IS NOT NULL) AS companies_resolved,
          (SELECT MAX(last_checked) FROM companies) AS last_checked
        """
    ).fetchone()
    minutes_since_check = None
    if row["last_checked"] is not None:
        mins = conn.execute(
            "SELECT (julianday('now') - julianday(?)) * 1440.0 AS mins", (row["last_checked"],)
        ).fetchone()["mins"]
        if mins is not None:
            minutes_since_check = round(mins, 1)
    # Set by load_to_sqlite.py's check_timestamp_clustering (every load,
    # any source) -- the real signature both the gloat.com Comeet bug and
    # the Workday "Posted Today" bug shared: many jobs across DIFFERENT
    # companies stamped with the exact identical posted_at. Empty string
    # (not missing) once any load has run -- "" is a real, checked-and-
    # clean result, not "never checked."
    clustering_row = conn.execute(
        "SELECT value FROM meta WHERE key = 'timestamp_clustering_warnings'"
    ).fetchone()
    all_warnings = clustering_row["value"].split("; ") if clustering_row and clustering_row["value"] else []
    # Capped, hard. This is a liveness ping every open tab polls every
    # two minutes, and the warnings had grown to 8,372 of them, 767KB in
    # one meta row, which this route was returning in full: measured on
    # the box at 784,848 bytes and 24.4 seconds per call. A board with a
    # handful of tabs open was spending the whole machine on it.
    #
    # Twenty is enough to see what is happening and the count says how
    # much more there is. The full list is in the loader's own log,
    # which is where somebody debugging this actually reads it.
    clustering_warnings = all_warnings[:HEALTH_WARNING_SAMPLE]
    return {
        "ok": True,
        "db_reachable": True,
        # This container's own snapshot and background refresh (api/db.py).
        # Each Lambda container has its own, so two calls can differ.
        "snapshot": db_status(),
        "jobs_total": row["jobs_total"],
        "jobs_open": row["jobs_open"],
        "companies_resolved": row["companies_resolved"],
        "last_checked": row["last_checked"],
        "minutes_since_check": minutes_since_check,
        "timestamp_clustering_warnings": clustering_warnings,
        "timestamp_clustering_warning_count": len(all_warnings),
    }


# /companies

def route_companies(params: dict) -> dict:
    conn = get_connection()
    where = ["1=1"]
    args: list = []

    if bool_param(params, "resolved_only"):
        where.append("ats IS NOT NULL")

    if params.get("ats"):
        ats_list = [a.strip() for a in params["ats"].split(",") if a.strip()]
        where.append("ats IN (%s)" % ",".join("?" * len(ats_list)))
        args.extend(ats_list)

    where_sql = " AND ".join(where)
    rows = conn.execute(
        f"""
        SELECT domain, ats, token, confidence, job_count, tried, error, first_seen, last_checked
        FROM companies
        WHERE {where_sql}
        ORDER BY domain ASC
        """,
        args,
    ).fetchall()
    return {"companies": [dict(r) for r in rows], "total": len(rows)}


# /stats

# /contact: the contact page's form, sent on as one email. No account
# needed, so it is throttled by shape rather than identity: a hidden
# field a person never fills, hard length caps, and a message that has
# to say something. The reply address is the sender's, so answering is
# one click; the mail itself comes from the alerts sender, the one
# address SES is verified for.
CONTACT_TO = os.environ.get("CONTACT_TO", "guyvoloshin@gmail.com")
CONTACT_FROM = os.environ.get("ALERTS_FROM_EMAIL", "alerts@guyvoloshin.com")
_EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,255}\.[a-z]{2,}$", re.I)
_ses_client = None


def route_contact(body: dict) -> tuple[int, dict]:
    if body.get("website"):  # the honeypot; a browser never fills it
        return 200, {"ok": True}
    name = str(body.get("name") or "").strip()[:120]
    email = str(body.get("email") or "").strip()[:254]
    message = str(body.get("message") or "").strip()
    if not _EMAIL_RE.match(email):
        return 400, {"error": "a valid email address is needed for a reply"}
    if len(message) < 10:
        return 400, {"error": "the message is too short"}
    if len(message) > 5000:
        return 400, {"error": "the message is too long (5,000 characters at most)"}
    global _ses_client
    if _ses_client is None:
        _ses_client = boto3.client("sesv2")
    text = f"From: {name or '(no name)'} <{email}>\n\n{message}\n"
    try:
        _ses_client.send_email(
            FromEmailAddress=CONTACT_FROM,
            Destination={"ToAddresses": [CONTACT_TO]},
            ReplyToAddresses=[email],
            Content={"Simple": {"Subject": {"Data": f"oceanofjobs.com contact: {name or email}"[:200]},
                                "Body": {"Text": {"Data": text}}}},
        )
    except Exception as e:
        print(f"contact mail failed: {e!r}")
        return 502, {"error": "the message could not be sent right now"}
    return 200, {"ok": True}


# /facets: per-option counts for the board's own filter dropdowns
# (Category, Location, Company), scoped to whatever ELSE is currently
# selected. Reported live: picking "Security" showed 369 (every open
# Security role anywhere), and picking Israel-only on top of it still
# showed 369 in the dropdown even though the board itself dropped to 98
# -- the dropdown counts came from /stats' top_departments/top_locations,
# which are deliberately global (that endpoint's own docstring: "every
# other field stays global," true for the Market Stats dashboard, wrong
# for a filter option's own count). Standard faceted-search convention:
# an option's count answers "how many would I see if I ALSO picked
# this," so it's computed with every OTHER currently active filter
# applied but that option's OWN filter key excluded -- picking Security
# doesn't need to already be selected to see its current count, and
# selecting it shouldn't make its own count self-referential.
# Precomputed aggregates, written by the applier right after it pushes a
# snapshot (loader/precompute.py). Cached per container on the same 60s
# clock db.py uses for the snapshot itself, so a request pays at most one
# S3 read a minute and usually none.
_PRECOMPUTED_TTL = 60.0
# Same variable loader/precompute.py publishes under; see its PREFIX.
PRECOMPUTED_PREFIX = os.environ.get("PRECOMPUTED_PREFIX", "precomputed/")
_precomputed: dict[str, tuple[float, dict | None]] = {}


def _precomputed_json(name: str) -> dict | None:
    """The applier's answer, or None meaning compute it here instead.

    None is not an error. It is the normal state for the window between
    this code deploying and the next merge producing the file, and for
    any run where writing it failed. Code ships in seconds and the
    snapshot only changes when the merge next runs: assuming the new
    thing is already there has taken this API down before, so the live
    path stays reachable rather than becoming dead code.
    """
    now = time.monotonic()
    cached = _precomputed.get(name)
    if cached is not None and now - cached[0] < _PRECOMPUTED_TTL:
        return cached[1]
    bucket = os.environ.get("DATA_BUCKET")
    value = None
    if bucket:
        try:
            body = _status_s3.get_object(Bucket=bucket, Key=f"{PRECOMPUTED_PREFIX}{name}")["Body"].read()
            value = json.loads(body)
        except Exception as e:
            print(f"precomputed/{name} unavailable, computing live: {e!r}")
    _precomputed[name] = (now, value)
    return value


def _live_freshness() -> tuple[dict, dict]:
    """The two clock-shaped fields of a stats response, read now.

    Cheap on purpose: MAX over an indexed column and a six-row table.
    The expensive part of /api/stats is the aggregates, which stay
    precomputed.
    """
    conn = get_connection()
    meta = {row["key"]: row["value"] for row in conn.execute("SELECT key, value FROM meta")}
    last_checked = conn.execute("SELECT MAX(last_checked) AS latest FROM companies").fetchone()["latest"]
    minutes = None
    if last_checked is not None:
        mins = conn.execute(
            "SELECT (julianday('now') - julianday(?)) * 1440.0 AS mins", (last_checked,)
        ).fetchone()["mins"]
        if mins is not None:
            minutes = round(mins, 1)
    return {"last_checked": last_checked, "minutes_since_update": minutes}, meta


def _unfiltered_confidence(params: dict) -> str | None:
    """The confidence variant this request wants, or None if it carries
    any other filter and so has no precomputed answer.

    Compares the generated WHERE rather than listing parameter names, so
    a filter added to build_jobs_where later cannot quietly start being
    served a precomputed answer that ignores it. Confidence is held
    constant on both sides and returned separately, because it is the
    one filter the board always sends: it defaults to "all" where the
    API defaults to "verified", and treating that as "filtered" meant
    the precomputed facets were never once used by the page they were
    built for.

    The comparison itself now lives in aggregates.has_board_filters,
    which /api/stats needs to ask the same question of. This adds the
    variant name on top of it, which is the only part facets needs and
    stats does not.
    """
    if has_board_filters(params):
        return None
    return params.get("confidence") or "verified"


def route_facets(params: dict) -> dict:
    # Facets are filter-dependent by design: each one is counted with
    # every OTHER active filter applied, so only the unfiltered case can
    # be precomputed. That is also the one every page load asks for.
    variant = _unfiltered_confidence(params)
    place = ""
    if variant is None and (params.get("country") or "").strip().upper() == "IL" and not params.get("city"):
        # Israel alone is precomputed too (see precompute.py for why).
        # Asked the same way: is the board unfiltered once the country
        # is set aside? Anything else narrowing it means a live answer.
        rest = {k: v for k, v in params.items() if k != "country"}
        variant = _unfiltered_confidence(rest)
        place = ":IL"
    if variant is not None:
        ready = _precomputed_json("facets.json")
        # The tech view is its own variant ("all:tech"), written beside
        # the plain one since 2026-09-21. A snapshot from before has no
        # such key and falls through to a live count, which is correct
        # and stops being needed one merge after this ships.
        if (params.get("roles") or "").lower() == "tech":
            variant = f"{variant}:tech"
        variant += place
        if isinstance(ready, dict) and variant in ready:
            return ready[variant]
    # Live facets, kept per worker for ten minutes like scoped stats: a
    # Best matches view carries the reader's own skills, so no artifact
    # can hold it, and its first answer costs seconds.
    import time as _t
    ck = "facets?" + "&".join(f"{k}={params[k]}" for k in sorted(params) if params.get(k) not in (None, "", False))
    hit = _scoped_cache.get(ck)
    if hit and hit[0] > _t.monotonic():
        return hit[1]
    # The location tree is counted with country and city set aside, so
    # it is the same for every place under the same other filters. From
    # the artifact when those filters are a precomputed variant (tech
    # roles alone, say), else from this worker's cache, else live once.
    rest = {k: v for k, v in params.items() if k not in ("country", "city")}
    locations = None
    rest_variant = _unfiltered_confidence(rest)
    if rest_variant is not None:
        if (params.get("roles") or "").lower() == "tech":
            rest_variant = f"{rest_variant}:tech"
        ready = _precomputed_json("facets.json")
        if isinstance(ready, dict) and isinstance(ready.get(rest_variant), dict):
            locations = ready[rest_variant].get("locations")
    pk = "places?" + "&".join(f"{k}={rest[k]}" for k in sorted(rest) if rest.get(k) not in (None, "", False))
    if locations is None:
        phit = _scoped_cache.get(pk)
        if phit and phit[0] > _t.monotonic():
            locations = phit[1]
    out = compute_facets(get_connection(), params, locations=locations)
    if len(_scoped_cache) >= _SCOPED_MAX:
        _scoped_cache.clear()
    _scoped_cache[ck] = (_t.monotonic() + _SCOPED_TTL_S, out)
    if pk not in _scoped_cache or _scoped_cache[pk][0] <= _t.monotonic():
        _scoped_cache[pk] = (_t.monotonic() + _SCOPED_TTL_S, out.get("locations"))
    return out


# Scoped blocks computed live, kept per gunicorn worker for ten minutes.
# The numbers move a few times an hour and a cold one costs up to a
# minute of disk (see precompute.py), so a repeat within the window is
# served from memory.
_SCOPED_TTL_S = 600.0
_SCOPED_MAX = 256
_scoped_cache: dict[str, tuple[float, dict]] = {}


def _scoped_stats(params: dict, ready: dict | None) -> dict:
    import time as _t
    key = scoped_variant_key(params)
    if key and ready and key in (ready.get("scoped_variants") or {}):
        return ready["scoped_variants"][key]
    ck = "&".join(f"{k}={params[k]}" for k in sorted(params) if params.get(k) not in (None, "", False))
    hit = _scoped_cache.get(ck)
    if hit and hit[0] > _t.monotonic():
        return hit[1]
    out = compute_scoped_stats(get_connection(), params)
    if len(_scoped_cache) >= _SCOPED_MAX:
        _scoped_cache.clear()
    _scoped_cache[ck] = (_t.monotonic() + _SCOPED_TTL_S, out)
    return out


def route_stats(params: dict | None = None) -> dict:
    params = params or {}
    # A filtered request gets a scoped block on top of the artifact
    # rather than a fresh compute of the whole response. Everything in
    # the artifact is global BY DEFINITION of this contract (the 14-day
    # series, top_departments, by_ats and the rest describe the market,
    # not a result set), so a filtered caller's copy of those fields is
    # byte-identical to the unfiltered one and recomputing them buys
    # nothing. It costs plenty: compute_stats is twenty queries and
    # measured 7.03s live, against 0.30s for a precomputed read, and
    # /api/stats?israel_only=1 is already precomputed on purpose (see
    # top_locations_israel). Falling all the way through the way
    # route_facets does would have made that request twenty times
    # slower to gain nothing, so only the scoped block is live: three
    # queries, added below.
    filtered = has_board_filters(params)
    ready = _precomputed_json("stats.json")
    if ready is not None:
        # israel_only is the only thing that changes this response, and it
        # changes exactly one field, so both versions of that field ship
        # in one object rather than two near-identical files.
        out = {k: v for k, v in ready.items() if k != "top_locations_israel"}
        if bool_param(params, "israel_only"):
            out["top_locations"] = ready.get("top_locations_israel", out.get("top_locations", []))
        if filtered:
            out["scoped"] = _scoped_stats(params, ready)
        elif (params.get("roles") or "").lower() == "tech":
            # The default view: narrowed by roles alone, whose scoped
            # block the merge precomputes as scoped_tech. Missing only
            # on a snapshot from before it existed.
            out["scoped"] = ready.get("scoped_tech") or compute_scoped_stats(get_connection(), params)
        # Two fields in here are clocks, not aggregates, and freezing a
        # clock for fifteen minutes makes it wrong rather than stale.
        # Reported live: the Data Health tile read "19M old" while the
        # pipeline was four minutes behind, because the artifact carried
        # the timestamp from when it was built.
        #
        # Refreshed from the snapshot on every request. This is one
        # indexed MAX and a six-row table read, which is nothing like the
        # aggregates the artifact exists to avoid.
        try:
            out["freshness"], out["meta"] = _live_freshness()
        except Exception as e:
            print(f"couldn't refresh freshness on precomputed stats: {e!r}")
        return out
    # No artifact: compute_stats attaches the same scoped key itself, so
    # both paths answer the same shape. Kept in the same ten-minute cache
    # as the scoped blocks: the full compute is twenty queries, and on
    # 2026-09-27, with the artifact missing, every request ran them and
    # each took 125s while the disk thrashed.
    import time as _t
    ck = "stats-full?" + "&".join(f"{k}={params[k]}" for k in sorted(params) if params.get(k) not in (None, "", False))
    hit = _scoped_cache.get(ck)
    if hit and hit[0] > _t.monotonic():
        return hit[1]
    out = compute_stats(get_connection(), params)
    if len(_scoped_cache) >= _SCOPED_MAX:
        _scoped_cache.clear()
    _scoped_cache[ck] = (_t.monotonic() + _SCOPED_TTL_S, out)
    return out


# /me/alerts: the one write surface on this whole API. Cognito-JWT-gated
# at the API Gateway layer (infra/apigateway.tf), not just in application
# code -- an unauthenticated request never reaches this Lambda for these
# routes at all. Backed by DynamoDB, not jobs.db: a per-user, low-volume,
# write-heavy table has nothing in common with the read-only, batch-
# loaded job data, and putting it in the same SQLite file would mean
# every fast-poll re-upload of jobs.db could race a user's own write.
#
# alert item shape: {user_id (Cognito sub), alert_id (uuid4), filter (the
# same query-param dict /api/jobs accepts), created_at, active,
# last_notified_at}. alerts.py (the evaluator, running in the scrape-fast
# Lambda after each fast-poll) reads this same table and feeds `filter`
# straight into job_filters.build_jobs_where -- an alert matches exactly
# what its owner would see applying those same filters on the live board,
# not a second approximation of it.

_LOGO_DOMAIN_RE = re.compile(r"^[a-z0-9][a-z0-9.-]{1,78}[a-z0-9]$")
_LOGO_CACHE_DIR = Path(os.environ.get("LOGO_CACHE_DIR", "/var/lib/otj/logo-cache"))
_LOGO_MAX_BYTES = 2 * 1024 * 1024
_LOGO_TTL_S = 7 * 24 * 3600
_LOGO_MISS_TTL_S = 24 * 3600
_LOGO_MISS = "miss:2"  # bumped when the route learns a new place to look


def _real_icon(got: tuple[str, bytes] | None) -> tuple[str, bytes] | None:
    """A fetched image, unless it is Google's 16x16 "nothing found"
    placeholder: a PNG's IHDR carries its size at bytes 16 to 24."""
    if not got:
        return None
    ct, body = got
    if body[:8] == b"\x89PNG\r\n\x1a\n" and len(body) >= 24:
        w = int.from_bytes(body[16:20], "big")
        h = int.from_bytes(body[20:24], "big")
        if w == 16 and h == 16:
            return None
    return got


def _fetch_logo(url: str) -> tuple[str, bytes] | None:
    """The image behind a resolved logo URL, or None. Only an image, only
    up to 2MB, and only from the URL the resolver stored, never from a
    caller's own."""
    import requests

    try:
        r = requests.get(url, timeout=8, stream=True,
                         headers={"User-Agent": "Mozilla/5.0 (compatible; oceanofjobs.com logo cache)"})
        ct = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if r.status_code != 200 or not ct.startswith("image/"):
            return None
        body = r.raw.read(_LOGO_MAX_BYTES + 1, decode_content=True)
        if not body or len(body) > _LOGO_MAX_BYTES:
            return None
        return ct, body
    except Exception:  # noqa: BLE001
        return None


def route_company_logo(domain: str, conn=None, fetch=None, cache_dir: Path | None = None) -> dict:
    """GET /api/logo/{domain}: the company's resolved logo, fetched once
    from where the resolver found it and kept on disk for a week; a
    miss is kept for a day so a dead URL is not asked again on every
    open. The domain has to be a company on the board, and the image
    comes from that row's own logo_url, so this cannot be pointed at an
    arbitrary host. Served with a week of cache, which CloudFront and
    the mail clients' image proxies both honour."""
    import base64
    import hashlib
    import time

    domain = (domain or "").split("?")[0].strip().lower()
    if domain.endswith(".png"):
        domain = domain[:-4]
    if not _LOGO_DOMAIN_RE.match(domain):
        return _response(404, json.dumps({"error": "no such company"}))
    cache_dir = cache_dir or _LOGO_CACHE_DIR
    key = hashlib.sha1(domain.encode("utf-8")).hexdigest()
    blob, meta = cache_dir / f"{key}.bin", cache_dir / f"{key}.ct"
    now = time.time()
    try:
        if meta.exists():
            age = now - meta.stat().st_mtime
            ct = meta.read_text(encoding="utf-8").strip()
            # A miss is marked with the code's own version, so a miss
            # from before the Google fallback below existed is retried.
            if ct == _LOGO_MISS and age < _LOGO_MISS_TTL_S:
                return _response(404, json.dumps({"error": "no logo"}))
            if not ct.startswith("miss") and age < _LOGO_TTL_S and blob.exists():
                return _logo_response(ct, blob.read_bytes())
    except OSError:
        pass

    conn = conn or get_connection()
    row = conn.execute("SELECT logo_url FROM companies WHERE domain = ?", (domain,)).fetchone()
    if row is None:
        return _response(404, json.dumps({"error": "no such company"}))
    url = row[0] or ""
    get = fetch or _fetch_logo
    got = get(url) if url.startswith(("http://", "https://")) else None
    # The resolved URL can refuse a server: HelloFresh's icon answers 403
    # to anything that is not a browser (2026-10-01), and the board used
    # to load it from the browser. Google's favicon service is a neutral
    # host that has most of them; its "nothing found" answer is a 16x16
    # placeholder served as a success, so that size is read as a miss.
    if not got:
        got = _real_icon(get(f"https://www.google.com/s2/favicons?domain={quote(domain)}&sz=64"))
    try:
        cache_dir.mkdir(parents=True, exist_ok=True)
        if got:
            blob.write_bytes(got[1])
            meta.write_text(got[0], encoding="utf-8")
        else:
            meta.write_text(_LOGO_MISS, encoding="utf-8")
    except OSError:
        pass
    if not got:
        return _response(404, json.dumps({"error": "no logo"}))
    return _logo_response(got[0], got[1])


def _logo_response(content_type: str, body: bytes) -> dict:
    import base64

    return {"statusCode": 200,
            "headers": {"Content-Type": content_type, "Cache-Control": f"public, max-age={_LOGO_TTL_S}",
                        "X-Robots-Tag": "noindex", **CORS_HEADERS},
            "body": base64.b64encode(body).decode("ascii"), "isBase64Encoded": True}


def route_unsubscribe(user_id, alert_id, token) -> tuple[int, dict]:
    """Turn one alert off from its mail's unsubscribe link.

    The token is alerts.unsubscribe_token over the alert's key, so the
    URL in a mail works for that alert and no other; compare_digest so
    a wrong one takes as long to reject as a right one. An alert that no
    longer exists is a 404, not an error: the person is unsubscribed
    either way. Without a secret the route is closed, since every token
    would then verify.
    """
    import hmac as _hmac

    import unsubscribe_token as _unsub

    if not _unsub.SECRET:
        return 404, {"error": "unsubscribe links are not enabled"}
    if not (user_id and alert_id and token):
        return 400, {"error": "missing parameters"}
    if not _hmac.compare_digest(str(token), _unsub.unsubscribe_token(user_id, alert_id)):
        return 403, {"error": "bad token"}
    try:
        _alerts_table.update_item(
            Key={"user_id": user_id, "alert_id": alert_id},
            UpdateExpression="SET active = :f",
            ConditionExpression="attribute_exists(alert_id)",
            ExpressionAttributeValues={":f": False},
        )
    except _alerts_table.meta.client.exceptions.ConditionalCheckFailedException:
        return 404, {"error": "no alert with that id"}
    return 200, {"unsubscribed": True}


def unsubscribe_page(user_id, alert_id, token) -> str:
    """A person, not a mail client, opened the unsubscribe link: one
    button that POSTs it, so a link scanner's GET turns nothing off."""
    import html as _html
    from urllib.parse import urlencode as _urlencode

    action = "/api/alerts/unsubscribe?" + _urlencode({"u": user_id or "", "a": alert_id or "", "t": token or ""})
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" /><title>Unsubscribe from this alert</title>
<style>body{{margin:0;background:#0a0a0b;color:#f4f1ee;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;}}
main{{max-width:480px;margin:80px auto;padding:0 24px;}}h1{{font-size:24px;font-weight:500;margin:0 0 12px;}}
p{{color:#9a9ca3;line-height:1.5;}}button{{margin-top:16px;padding:14px 24px;border:0;border-radius:12px;background:#2fb36a;color:#0b1a10;font-size:15px;font-weight:600;cursor:pointer;}}
a{{color:#c9cacf;}}</style></head>
<body><main><h1>Unsubscribe from this alert?</h1>
<p>You will stop getting mail for this one alert. Your other alerts stay as they are, and you can turn this one back on from <a href="/account">your account</a>.</p>
<form method="post" action="{_html.escape(action)}"><button type="submit">Unsubscribe</button></form>
</main></body></html>"""


def route_list_alerts(user_id: str) -> dict:
    resp = _alerts_table.query(KeyConditionExpression=Key("user_id").eq(user_id))
    # The profile and every saved job share this partition under
    # sentinel sort keys (see profile.py and saved.py), so they come back
    # from the same Query. The profile would render as an alert with no
    # filter; a saved job would put one row in the reader's alert list
    # per star, which for anyone who uses the Saved view is most of it.
    items = [i for i in resp.get("Items", [])
             if i.get("alert_id") not in (PROFILE_ID, DASHBOARD_ID) and not is_saved_id(i.get("alert_id"))]
    return {"alerts": items}


def route_get_profile(user_id: str) -> dict:
    """The caller's own profile, or an empty one.

    Absent is not an error: everyone has a profile conceptually, most
    have never filled one in, and a 404 would make the page handle a
    case that is really just "no skills yet".
    """
    resp = _alerts_table.get_item(Key={"user_id": user_id, "alert_id": PROFILE_ID})
    item = resp.get("Item") or {}
    stored = empty_profile()
    stored.update({k: item[k] for k in stored if k in item})
    # The vocabularies ship with the profile rather than from their own
    # route. The page needs both to render at all, and a second copy of
    # the skill list in the frontend is exactly the drift this project
    # already created once between probe.py and the API.
    return {
        "profile": stored,
        "options": {"skills": SKILLS, "seniority": SENIORITY, "workplace": WORKPLACE, "cadence": CADENCE},
        # The full rules for frontend/cv_skills.js, the same ones probe.py
        # tags jobs with. The needles ship as well as the labels because
        # the CV analyser runs in the reader's own browser: the file is
        # never uploaded, so the matching has to happen there, and the
        # browser needs the same terms probe.py uses. Not secret, and
        # shipping them is what keeps one vocabulary rather than two.
        #
        # A second copy of the same data used to ride along under
        # "skill_terms", in the shape the analyser wanted before
        # cv_skills.js existed. It was kept for account pages cached from
        # before that deploy and then never removed: 37KB of a 99KB
        # response, with nothing in the frontend reading it.
        "skill_spec": skill_spec(),
    }


# A day. The numbers are about open roles over weeks; a day's drift is
# nothing, and computing them is three passes over the table.
DASHBOARD_TTL_S = 24 * 3600


def route_dashboard(user_id: str, refresh: bool = False) -> dict:
    """The overview's numbers (dashboard.py), from the stored copy when
    it is for the same skills and under a day old, else computed now
    and stored. refresh=1 computes regardless."""
    from datetime import datetime, timezone

    profile = route_get_profile(user_id)["profile"]
    key = dashboard.scope_key(profile)
    if not refresh:
        item = _alerts_table.get_item(Key={"user_id": user_id, "alert_id": DASHBOARD_ID}).get("Item") or {}
        if item.get("key") == key and item.get("blob"):
            try:
                stored = json.loads(item["blob"])
                at = datetime.fromisoformat(stored["computed_at"])
                if (datetime.now(timezone.utc) - at).total_seconds() < DASHBOARD_TTL_S:
                    return stored
            except (ValueError, KeyError, TypeError):
                pass
    conn = get_connection()
    computed = dashboard.compute(conn, profile, lambda p: _route_jobs(conn, p))
    _alerts_table.put_item(Item={"user_id": user_id, "alert_id": DASHBOARD_ID, "key": key,
                                 "computed_at": computed["computed_at"],
                                 "blob": json.dumps(computed, default=str)})
    return computed


def route_put_profile(user_id: str, body: dict) -> dict:
    """Replace the caller's profile, validated down to known values.

    A whole-object PUT rather than a PATCH: a profile is small, the page
    always holds all of it, and merging partial updates would make
    "clear my skills" indistinguishable from "leave them alone".
    """
    cleaned = clean_profile(body)
    _alerts_table.put_item(Item={
        "user_id": user_id,
        "alert_id": PROFILE_ID,
        **cleaned,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    })
    return {"profile": cleaned}


def route_create_alert(claims: dict, body: dict) -> dict:
    filter_params = body.get("filter")
    if not isinstance(filter_params, dict):
        raise ValueError("filter must be an object of the same query params /api/jobs accepts")
    unknown = set(filter_params) - _ALLOWED_FILTER_KEYS
    if unknown:
        raise ValueError(f"unknown filter key(s): {', '.join(sorted(unknown))}")
    email = claims.get("email")
    if not email:
        raise ValueError("account has no email on file")

    now = datetime.now(timezone.utc).isoformat()
    item = {
        "user_id": claims["sub"],
        "alert_id": str(uuid.uuid4()),
        "email": email,
        "filter": filter_params,
        "created_at": now,
        "active": True,
        # Not None: alerts.py (the evaluator) only ever looks forward of
        # this watermark, so seeding it at creation time rather than
        # leaving it empty means a brand-new alert's first check only
        # catches genuinely new postings from here on -- not every
        # already-open job that happened to match on day one.
        "last_notified_at": now,
    }
    _alerts_table.put_item(Item=item)
    return item


def _alert_update_args(user_id: str, alert_id: str, body: dict) -> dict:
    """The update_item() call for a PATCH, built and validated without
    touching DynamoDB, so the expression itself is testable.
    """
    sets = {}
    if "active" in body:
        sets[":a"] = ("active = :a", bool(body["active"]))
    if "filter" in body:
        filter_params = body["filter"]
        if not isinstance(filter_params, dict):
            raise ValueError("filter must be an object of the same query params /api/jobs accepts")
        unknown = set(filter_params) - _ALLOWED_FILTER_KEYS
        if unknown:
            raise ValueError(f"unknown filter key(s): {', '.join(sorted(unknown))}")
        sets[":f"] = ("#f = :f", filter_params)
        sets[":n"] = ("last_notified_at = :n", datetime.now(timezone.utc).isoformat())
    if not sets:
        raise ValueError("body must include 'active' and/or 'filter'")

    args = {
        "Key": {"user_id": user_id, "alert_id": alert_id},
        "UpdateExpression": "SET " + ", ".join(expr for expr, _ in sets.values()),
        "ConditionExpression": "attribute_exists(alert_id)",
        "ExpressionAttributeValues": {k: v for k, (_, v) in sets.items()},
        "ReturnValues": "ALL_NEW",
    }
    # `filter` is a DynamoDB reserved word, so it can only appear in an
    # UpdateExpression behind a name placeholder. Passing the names map
    # when it is empty is itself an error, hence the conditional.
    if ":f" in sets:
        args["ExpressionAttributeNames"] = {"#f": "filter"}
    return args


def route_update_alert(user_id: str, alert_id: str, body: dict) -> dict | None:
    """Pause/resume, edit the filter, or both in one call.

    This used to be pause/resume only, on the grounds that a filter edit
    could race the evaluator mid-scan. It can, and the cost of losing
    that race is that one 5-minute cycle evaluates the old filter. That
    is a smaller problem than the one it created: the only way to change
    an alert was to delete it and build it again from scratch, which
    loses the alert_id, the created_at, and any chance of the owner
    recognising it in the list.

    A filter edit moves last_notified_at to now, for the same reason
    creation seeds it: widening an alert should start watching from here,
    not mail out every already-open job the new filter happens to match.
    """
    args = _alert_update_args(user_id, alert_id, body)
    try:
        resp = _alerts_table.update_item(**args)
    except _alerts_table.meta.client.exceptions.ConditionalCheckFailedException:
        return None
    return resp["Attributes"]


# /me/saved: the reader's stars, one row per job (see saved.py for the
# shape and why it lives in this table). The rows hold ids and nothing
# else, so the board reads the jobs themselves back through
# /api/jobs?ids=..., and a starred job that has since closed comes back
# with closed_at set rather than vanishing, which is the whole reason
# someone stars one.


def route_list_saved(user_id: str) -> dict:
    """Every job this user has starred, newest first.

    Same whole-partition Query the alert list runs, filtered the same
    way. Sorted here rather than by DynamoDB because the sort key is the
    job id, so the table's own order is by id, which means nothing to a
    reader. A missing saved_at sorts last instead of blowing up the
    comparison.
    """
    resp = _alerts_table.query(KeyConditionExpression=Key("user_id").eq(user_id))
    rows = [i for i in resp.get("Items", []) if is_saved_id(i.get("alert_id"))]
    rows.sort(key=lambda i: i.get("saved_at") or "", reverse=True)
    return {"saved": [{"job_id": job_id_of(i), "saved_at": i.get("saved_at")} for i in rows]}


def route_save_job(user_id: str, job_id: str) -> None:
    """Star a job. Idempotent because the sort key is derived from the
    job id: a second save overwrites the one row rather than adding a
    duplicate, and no read is needed to find out which it is.

    saved_at moves to the later save. That is right for the list's own
    order: someone who unstarred a job and starred it again in the same
    session means it now, not whenever they first noticed it.
    """
    _alerts_table.put_item(Item={
        "user_id": user_id,
        "alert_id": saved_id(job_id),
        # Stored as its own attribute as well as inside the sort key, so
        # anything reading these rows (an export, a delete-my-account)
        # does not have to know how the key is assembled.
        "job_id": job_id,
        "saved_at": datetime.now(timezone.utc).isoformat(),
    })


def route_unsave_job(user_id: str, job_id: str) -> None:
    # No existence check, same convention as route_delete_alert below:
    # unstarring something that is not starred is the state the caller
    # asked for, not an error. The id is still validated first, so a
    # junk path gets a 400 rather than a silent 204 that looks like it
    # did something.
    _alerts_table.delete_item(Key={"user_id": user_id, "alert_id": saved_id(job_id)})


def route_delete_alert(user_id: str, alert_id: str) -> None:
    # No existence check: DELETE is idempotent by convention here, same
    # as a second delete of an already-deleted resource being a no-op
    # rather than an error.
    _alerts_table.delete_item(Key={"user_id": user_id, "alert_id": alert_id})
