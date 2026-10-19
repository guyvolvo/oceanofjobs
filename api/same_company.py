"""Domains that are the same company as another domain on the board.

The loader already catches two domains resolving to one board: same ATS,
same token, one of them is an alias (see _demote_alias in
loader/load_to_sqlite.py). It cannot catch one company on two different
ATSes, because nothing about the two boards matches except the jobs.

Wayve was that. Discovery guessed the token "wayve" for two domains and
found a board on each: wayve.ai on Greenhouse and wayve.fr on Ashby.
Every role showed twice, 142 titles in common, and wayve.fr is not even
Wayve's site. It belongs to a French drinking-water company, which is
where the second logo came from. Reported live from a screenshot.

A scan of all 144,255 open jobs found no other pair like it. Title
overlap alone is not proof: weave.com and weave.ai share a few generic
titles and are two different companies. So this list is hand-verified,
like company_aliases.REAL_DOMAIN, and never filled in automatically.

Which one to keep: the board the company's own careers page links to.
wayve.ai/careers embeds the Greenhouse board.

What belongs here: two domains that are verifiably one set of postings,
never two companies under one owner. Since 2026-10-19 that includes one
board polled under two spellings of its token, which the loader's exact
(ats, token) match misses; scripts/audit_duplicate_boards.py finds those
candidates and changes nothing. Each entry says what proved it.

The loader closes a listed domain's jobs and stops treating it as
resolved on every load, so it drops out of known.json and the fast poll.
probe.py skips it in a batch, so discovery cannot bring it back.
"""

# Duplicate domain -> the domain whose board is kept.
SAME_COMPANY = {
    "wayve.fr": "wayve.ai",
    # SentinelOne is on the board as sentinellabs.io, the domain its
    # Greenhouse board is named for. Pinning sentinelone.com to the same
    # board on 2026-09-18 just made the loader demote it as an alias
    # every day, so this says so once instead.
    "sentinelone.com": "sentinellabs.io",
    # One SmartRecruiters board polled as "Wix2" under wix.com and "wix2"
    # under wix2.com. The loader's exact token match kept both, so every
    # Wix role showed twice. Confirmed 2026-10-19: the same 75 jobs with
    # the same SmartRecruiters ids, apply URLs differing only in case.
    "wix2.com": "wix.com",
    # The three below, from scripts/audit_duplicate_boards.py on
    # 2026-10-19. Each is one Ashby board whose name differs only in case,
    # every open posting shared with the same Ashby job id. The kept
    # domain is the company's own site.
    #   redis.com: "Redis", redis.io: "redis". 29 of 29 shared.
    #   redis.com redirects to redis.io.
    "redis.com": "redis.io",
    #   human.com: "human", humansecurity.com: "HUMAN". 9 of 9 shared.
    #   human.com is someone else's site; HUMAN Security is
    #   humansecurity.com.
    "human.com": "humansecurity.com",
    #   aquant.com: "aquant", aquant.io: "Aquant". 3 of 3 shared, few
    #   but the same Ashby ids, e.g. e8fd5c39-7754-4995-818f-d0f7ebc775de.
    #   aquant.com redirects to aquent.com, an unrelated staffing firm.
    "aquant.com": "aquant.io",
    # Not m1.com / m1finance.com: one SmartRecruiters board by its ids,
    # but a single shared posting is too little to act on yet.
}
