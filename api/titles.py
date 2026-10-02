"""A listing's title, taken apart.

Dutch and Israeli employers pack a title with " | " separators: the
role, then the place or the team, then the hours. "Ambulant Begeleider
Maastricht/Heuvelland | regelmatige werktijden | 24-28 uur" is one
title. The first part is the title; an "NN-NN uur" part is an hours
tag; whatever else is there is a grey subtitle beside it.
"""

import re

_HOURS = re.compile(
    r"^\s*(\d{1,2})\s*[-–—]\s*(\d{1,2})\s*(uur|u|hours?|hrs?|h|std\.?|stunden|שעות)\b\.?\s*(?:p/?w|per week|pw|/wk)?\s*$",
    re.I,
)
_SPLIT = re.compile(r"\s+[|•·]\s+|\s+-\s+(?=[A-ZÀ-Ý\d])")


def split_title(title: str) -> tuple[str, str, str]:
    """(title, subtitle, hours). The subtitle and hours are "" when the
    title has no separators to speak of."""
    text = (title or "").strip()
    parts = [p.strip() for p in re.split(r"\s+\|\s+", text) if p.strip()]
    if len(parts) < 2:
        m = re.match(r"^(.*?)\s*\((\d{1,2}\s*[-–—]\s*\d{1,2}\s*(?:uur|u|hours?|hrs?|h))\)\s*$", text, re.I)
        if m:
            return m.group(1).strip(), "", _hours_text(m.group(2))
        return text, "", ""
    main, rest, hours = parts[0], [], ""
    for p in parts[1:]:
        if not hours and _HOURS.match(p):
            hours = _hours_text(p)
        else:
            rest.append(p)
    return main, " · ".join(rest), hours


def _hours_text(part: str) -> str:
    m = re.match(r"\s*(\d{1,2})\s*[-–—]\s*(\d{1,2})\s*([^\s\d.]+)", part)
    if not m:
        return part.strip()
    unit = m.group(3).lower()
    unit = {"u": "uur", "h": "hours", "hr": "hours", "hrs": "hours", "hour": "hours", "std": "Std."}.get(unit, m.group(3))
    return f"{m.group(1)}–{m.group(2)} {unit}"
