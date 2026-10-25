"""The header on every page except the homepage, and the board's sidebar
links. One list of sections (SECTIONS), so every page links to every other
and no two bars can disagree about what the site has.

The header is the homepage's own bar (same classes, hero_nav.js for the
menus, hero_account.js for the account corner, mobile_nav.js on a phone),
wrapped in a .home scope so its styles apply unchanged. Static pages get it
from scripts/build_pages.py, between <!-- site-header --> markers; the
server-rendered pages (jobs, companies, roles) from page_chrome.topbar.
"""

from html import escape

CHEV = '<svg class="site-menu-chev" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>'

# Material Symbols paths, the set the sidebar already draws with.
ICON = {
    "jobs": "M160-120q-33 0-56.5-23.5T80-200v-440q0-33 23.5-56.5T160-720h160v-80q0-33 23.5-56.5T400-880h160q33 0 56.5 23.5T640-800v80h160q33 0 56.5 23.5T880-640v440q0 33-23.5 56.5T800-120H160Zm0-80h640v-440H160v440Zm240-520h160v-80H400v80ZM160-200v-440 440Z",
    "roles": "M360-200v-80h480v80H360Zm0-240v-80h480v80H360Zm0-240v-80h480v80H360ZM200-160q-33 0-56.5-23.5T120-240q0-33 23.5-56.5T200-320q33 0 56.5 23.5T280-240q0 33-23.5 56.5T200-160Zm0-240q-33 0-56.5-23.5T120-480q0-33 23.5-56.5T200-560q33 0 56.5 23.5T280-480q0 33-23.5 56.5T200-400Zm0-240q-33 0-56.5-23.5T120-720q0-33 23.5-56.5T200-800q33 0 56.5 23.5T280-720q0 33-23.5 56.5T200-640Z",
    "companies": "M80-120v-720h400v160h400v560H80Zm80-80h240v-80H160v80Zm0-160h240v-80H160v80Zm0-160h240v-80H160v80Zm0-160h240v-80H160v80Zm320 480h320v-400H480v400Zm80-240v-80h160v80H560Zm0 160v-80h160v80H560Z",
    "stats": "m140-220-60-60 300-300 160 160 284-320 56 56-340 384-160-160-240 240Z",
    "apply": "M120-160v-640l760 320-760 320Zm80-120 474-200-474-200v140l240 60-240 60v140Zm0 0v-400 400Z",
    "docs": "M320-240h320v-80H320v80Zm0-160h320v-80H320v80ZM240-80q-33 0-56.5-23.5T160-160v-640q0-33 23.5-56.5T240-880h320l240 240v480q0 33-23.5 56.5T720-80H240Zm280-520v-200H240v640h480v-440H520ZM240-800v200-200 640-640Z",
    "pricing": "M856-390 570-104q-12 12-27 18t-30 6q-15 0-30-6t-27-18L103-457q-11-11-17-25.5T80-513v-287q0-33 23.5-56.5T160-880h287q16 0 31 6.5t26 17.5l352 353q12 12 17.5 27t5.5 30q0 15-5.5 29.5T856-390ZM513-160l286-286-353-354H160v286l353 354ZM260-640q25 0 42.5-17.5T320-700q0-25-17.5-42.5T260-760q-25 0-42.5 17.5T200-700q0 25 17.5 42.5T260-640Zm220 160Z",
}

# The docs menu's own icons, as the homepage draws them.
DOC_ICON = {
    "/docs/api": '<svg class="site-menu-icon" viewBox="0 -960 960 960" aria-hidden="true"><path d="M320-240 80-480l240-240 57 57-184 184 183 183-56 56Zm320 0-57-57 184-184-183-183 56-56 240 240-240 240Z"/></svg>',
    "/docs/mcp": '<svg class="site-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M13.85 0a4.16 4.16 0 0 0-2.95 1.217L1.456 10.66a.835.835 0 0 0 0 1.18.835.835 0 0 0 1.18 0l9.442-9.442a2.49 2.49 0 0 1 3.541 0 2.49 2.49 0 0 1 0 3.541L8.59 12.97l-.1.1a.835.835 0 0 0 0 1.18.835.835 0 0 0 1.18 0l.1-.098 7.03-7.034a2.49 2.49 0 0 1 3.542 0l.049.05a2.49 2.49 0 0 1 0 3.54l-8.54 8.54a1.96 1.96 0 0 0 0 2.755l1.753 1.753a.835.835 0 0 0 1.18 0 .835.835 0 0 0 0-1.18l-1.753-1.753a.266.266 0 0 1 0-.394l8.54-8.54a4.185 4.185 0 0 0 0-5.9l-.05-.05a4.16 4.16 0 0 0-2.95-1.218c-.2 0-.401.02-.6.048a4.17 4.17 0 0 0-1.17-3.552A4.16 4.16 0 0 0 13.85 0m0 3.333a.84.84 0 0 0-.59.245L6.275 10.56a4.186 4.186 0 0 0 0 5.902 4.186 4.186 0 0 0 5.902 0L19.16 9.48a.835.835 0 0 0 0-1.18.835.835 0 0 0-1.18 0l-6.985 6.984a2.49 2.49 0 0 1-3.54 0 2.49 2.49 0 0 1 0-3.54l6.983-6.985a.835.835 0 0 0 0-1.18.84.84 0 0 0-.59-.245"/></svg>',
    "/docs/extension": '<svg class="site-menu-icon" viewBox="0 -960 960 960" aria-hidden="true"><path d="M352-120H200q-33 0-56.5-23.5T120-200v-152q48 0 84-30.5t36-77.5q0-47-36-77.5T120-568v-152q0-33 23.5-56.5T200-800h160q0-42 29-71t71-29q42 0 71 29t29 71h160q33 0 56.5 23.5T800-720v160q42 0 71 29t29 71q0 42-29 71t-71 29v160q0 33-23.5 56.5T720-120H568q0-50-31.5-85T460-240q-45 0-76.5 35T352-120Z"/></svg>',
}

