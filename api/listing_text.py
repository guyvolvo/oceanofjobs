"""What a listing's text says beyond its words: the closing date buried
in a paragraph, the language it is written in, and the text itself as
readable HTML.

Everything here is a function of strings and the clock, so it is
testable on its own (tests/test_listing_text.py).
"""

import html
import re
from datetime import date, datetime, timedelta, timezone

# Month names, lowercase, in the languages the board sees most. The
# value is the month number.
_MONTHS: dict[str, int] = {}
for i, names in enumerate([
    ("january", "jan", "januari", "januar", "janvier", "enero"),
    ("february", "feb", "februari", "februar", "février", "fevrier", "febrero"),
    ("march", "mar", "maart", "märz", "marz", "mars", "marzo"),
    ("april", "apr", "avril", "abril"),
    ("may", "mei", "mai", "mayo"),
    ("june", "jun", "juni", "juin", "junio"),
    ("july", "jul", "juli", "juillet", "julio"),
    ("august", "aug", "augustus", "août", "aout", "agosto"),
    ("september", "sep", "sept", "septembre", "septiembre"),
    ("october", "oct", "oktober", "octobre", "octubre"),
    ("november", "nov", "novembre", "noviembre"),
    ("december", "dec", "december", "dezember", "décembre", "decembre", "diciembre"),
], 1):
    for n in names:
        _MONTHS[n] = i

_MONTH_RE = "|".join(sorted(map(re.escape, _MONTHS), key=len, reverse=True))

# What the sentence around a date has to say for the date to be a
# closing date rather than a start date or a founding year.
_CUES = (r"(?:apply|applications?|application\s+deadline|closing\s+date|closes?|closing|deadline|open\s+until|"
         r"until|before|by|no\s+later\s+than|reageer|reageren|solliciteer|solliciteren|sluitingsdatum|uiterlijk|"
         r"vóór|voor|tot\s+en\s+met|t/m|bewerbungsfrist|bewerben|bis|spätestens|candidater|avant\s+le|jusqu.au|"
         r"postular|hasta\s+el|מועד\s+אחרון|עד\s+ה?)")
_DEADLINE_WORDS = re.compile(
    rf"{_CUES}[^.\n]{{0,40}}?\b(\d{{1,2}})(?:st|nd|rd|th|e|\.)?\s+(?:of\s+)?({_MONTH_RE})\.?\s*,?\s*(\d{{4}})?\b",
    re.I,
)
_DEADLINE_WORDS_US = re.compile(
    rf"{_CUES}[^.\n]{{0,40}}?\b({_MONTH_RE})\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?\s*,?\s*(\d{{4}})?\b", re.I,
)
_DEADLINE_NUMERIC = re.compile(
    rf"{_CUES}[^.\n]{{0,30}}?\b(\d{{1,2}})[./-](\d{{1,2}})[./-](\d{{4}}|\d{{2}})\b", re.I,
)
_DEADLINE_ISO = re.compile(rf"{_CUES}[^.\n]{{0,30}}?\b(\d{{4}})-(\d{{2}})-(\d{{2}})\b", re.I)


