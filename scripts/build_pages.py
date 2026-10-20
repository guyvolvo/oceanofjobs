"""Writes /pricing and the legal pages from frontend/index.html.

Every page here is the homepage's own shell (head, header, footer,
cookie banner) around its own content, so none of them can look
different from the homepage. Run after editing the homepage or a page:

    python scripts/build_pages.py

- pricing: the section between index.html's pricing:start and
  pricing:end markers, plus the questions below.
- terms, refunds, privacy, checkout: scripts/pages/<name>.html, the
  page's text only.
"""

import re
from pathlib import Path

FRONT = Path(__file__).resolve().parent.parent / "frontend"
PAGES = Path(__file__).resolve().parent / "pages"
LEGAL = {
    # name: (title, description, noindex)
    "terms": ("Terms of Service", "The terms for using Ocean of Jobs, its API, MCP server, browser extension and paid plans.", False),
    "refunds": ("Refund Policy", "Full refund within 14 days of any payment for Ocean of Jobs plans.", False),
    "privacy": ("Privacy", "What Ocean of Jobs collects, why, and how to remove it.", False),
    "checkout": ("Checkout", "Checkout for Ocean of Jobs plans, handled by Paddle.", True),
}

FAQ = """
    <section class="home-section" aria-labelledby="faq-title">
      <div class="home-wrap">
        <h2 class="home-h2" id="faq-title">Frequently asked questions</h2>
        <div class="price-faq">
          <div class="home-feature">
            <h3>What counts as an application?</h3>
            <p>An application counts when the extension submits it. If the extension skips a job because, for example, a form asks a question you haven't answered, it won't count. Unused applications don't roll over to the next month.</p>
          </div>
          <div class="home-feature">
            <h3>Do I need an AI subscription?</h3>
            <p>No. The extension fills in forms using your profile and saved answers. Basic and Pro include AI answers to new questions. On Free, you can add your own API key from an AI provider, and any usage fees are charged by that provider.</p>
          </div>
          <div class="home-feature">
            <h3>Where is my CV stored?</h3>
            <p>Your CV file stays in the browser extension on your device and is sent to the employer when you apply. Your profile and saved answers are stored in your Ocean of Jobs account, so you can access them from another computer.</p>
          </div>
          <div class="home-feature">
            <h3>Can I cancel or get a refund?</h3>
            <p>You can cancel at any time. Your subscription remains active until the end of the period you've paid for. You're also eligible for a full refund within 14 days of any payment, subject to our <a href="/refunds">refund policy</a>.</p>
          </div>
        </div>
        <p class="price3-note"><a href="/refunds">Refund policy</a> · <a href="/terms">Terms of service</a></p>
      </div>
    </section>
"""


def shell(home: str, name: str, title: str, desc: str, main: str, noindex: bool = False) -> str:
    """The homepage around another page's main."""
    title = f"{title} | Ocean of Jobs"
    url = f"https://oceanofjobs.com/{name}"
    page = re.sub(r"<title>.*?</title>", lambda _: f"<title>{title}</title>", home, count=1)
    page = re.sub(r'(<meta name="description" content=")[^"]*', lambda m: m.group(1) + desc, page, count=1)
    page = page.replace('<link rel="canonical" href="https://oceanofjobs.com/" />', f'<link rel="canonical" href="{url}" />', 1)
    page = re.sub(r'(<meta property="og:url" content=")[^"]*', lambda m: m.group(1) + url, page, count=1)
    page = re.sub(r'(<meta (?:property="og:title"|name="twitter:title") content=")[^"]*', lambda m: m.group(1) + title, page)
    page = re.sub(r'(<meta (?:property="og:description"|name="twitter:description") content=")[^"]*', lambda m: m.group(1) + desc, page)
    if noindex:
        page = page.replace('  <meta name="description"', '  <meta name="robots" content="noindex" />\n  <meta name="description"', 1)
    # The homepage's organisation data and its stats script belong to it alone.
    page = re.sub(r"  <!-- Who this site is.*?</script>\n", "", page, count=1, flags=re.S)
    page = re.sub(r'  <main id="main" tabindex="-1">.*?  </main>',
                  lambda _: '  <main id="main" tabindex="-1">\n    <div class="price-page-top"></div>\n' + main + "  </main>",
                  page, count=1, flags=re.S)
    page = re.sub(r'(<script src="hero_nav.js"></script>\n).*?(  <script src="mobile_nav.js"></script>)',
                  lambda m: m.group(1) + m.group(2), page, count=1, flags=re.S)
    assert f"<title>{title}</title>" in page and 'getElementById("home-poll")' not in page
    return page


def main():
    home = (FRONT / "index.html").read_text(encoding="utf-8")
    section = re.search(r"    <!-- pricing:start -->\n(.*?)    <!-- pricing:end -->\n", home, re.S).group(1)
    # The section's heading is the page's h1 here.
    section = section.replace('<h2 class="home-h2" id="pricing-title">', '<h1 class="home-h2" id="pricing-title">', 1)
    section = section.replace("</h2>", "</h1>", 1)
    out = {"pricing": shell(home, "pricing", "Pricing",
                            "Ocean of Jobs is free to search. Basic and Pro add automatic job applications through the browser extension.",
                            section + FAQ)}
    for name, (title, desc, noindex) in LEGAL.items():
        text = (PAGES / f"{name}.html").read_text(encoding="utf-8")
        main = '    <section class="home-section">\n      <div class="home-wrap legal-doc">\n' + text + "      </div>\n    </section>\n"
        out[name] = shell(home, name, title, desc, main, noindex)
    for name, page in out.items():
        (FRONT / f"{name}.html").write_text(page, encoding="utf-8")
        print(f"wrote frontend/{name}.html", len(page))


if __name__ == "__main__":
    main()
