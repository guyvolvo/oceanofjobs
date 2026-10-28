"""Every page but the homepage carries the shared header, written from
api/site_header.py, so every section links to every other.

    python tests/test_site_header.py
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "api"), str(ROOT / "scripts")]
import build_pages  # noqa: E402
import page_chrome  # noqa: E402
import site_header  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}: {name}" + ("" if ok else f"  -- {detail}"))
    if not ok:
        failures.append(name)


hrefs = [h for _, _, t in site_header.SECTIONS for h in ([t] if isinstance(t, str) else [x[1] for x in t])]
bar = site_header.header()
check("the header links every section, and no longer Auto apply or About", "Auto apply" not in bar and ">About<" not in bar and all(f'href="{h.replace("&", "&amp;")}"' in bar for h in hrefs))
check("the header marks the current section", 'site-menu is-current" data-menu="docs"' in site_header.header("docs")
      and 'aria-current="page">Pricing' in site_header.header("pricing")
      and 'aria-current="page">Contact' in site_header.header("contact"))

pages = build_pages.MARKED + [build_pages.FRONT / f"{n}.html" for n in ("pricing", *build_pages.LEGAL)]
for path in pages:
    page = path.read_text(encoding="utf-8")
    # Rebuilding changes nothing: the page holds today's header, not an old copy.
    check(f"{path.name} ({path.parent.name}) is up to date", build_pages.marked(page) == page,
          "run python scripts/build_pages.py")
    check(f"{path.parent.name}/{path.name} has no old bar", not re.search(r'class="(topbar|pg-bar|oj-bar)[" ]', page))
    if "<!-- side-nav:" in page:
        check(f"{path.name}'s sidebar links every section", all(f'href="{h}"' in page for _, _, h in site_header.SIDE))
    else:
        check(f"{path.name} has the header and its scripts", "site-header" in page and all(
            re.search(rf'src="/?{s.strip("/")}"', page) for s in ("hero_nav.js", "hero_account.js", "mobile_nav.js")))

home = (build_pages.FRONT / "index.html").read_text(encoding="utf-8")
check("the homepage keeps its own bar", "site-header" not in home and '<header class="home-bar hero-bar-head">' in home)
check("server pages get the header and its scripts", "site-header" in page_chrome.topbar("jobs")
      and all(s in page_chrome.FOOT for s in site_header.SCRIPTS))
check("the docs carry today's header", build_pages.DOCS_HEADER.read_text(encoding="utf-8") == build_pages.docs_header(),
      "run python scripts/build_pages.py")

print(f"\n{len(failures)} failed" if failures else "\nall passed")
sys.exit(1 if failures else 0)