def deadline_from(text: str, now=None, country: str = "", posted=None):
    """The closing date the text names, as (date, matched_text), or None.

    A date more than a year ahead, or well before the listing was
    posted, is not a deadline and is left alone. A numeric date reads
    day-first except for a US listing, where it reads month-first.
    """
    if not text:
        return None
    now = now or datetime.now(timezone.utc)
    today = now.date() if hasattr(now, "date") else now
    floor = (posted.date() if hasattr(posted, "date") else posted) if posted else today - timedelta(days=60)
    ceiling = today + timedelta(days=366)

    def ok(d: date) -> bool:
        return floor - timedelta(days=1) <= d <= ceiling

    def year_or_next(month: int, day: int, year):
        if year:
            y = int(year)
            return y + 2000 if y < 100 else y
        # No year: this year, or next if that is already past.
        y = today.year
        try:
            if date(y, month, day) < today - timedelta(days=14):
                y += 1
        except ValueError:
            return None
        return y

    for m in _DEADLINE_WORDS.finditer(text):
        day, month, year = int(m.group(1)), _MONTHS.get(m.group(2).lower()), m.group(3)
        y = year_or_next(month, day, year) if month else None
        try:
            d = date(y, month, day) if y else None
        except ValueError:
            d = None
        if d and ok(d):
            return d, m.group(0)
    for m in _DEADLINE_WORDS_US.finditer(text):
        month, day, year = _MONTHS.get(m.group(1).lower()), int(m.group(2)), m.group(3)
        y = year_or_next(month, day, year) if month else None
        try:
            d = date(y, month, day) if y else None
        except ValueError:
            d = None
        if d and ok(d):
            return d, m.group(0)
    for m in _DEADLINE_NUMERIC.finditer(text):
        a, b, year = int(m.group(1)), int(m.group(2)), m.group(3)
        y = int(year) + (2000 if len(year) == 2 else 0)
        day, month = (b, a) if country == "US" and a <= 12 else (a, b)
        if day > 12 and month > 12:
            continue
        if day > 12 and month <= 12:
            pass
        elif month > 12 and day <= 12:
            day, month = month, day
        try:
            d = date(y, month, day)
        except ValueError:
            continue
        if ok(d):
            return d, m.group(0)
    for m in _DEADLINE_ISO.finditer(text):
        try:
            d = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            continue
        if ok(d):
            return d, m.group(0)
    return None


# The commonest short words of each language; a listing is in the
# language whose words it uses most. English is the default and needs
# a real margin to be overruled, since every language's listing has
# some English in it (job titles, tool names).
_STOPWORDS = {
    "Dutch": {"de", "het", "een", "en", "van", "voor", "met", "wij", "je", "jij", "bij", "onze", "werken", "functie",
              "zijn", "wordt", "ook", "niet", "naar", "om", "als", "dat", "dit", "uur", "jouw", "ons", "over"},
    "German": {"und", "der", "die", "das", "mit", "für", "wir", "sie", "nicht", "eine", "bei", "ist", "auf", "sind",
               "zu", "den", "dem", "ein", "als", "unser", "unsere", "ihre", "oder", "sowie", "werden"},
    "French": {"le", "la", "les", "des", "et", "pour", "vous", "nous", "une", "est", "avec", "dans", "sur", "qui",
               "que", "votre", "notre", "nos", "vos", "au", "aux", "ce", "cette", "sont"},
    "Spanish": {"el", "la", "los", "las", "y", "para", "con", "una", "que", "es", "en", "del", "por", "como", "nuestro",
                "nuestra", "más", "su", "sus", "ser", "al", "lo", "trabajo", "equipo"},
    "Portuguese": {"o", "a", "os", "as", "e", "para", "com", "uma", "que", "é", "em", "do", "da", "dos", "das", "não",
                   "nossa", "nosso", "você", "mais", "ser", "ao", "pelo", "trabalho"},
    "English": {"the", "and", "you", "with", "our", "will", "for", "are", "to", "of", "in", "on", "we", "your", "is",
                "as", "at", "an", "be", "or", "this", "that", "from", "have", "team"},
}
_HEBREW = re.compile(r"[֐-׿]")
_ARABIC = re.compile(r"[؀-ۿ]")
_WORD = re.compile(r"[a-zà-ÿ]+", re.I)


def language_of(text: str) -> str:
    """"English", "Dutch", "Hebrew", ... for a text long enough to tell;
    "English" when it is too short or too mixed to say otherwise."""
    if not text:
        return "English"
    sample = text[:6000]
    letters = len(re.findall(r"[^\W\d_]", sample))
    if letters and len(_HEBREW.findall(sample)) > letters * 0.3:
        return "Hebrew"
    if letters and len(_ARABIC.findall(sample)) > letters * 0.3:
        return "Arabic"
    words = [w.lower() for w in _WORD.findall(sample)]
    if len(words) < 30:
        return "English"
    scores = {lang: sum(1 for w in words if w in stop) for lang, stop in _STOPWORDS.items()}
    best = max(scores, key=scores.get)
    if best == "English" or scores[best] < 8 or scores[best] <= scores["English"] * 1.2:
        return "English"
    return best


