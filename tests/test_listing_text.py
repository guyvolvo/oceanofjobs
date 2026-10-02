"""listing_text and titles: the closing date in a paragraph, the
language of a listing, readable HTML, a packed title taken apart.

Run directly, no framework:  python tests/test_listing_text.py
"""
import sys
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))

import listing_text as lt  # noqa: E402
import titles  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + detail))
    if not ok:
        failures.append(name)


NOW = datetime(2026, 10, 2, 12, 0, tzinfo=timezone.utc)
dl = lambda text, **kw: (lt.deadline_from(text, NOW, **kw) or (None, None))[0]  # noqa: E731

check("Dutch: Reageer vóór 19 oktober 2026", dl("Reageer vóór 19 oktober 2026 via de website.") == date(2026, 10, 19))
check("English, day first and month first",
      dl("Apply before 19 October 2026.") == date(2026, 10, 19) and dl("Applications close October 19, 2026.") == date(2026, 10, 19))
check("English with an ordinal and 'of'", dl("Application deadline: 19th of October 2026.") == date(2026, 10, 19))
check("German: bis zum 19. Oktober 2026", dl("Bewerbungsfrist: bis zum 19. Oktober 2026.") == date(2026, 10, 19))
check("numeric, day first by default", dl("Closing date 19/10/2026.") == date(2026, 10, 19))
check("numeric, month first for a US listing", dl("Deadline 10/19/2026", country="US") == date(2026, 10, 19))
check("ISO", dl("Open until 2026-10-19.") == date(2026, 10, 19))
check("no year: this year, or next when that is past", dl("Apply before 19 October.") == date(2026, 10, 19) and dl("Apply by 3 January.") == date(2027, 1, 3))
check("a date with no closing cue is not a deadline", dl("We opened our office on 3 March 2021.") is None and dl("Founded in 1998.") is None)
check("a date far in the past is not a deadline", dl("Apply by 1 January 2020.") is None)
check("a date more than a year out is not a deadline", dl("Apply by 1 January 2028.") is None)
check("the matched phrase is returned for the page to set in bold",
      lt.deadline_from("Please apply by 19 October 2026 at the latest.", NOW)[1] == "apply by 19 October 2026")

check("Dutch is Dutch", lt.language_of("Het Topklinisch Centrum voor Korsakov en alcoholgerelateerde cognitieve stoornissen van het instituut diagnosticeert en behandelt complexe stoornissen, waarbij de problematiek veelal therapieresistent is gebleken. Als gevolg van een beperkte voedselinname, vaak in combinatie met ernstig chronisch alcoholgebruik, kunnen er neurocognitieve stoornissen ontstaan. Bij een klein deel van onze cliënten is er sprake van het syndroom.") == "Dutch")
check("English is English", lt.language_of("We are looking for a senior engineer to join our team and build the platform with us. You will work with the product team on the roadmap and ship features for our customers every week, and you will own the services you build.") == "English")
check("Hebrew is Hebrew", lt.language_of("אנחנו מחפשים מהנדס תוכנה בכיר להצטרף לצוות שלנו ולבנות את הפלטפורמה. תעבדו עם צוות המוצר ותשחררו פיצ'רים ללקוחות שלנו מדי שבוע.") == "Hebrew")
check("too short to say is English", lt.language_of("Wij zoeken een developer.") == "English")

h = lt.description_html("Intro line one\nline two of intro.\n\nWat ga je doen?\nJe leert dingen. Meer op https://www.korsakov.nl/stages/psychologie.\n\nReageer vóór 19 oktober 2026 via mail@example.com.\n\n- Ship\n- Measure", bold="vóór 19 oktober 2026")
check("lines of a paragraph are joined, not broken", "<p>Intro line one line two of intro.</p>" in h, h[:120])
check("a short line before a paragraph is a heading", "<h2>Wat ga je doen?</h2>" in h)
check("a link shows its host with an arrow and opens elsewhere",
      '<a href="https://www.korsakov.nl/stages/psychologie" target="_blank" rel="nofollow noopener">korsakov.nl <span aria-hidden="true">↗</span></a>' in h)
check("the closing phrase is bold and the address is a mail link",
      "<b>vóór 19 oktober 2026</b>" in h and '<a href="mailto:mail@example.com">mail@example.com</a>' in h)
check("bullets are a list", "<ul><li>Ship</li><li>Measure</li></ul>" in h)
check("markup in the text is escaped", "&lt;b&gt;" in lt.description_html("Close <b>x</b> early"))
check("a plain sentence is not mistaken for a heading", "<h2>" not in lt.description_html("We build things.\n\nOur team ships daily and we like it."))

check("a packed title splits into title, subtitle and hours",
      titles.split_title("Ambulant Begeleider Maastricht/Heuvelland | regelmatige werktijden | 24-28 uur")
      == ("Ambulant Begeleider Maastricht/Heuvelland", "regelmatige werktijden", "24–28 uur"))
check("hours in the middle still become the tag", titles.split_title("Verpleegkundige | 32-36 uur | Venlo") == ("Verpleegkundige", "Venlo", "32–36 uur"))
check("hours in brackets", titles.split_title("Jeugdzorgwerker (24-32 uur)") == ("Jeugdzorgwerker", "", "24–32 uur"))
check("a plain title is left alone", titles.split_title("Senior Software Engineer") == ("Senior Software Engineer", "", ""))

print()
if failures:
    print("%d failed:" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("all passed")