# (key, label, href or [(item, href)]). A list is a menu; a string is a link.
SECTIONS = [
    ("jobs", "Jobs", [("All jobs", "/board?roles=all"), ("Tech jobs", "/board?roles=tech"), ("Remote jobs", "/board?roles=all&workplace=remote"),
                      ("Jobs by role", "/jobs"), ("Saved jobs", "/board?starred=1")]),
    ("companies", "Companies", [("Directory", "/companies"), ("A to Z", "/companies/a"), ("Statistics", "/stats")]),
    ("docs", "Docs", [("API", "/docs/api"), ("MCP", "/docs/mcp"), ("Extension", "/docs/extension")]),
    ("pricing", "Pricing", "/pricing"),
    ("contact", "Contact", "/contact"),
]

# The sidebar on the board and companies pages: the same sections, one
# link each, to the section's main page.
SIDE = [("jobs", "Jobs", "/board"), ("roles", "Jobs by role", "/jobs"), ("companies", "Companies", "/companies"),
        ("stats", "Statistics", "/stats"), ("apply", "Auto apply", "/apply"), ("docs", "Docs", "/docs"), ("pricing", "Pricing", "/pricing")]


def header(current: str = "") -> str:
    """The bar. `current` is a SECTIONS key; its menu or link is marked."""
    parts = []
    for key, label, target in SECTIONS:
        here = key == current
        if isinstance(target, str):
            parts.append(f'<a class="site-menu-link" href="{target}"{" aria-current=\"page\"" if here else ""}>{label}</a>')
            continue
        items = "".join(
            f'<a class="site-menu-item{" site-menu-item-icon" if href in DOC_ICON else ""}" href="{escape(href)}">'
            f'<span class="site-menu-name">{name}</span>{DOC_ICON.get(href, "")}</a>' for name, href in target)
        parts.append(f'<div class="site-menu{" is-current" if here else ""}" data-menu="{key}">'
                     f'<button type="button" class="site-menu-btn" aria-expanded="false" aria-controls="site-menu-{key}">{label}{CHEV}</button>'
                     f'<div class="site-menu-panel" id="site-menu-{key}" hidden>{items}</div></div>')
    return f"""<div class="home site-header">
  <header class="home-bar hero-bar-head">
    <a class="home-brand" href="/" aria-label="Ocean of Jobs home">
      <img class="home-mark" src="/favicon.svg?v=3" width="22" height="22" alt="" />
      <span translate="no">Ocean of Jobs</span>
    </a>
    <nav class="site-menus home-nav" aria-label="Main">{"".join(parts)}</nav>
    <div class="hero-bar-right" id="hero-bar-right">
      <button type="button" class="hero-theme" id="hero-theme">Dark</button>
      <div class="hero-account" id="hero-account"><a class="hero-bar-name" href="/account">Log in</a></div>
      <script>
        // Signed in: say so before hero_account.js loads, so a reload doesn't flash Log in.
        try {{
          if ((JSON.parse(localStorage.getItem("iljobs_auth_tokens") || "null") || {{}}).id_token) {{
            document.querySelector("#hero-account .hero-bar-name").textContent = "My account";
            document.getElementById("hero-theme").hidden = true;
          }}
        }} catch (e) {{}}
      </script>
    </div>
  </header>
</div>"""


def side(current: str = "") -> str:
    """The sidebar's primary links, in its existing markup."""
    links = "".join(
        f'<a href="{href}"{" class=\"current\" aria-current=\"page\"" if key == current else ""} title="{label}">'
        f'<svg viewBox="0 -960 960 960" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="{ICON[key]}"/></svg>'
        f"<span>{label}</span></a>" for key, label, href in SIDE)
    return f'<nav class="side-group side-nav" aria-label="Primary">{links}</nav>'


# The scripts the header needs, for pages that don't load them yet.
SCRIPTS = ["/auth.js", "/signin_dialog.js", "/hero_account.js", "/hero_nav.js", "/mobile_nav.js"]
