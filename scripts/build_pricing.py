"""Writes frontend/pricing.html from frontend/index.html.

The pricing section lives once, in index.html between the pricing:start
and pricing:end markers. /pricing is the same page shell (head, header,
footer) around that section and the questions below it, so the two can
never look different. Run after editing either:

    python scripts/build_pricing.py
"""

import re
from pathlib import Path

FRONT = Path(__file__).resolve().parent.parent / "frontend"
TITLE = "Pricing | Ocean of Jobs"
DESC = "Ocean of Jobs is free to search. Basic and Pro add automatic job applications through the browser extension."

FAQ = """
    <section class="home-section" aria-labelledby="faq-title">
      <div class="home-wrap">
        <h2 class="home-h2" id="faq-title">Questions</h2>
        <div class="price-faq">
          <div class="home-feature">
            <h3>What counts as an application?</h3>
            <p>One counts when the extension submits it. A job it skips, for example because the form asks something it has no answer for, doesn't count. Unused applications don't carry over to the next month.</p>
          </div>
          <div class="home-feature">
            <h3>Do I need an AI subscription?</h3>
            <p>No. The extension fills in forms from your profile and the answers you save. You can add your own key from an AI provider so it can draft answers to new questions, and the provider bills you for its use.</p>
          </div>
          <div class="home-feature">
            <h3>Where does my CV go?</h3>
            <p>Only to the employer you're applying to. The CV file stays in the extension on your device. Your application profile and saved answers are kept in your account, so they follow you to any computer.</p>
          </div>
          <div class="home-feature">
            <h3>Can I cancel or get a refund?</h3>
            <p>Cancel any time, and your plan runs to the end of the month you paid for. You can get a full refund within 14 days of any payment.</p>
            <div class="home-feature-links"><a href="/refunds">Refund policy</a><a href="/terms">Terms of service</a></div>
          </div>
        </div>
      </div>
    </section>
"""


def main():
    home = (FRONT / "index.html").read_text(encoding="utf-8")
    section = re.search(r"    <!-- pricing:start -->\n(.*?)    <!-- pricing:end -->\n", home, re.S).group(1)
    # The section's heading is the page's h1 here.
    section = section.replace('<h2 class="home-h2" id="pricing-title">', '<h1 class="home-h2" id="pricing-title">', 1)
    section = section.replace("</h2>", "</h1>", 1)
    page = home
    page = re.sub(r"<title>.*?</title>", f"<title>{TITLE}</title>", page, count=1)
    page = re.sub(r'(<meta name="description" content=")[^"]*', rf"\g<1>{DESC}", page, count=1)
    page = page.replace('<link rel="canonical" href="https://oceanofjobs.com/" />', '<link rel="canonical" href="https://oceanofjobs.com/pricing" />', 1)
    page = re.sub(r'(<meta property="og:url" content=")[^"]*', r"\g<1>https://oceanofjobs.com/pricing", page, count=1)
    page = re.sub(r'(<meta (?:property="og:title"|name="twitter:title") content=")[^"]*', rf"\g<1>{TITLE}", page)
    page = re.sub(r'(<meta (?:property="og:description"|name="twitter:description") content=")[^"]*', rf"\g<1>{DESC}", page)
    # The homepage's organisation data and its stats script belong to it alone.
    page = re.sub(r"  <!-- Who this site is.*?</script>\n", "", page, count=1, flags=re.S)
    page = re.sub(r'  <main id="main" tabindex="-1">.*?  </main>',
                  '  <main id="main" tabindex="-1">\n    <div class="price-page-top"></div>\n' + section + FAQ + "  </main>",
                  page, count=1, flags=re.S)
    page = re.sub(r'(<script src="hero_nav.js"></script>\n).*?(  <script src="mobile_nav.js"></script>)', r"\1\2", page, count=1, flags=re.S)
    assert "pricing-title" in page and "getElementById(\"home-poll\")" not in page
    (FRONT / "pricing.html").write_text(page, encoding="utf-8")
    print("wrote frontend/pricing.html", len(page))


if __name__ == "__main__":
    main()
