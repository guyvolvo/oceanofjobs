"""Adds one changelog entry to docs/content/docs/changelog.mdx, newest first.
Run by .github/workflows/publish-changelog.yml with the entry in the
environment (ID, DATE, TITLE, BODY), which the CRM sends.

    ID=abc DATE=2026-10-25 TITLE="..." BODY="..." python scripts/add_changelog_entry.py

The text is the owner's Markdown, but the page is MDX: a { or < in it would
be read as code and break the docs build, so both are written as entities.
An entry already on the page (same ID) is left alone, so a retried publish
doesn't add it twice.
"""
import os
import re
import sys
from datetime import date
from pathlib import Path

PAGE = Path(__file__).resolve().parent.parent / "docs" / "content" / "docs" / "changelog.mdx"
MARKER = "{/* entries: newest first. scripts/add_changelog_entry.py adds each one below this line. */}"


def safe(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("{", "&#123;").replace("}", "&#125;")


def main() -> int:
    entry_id = os.environ.get("ID", "")
    when = os.environ.get("DATE", "")
    title = " ".join(os.environ.get("TITLE", "").split())[:120]
    body = os.environ.get("BODY", "").replace("\r", "").strip()[:20000]
    if not re.fullmatch(r"[0-9a-f]{8,32}", entry_id):
        sys.exit("ID must be the CRM's hex id")
    try:
        day = date.fromisoformat(when)
    except ValueError:
        sys.exit("DATE must be YYYY-MM-DD")
    if not title or not body:
        sys.exit("TITLE and BODY are required")
    page = PAGE.read_text(encoding="utf-8")
    if f"{{/* entry {entry_id} */}}" in page:
        print("already published")
        return 0
    # Headings inside an entry sit under its own ## title.
    body = re.sub(r"^(#{1,2})(\s)", r"###\2", body, flags=re.M)
    block = f"{{/* entry {entry_id} */}}\n## {safe(title)}\n\n*{day.strftime('%-d %B %Y') if os.name != 'nt' else day.strftime('%d %B %Y').lstrip('0')}*\n\n{safe(body)}\n"
    if MARKER not in page:
        sys.exit("the changelog page lost its marker line")
    PAGE.write_text(page.replace(MARKER, MARKER + "\n\n" + block, 1), encoding="utf-8")
    print(f"added: {title}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
