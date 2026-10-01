"""The account overview's numbers, computed once and kept.

The overview used to ask the box for three things on every visit: the
history of open roles matching the reader's skills (a pass over the
table), the count per skill (another), and the sixty best matches (a
third). On a box whose file is bigger than its RAM each pass is a disk
read, and a visit cost 5 to 30 seconds while the applier held the disk
(2026-10-01). None of it changes minute to minute. So the answer is
computed on the first visit of the day, stored with the profile, and
served from there until the skills change or a day passes.

This module is the computation; handler.py reads and writes the stored
copy (DynamoDB, the profile table, item DASHBOARD_ID).
"""
from datetime import datetime, timezone

from aggregates import skill_counts, skills_history

MIN_MATCH = 3
MATCHES = 60
SHOWN_SKILLS = 10
# A skill the reader does not list, named by at least this share of
# their matches, is worth suggesting; the two most named are.
SUGGEST_SHARE = 0.2
SUGGESTIONS = 2
# What the overview reads of a match; the rest of the row stays behind.
MATCH_FIELDS = ("id", "title", "company_domain", "company_name", "location", "skills",
                "salary_text", "salary_is_estimate", "first_seen", "posted_at", "closed_at",
                "match_score", "logo_url", "seniority", "workplace_type")


def scope(profile: dict) -> dict:
    """What the numbers are about: the skills, one preferred country
    when exactly one is set, and how many skills a match must share.
    The same rule the page applied client-side."""
    skills = [s for s in (profile.get("skills") or []) if s]
    countries = [c for c in (profile.get("country") or []) if c]
    country = countries[0] if len(countries) == 1 else ""
    return {"skills": skills, "country": country, "min_match": min(MIN_MATCH, len(skills))}


def scope_key(profile: dict) -> str:
    s = scope(profile)
    return f"{','.join(s['skills'])}|{s['country']}|{s['min_match']}"


def suggestions(skills: list, matches: list) -> list:
    """Skills the matches ask for that the reader does not list, with
    the share of matches naming each, most named first."""
    have = set(skills)
    seen: dict = {}
    for j in matches:
        for sk in (j.get("skills") or "").split(","):
            if sk and sk not in have:
                seen[sk] = seen.get(sk, 0) + 1
    n = len(matches)
    out = [(sk, c / n) for sk, c in seen.items() if n and c / n >= SUGGEST_SHARE]
    out.sort(key=lambda x: -x[1])
    return out[:SUGGESTIONS]


def compute(conn, profile: dict, page) -> dict:
    """Everything the overview shows, for this profile, now.

    `page` runs a listing query and returns its rows: handler._route_jobs
    bound to the connection, passed in rather than imported so this
    module does not pull the whole handler in."""
    s = scope(profile)
    computed_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    if not s["skills"]:
        return {"key": scope_key(profile), "computed_at": computed_at, "history": None,
                "counts": {}, "matches": [], "suggested": []}
    base = {"skills": ",".join(s["skills"]), "confidence": "all"}
    if s["country"]:
        base["country"] = s["country"]
    history = skills_history(conn, dict(base, min_match=str(s["min_match"])))
    rows = page(dict(base, sort="match", dir="asc", limit=str(MATCHES), offset="0", count="skip")).get("jobs") or []
    matches = [{k: j.get(k) for k in MATCH_FIELDS if j.get(k) is not None} for j in rows]
    suggested = suggestions(s["skills"], matches)
    wanted = s["skills"][:SHOWN_SKILLS] + [sk for sk, _ in suggested]
    counts = skill_counts(conn, dict(base, skills=",".join(wanted)))["counts"]
    return {"key": scope_key(profile), "computed_at": computed_at, "history": history,
            "counts": counts, "matches": matches,
            "suggested": [{"skill": sk, "share": round(share, 3)} for sk, share in suggested]}
