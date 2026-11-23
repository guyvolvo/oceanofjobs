"""Company names when the board gives none: what is accepted, what is not.

The fallbacks read pages the company did not write for us (its
homepage, Wikidata, the Workday site id), and for much of Workday the
domain is itself a guess. So the risk is not a missing name, it is the
wrong company's name, and most of these checks are refusals.

Run directly, no framework:  python tests/test_company_name_fallback.py
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import resolve_company_names as r  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failures.append(name)


# Workday site ids, measured on the boards that had no name (2026-11-08).
for token, want in [("capitalone:wd12:Capital_One", "Capital One"),
                    ("cat:wd5:CaterpillarCareers", "Caterpillar"),
                    ("blackrock:wd1:BlackRock_Professional", "BlackRock"),
                    ("ngc:wd1:Northrop_Grumman_External_Site", "Northrop Grumman"),
                    ("cadence:wd1:External_Careers", None),
                    ("flextronics:wd1:Careers", None),
                    ("asml:wd3:asmlext1", None),
                    ("x:wd1:University_Careers", None)]:
    got = r._from_site(token)
    check(f"site id {token.split(':')[2]} -> {want!r}", got == want, repr(got))

wd = lambda d, t: r._labels({"domain": d, "ats": "workday", "token": t})  # noqa: E731
check("a name containing the domain label agrees", r._agrees("Capital One", wd("capitalone.com", "capitalone:wd12:x")))
check("a label inside the name agrees (tenant cat, Caterpillar)", r._agrees("Caterpillar", wd("cat.io", "cat:wd5:x")))
check("a name inside the label agrees (Flex, flextronics)", r._agrees("Flex", wd("flextronics.com", "flextronics:wd1:x")))
check("initials leading the label agree (Northrop Grumman, ngc)", r._agrees("Northrop Grumman", wd("ngc.com", "ngc:wd1:x")))
check("a name inside the label only at its start (not Spaces for livingspaces)",
      not r._agrees("Spaces", wd("livingspaces.fr", "livingspaces:wd5:ls")))
check("initials must be the label, not just lead it (not Northern California for ncnu)",
      not r._agrees("Northern California", wd("ncnu.com", "ncnu:wd1:x")))
check("the label less an Inc's i still counts (Kontoor Brands, kbi)", r._agrees("Kontoor Brands", wd("kbi.com", "kbi:wd5:x")))
check("sidebar phrases do not run across fields", r._PHRASE.findall("Logo\nRolls-Royce pioneers") == ["Logo", "Rolls-Royce"])
pieces = [x for p in r._PHRASE.findall("Projects in Indonesia. Cenovus’s team. T. Rowe Price helps. "
                                        "Academy of Art University is here") for x in r._SENTENCE_END.split(p)]
check("a full stop ends a phrase", "Indonesia" in pieces and "Cenovus’s" in pieces, str(pieces))
check("but not after an initial", "T. Rowe Price" in pieces, str(pieces))
check("of and and stay inside a name", "Academy of Art University" in pieces, str(pieces))
check("a possessive, a trailing Logo and a full stop come off",
      [r._clean_candidate(x) for x in ("Cenovus’s", "PriceSmart Logo", "Custom Ink.")] == ["Cenovus", "PriceSmart", "Custom Ink"])
check("trademark signs come off",r._clean_candidate("Aegis Therapies®") == "Aegis Therapies")
check("a person whose surname is the label does not (Greg Johnson, johnson.io)",
      not r._agrees("Greg Johnson", r._labels({"domain": "johnson.io"})))
check("an e. V. is not cut at the e",
      r._homepage_names("<title>Lebenshilfe Landshut e. V.</title>")[0].startswith("Lebenshilfe Landshut e. V"))
check("a static empty name forces the domain", r.STATIC_NAMES.get("jonathan.com") == "")
check("a board that answers with its SSO login is not named after it", "onelogin" in r.GENERIC_NAMES)
check("same site means the same first label", r._host("https://www.aircall.io/x").split(".")[0] == r._host("https://aircall.com/").split(".")[0]
      and r._host("https://victoriassecret.com/").split(".")[0] != r._host("https://victoria.com/").split(".")[0])
check("an unrelated name does not", not r._agrees("Acme Health Guide", wd("cat.io", "cat:wd5:x")))
check("a two-letter label proves nothing", r._labels({"domain": "hp.com"}) == set())
check("careers. and www. are not the company", r._labels({"domain": "careers.deel.com"}) == {"deel"})

page = ('<html><head><title>Cadence | Design for AI and AI for Design</title>'
        '<meta property="og:site_name" content="Cadence"></head>')
check("og:site_name comes first", r._homepage_names(page)[0] == "Cadence", str(r._homepage_names(page)))
check("a title piece is used when there is no site name",
      "Northrop Grumman" in r._homepage_names("<title>Home | Northrop Grumman</title>"))
for junk in ["<title>headoutcareers.com is for sale</title>", "<title>Just a moment...</title>",
             "<title>403 Forbidden</title>", "<title>Home</title>", "<title>WNC - Untitled</title>"]:
    names = r._homepage_names(junk)
    check(f"no junk name from {junk[7:-8]!r}", all(n not in ("Home", "Untitled") and "." not in n
                                                   and "moment" not in n.lower() and "forbidden" not in n.lower()
                                                   for n in names), str(names))
check("a legal suffix and a parenthetical come off", r._clean_candidate("Oracle Corporation") == "Oracle"
      and r._clean_candidate("Flextronics (Sweden)") == "Flextronics")


class NoNet:
    """Every request fails: the board resolver and the fallbacks alike."""
    def get(self, *a, **k):
        raise r.requests.RequestException("offline")

    post = get


d, name, source = r.resolve_one({"domain": "capitalone.com", "ats": "workday", "token": "capitalone:wd12:Capital_One"}, NoNet())
check("with every request failing, the Workday site id still names Capital One",
      (name, source) == ("Capital One", "site"), repr((name, source)))
d, name, source = r.resolve_one({"domain": "oracle.com", "ats": "oracle", "token": "eeho.fa.us2.oraclecloud.com:CX_45001"}, NoNet())
check("and a board with nothing to read stays unnamed rather than guessed", name is None, repr(name))

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