_URL = re.compile(r"(https?://[^\s<>()\"']+[^\s<>()\"'.,;:!?])|(\bwww\.[^\s<>()\"']+[^\s<>()\"'.,;:!?])")
_EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b")


def _link_html(url: str) -> str:
    href = url if url.startswith("http") else f"https://{url}"
    host = re.sub(r"^https?://", "", url).split("/")[0]
    host = re.sub(r"^www\.", "", host)
    return (f'<a href="{html.escape(href, quote=True)}" target="_blank" rel="nofollow noopener">'
            f'{html.escape(host)} <span aria-hidden="true">↗</span></a>')


def _inline(text: str, bold: str | None = None) -> str:
    """Escaped text with links shortened to their host, mail addresses
    linked, and the closing-date phrase in bold."""
    out, pos = [], 0
    spans = [(m.start(), m.end(), "url") for m in _URL.finditer(text)]
    spans += [(m.start(), m.end(), "mail") for m in _EMAIL.finditer(text)
              if not any(a <= m.start() < b for a, b, _ in spans)]
    if bold:
        i = text.find(bold)
        if i >= 0 and not any(a < i + len(bold) and i < b for a, b, _ in spans):
            spans.append((i, i + len(bold), "bold"))
    for a, b, kind in sorted(spans):
        if a < pos:
            continue
        out.append(html.escape(text[pos:a]))
        piece = text[a:b]
        if kind == "url":
            out.append(_link_html(piece))
        elif kind == "mail":
            out.append(f'<a href="mailto:{html.escape(piece, quote=True)}">{html.escape(piece)}</a>')
        else:
            out.append(f"<b>{html.escape(piece)}</b>")
        pos = b
    out.append(html.escape(text[pos:]))
    return "".join(out)


_BULLET = re.compile(r"^[-*•·▪◦‣]\s+(.*)")
_MD_HEADING = re.compile(r"^#{1,6}\s+(.*?)\s*:?\s*$")


def _looks_like_heading(line: str, prev_blank: bool, next_line: str | None) -> bool:
    """A short line on its own, with no sentence punctuation at the end
    (or a colon), followed by more text: a heading the source lost."""
    if not prev_blank or next_line is None or not next_line.strip():
        return False
    if len(line) > 70 or len(line.split()) > 10:
        return False
    if line.endswith((".", ",", ";", "!")):
        return False
    if _BULLET.match(line) or _URL.search(line):
        return False
    if line.endswith((":", "?")):
        return True
    words = [w for w in re.findall(r"[^\W\d_]+", line)]
    if not words:
        return False
    caps = sum(1 for w in words if w[0].isupper())
    return caps >= max(1, len(words) - 1) or line.isupper()


def description_html(text: str, bold: str | None = None) -> str:
    """Plain text to paragraphs, lists and headings. Lines of one
    paragraph are joined with a space rather than a break, since the
    sources wrap at their own column; a blank line starts a new one."""
    lines = [l.rstrip() for l in (text or "").splitlines()]
    out, para, items = [], [], []

    def flush():
        nonlocal para, items
        if items:
            out.append("<ul>" + "".join(f"<li>{_inline(i, bold)}</li>" for i in items) + "</ul>")
            items = []
        if para:
            out.append(f"<p>{_inline(' '.join(para), bold)}</p>")
            para = []

    prev_blank = True
    for i, raw in enumerate(lines):
        line = raw.strip()
        if not line:
            flush()
            prev_blank = True
            continue
        nxt = lines[i + 1] if i + 1 < len(lines) else None
        md = _MD_HEADING.match(line)
        if md:
            flush()
            out.append(f"<h2>{_inline(md.group(1), None)}</h2>")
            prev_blank = True
            continue
        m = _BULLET.match(line)
        if m:
            if para:
                flush()
            items.append(m.group(1))
            prev_blank = False
            continue
        if items:
            flush()
        if not para and _looks_like_heading(line, prev_blank, nxt):
            out.append(f"<h2>{_inline(line.rstrip(':'), None)}</h2>")
            prev_blank = True
            continue
        para.append(line)
        prev_blank = False
    flush()
    return "".join(out)
