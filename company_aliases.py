"""Companies whose recorded domain is not a website.

Discovery finds a company by guessing an ATS token and, when nothing
better is available, takes that token for the domain. Usually the token
IS the domain. Sometimes it is the company's name with a word stuck on
the end, and then the "domain" is a site that does not exist:

    greenhouse token        recorded domain          the real one
    tipaltisolutions        tipaltisolutions.com     tipalti.com
    sentinellabs            sentinellabs.io          sentinelone.com
    pagayais                pagayais.com             pagaya.com
    atbayjobs               atbayjobs.com            at-bay.com
    couchbaseinc            couchbaseinc.com         couchbase.com
    eleoshealth             eleoshealth.com          eleos.health
    wix2                    wix2.com                 wix.com
    apolloio                apolloio.com             apollo.io
    soci                    soci.io                  soci.ai

Every logo path starts from the domain, so the first six showed a
monogram while their real sites were sitting there with perfectly good
icons. Reported live from a screenshot of Tipalti's row, and it turned
out to be six of the 118 Israeli companies in the same sample, not one.

The last three were worse than a monogram. Their recorded domains are
parked, so Google's favicon service returned the registrar's icon and
Wix's listings showed GoDaddy's logo. company_logo.py now rejects those
icons for every company; these entries are what give these three their
real logo instead of a monogram.

This cannot be derived. "sentinellabs.io" does not become
"sentinelone.com" by any rule, so the mapping is hand-verified, the same
way companies.yml pins and probe.py's KNOWN_FALSE_POSITIVES are.

Only the logo uses this today. The listings deliberately stay under the
recorded domain: that is the key the jobs table is built on, and moving
them is a merge, not a rename. The company's own NAME is already right
on all of these, because resolve_company_names asks the ATS rather than
the domain.
"""

try:
    from referral_boards import REFERRAL_BOARDS
except ImportError:
    REFERRAL_BOARDS = {}

# Recorded domain -> the company's actual website. Each one checked by
# hand: the recorded domain does not resolve or is parked, the real one
# does and carries an icon.
REAL_DOMAIN = {
    "tipaltisolutions.com": "tipalti.com",
    "sentinellabs.io": "sentinelone.com",
    "pagayais.com": "pagaya.com",
    "atbayjobs.com": "at-bay.com",
    # Epic Games, recorded under the guessed .io on 2026-09 (the token
    # is "epicgames"); the site and its icon are on .com.
    "epicgames.io": "epicgames.com",
    "couchbaseinc.com": "couchbase.com",
    "eleoshealth.com": "eleos.health",
    "wix2.com": "wix.com",
    "apolloio.com": "apollo.io",
    "soci.io": "soci.ai",
}


# Companies whose own icon is unusable at a tile's size, with the image
# to show instead, served from this site. Ubisoft's only icon is a 150px
# .ico of its swirl in heavy black and white, a smudge at 52px; this is
# the official stacked mark (swirl over the name) drawn from its vector
# form onto a white ground, so it reads the same in both themes. The
# resolver (company_logo.resolve_logo) takes an entry here before any
# other tier, and resolve_company_logos re-resolves a company the day
# it is added. Hand-verified, like everything else in this file.
LOGO_OVERRIDES = {
    "ubisoft.com": "https://oceanofjobs.com/img/logos/ubisoft.png",
}


def logo_domain(domain: str) -> str:
    """Where to look for this company's icon.

    One place to ask, so a caller does not have to know whether a domain
    is wrong because discovery guessed it or because the board it came
    from belongs to somebody else (see referral_boards.py).
    """
    referral = REFERRAL_BOARDS.get(domain, {}).get("logo_domain")
    return referral or REAL_DOMAIN.get(domain, domain)
