"""What a crawler that runs no JavaScript gets from each page, new against live.

Fetches every page's delivered HTML with a plain GET (no browser, no JS) from
the local preview and from the live site, and prints, per page: words in
<body>, links, canonical, title, meta description, robots, JSON-LD blocks and
how much of the live <main> text the new <main> carries word for word.

usage: python apply/scripts/nojs_check.py [--local URL] [--live URL] [--json FILE] [path ...]
       defaults: --local http://127.0.0.1:4173 --live https://oceanofjobs.com,
       paths /privacy /terms /refunds /contact /404-check

Exit status 1 when a new page has no canonical where live has one, a different
title or description, fewer internal links, or under 99% of live's <main>
words (live <main> that is empty without JS counts as matched).
"""
import argparse
import difflib
import json
import re
import sys
import urllib.error
import urllib.request
from html.parser import HTMLParser

SKIP = {"script", "style", "noscript", "template", "svg"}
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}


class Page(HTMLParser):
    def __init__(self, origin):
        super().__init__(convert_charrefs=True)
        self.origin = origin
        self.stack = []
        self.body_words, self.main_words = [], []
        self.links, self.internal = [], 0
        self.meta, self.canonical, self.title, self.jsonld, self.h1 = {}, None, "", 0, 0
        self._title = False
        self._script_type = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "title":
            self._title = True
        elif tag == "meta" and (a.get("name") or a.get("property")):
            self.meta[a.get("name") or a.get("property")] = a.get("content") or ""
        elif tag == "link" and a.get("rel") == "canonical":
            self.canonical = a.get("href")
        elif tag == "script" and a.get("type") == "application/ld+json":
            self.jsonld += 1
        elif tag == "a" and a.get("href") is not None:
            href = a["href"]
            self.links.append(href)
            # Cloudflare rewrites every mailto: on the live site into a
            # /cdn-cgi/l/email-protection link; it is an email, not a page.
            if href.startswith("/cdn-cgi/l/email-protection"):
                pass
            elif href.startswith("/") and not href.startswith("//") or href.startswith(self.origin):
                self.internal += 1
        elif tag == "h1":
            self.h1 += 1
        if tag not in VOID:
            self.stack.append(tag)

    def handle_endtag(self, tag):
        if tag == "title":
            self._title = False
        if tag in self.stack:
            while self.stack and self.stack.pop() != tag:
                pass

    def handle_data(self, data):
        if self._title:
            self.title += data
            return
        if "body" not in self.stack or SKIP & set(self.stack):
            return
        # ...and its text into "[email protected]": both sides count an address as one word.
        data = re.sub(r"\[email\s+protected\]|[^\s@]+@[^\s@]+\.[a-z]{2,}", "<email>", data)
        words = [w for w in data.split() if re.search(r"\w", w)]
        self.body_words += words
        if "main" in self.stack:
            self.main_words += words


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "ooj-nojs-check/1 (GET only)"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:  # the 404 page is a 404 with a body
        return e.code, e.read().decode("utf-8", "replace")


def measure(base, path, origin):
    status, html = fetch(base.rstrip("/") + path)
    p = Page(origin)
    p.feed(html)
    return {
        "status": status, "bytes": len(html.encode()), "words": len(p.body_words), "main_words": p.main_words,
        "links": len(p.links), "internal": p.internal, "canonical": p.canonical, "title": p.title.strip(),
        "description": p.meta.get("description"), "robots": p.meta.get("robots"), "og:url": p.meta.get("og:url"),
        "jsonld": p.jsonld, "h1": p.h1,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--local", default="http://127.0.0.1:4173")
    ap.add_argument("--live", default="https://oceanofjobs.com")
    ap.add_argument("--json")
    ap.add_argument("paths", nargs="*", default=["/privacy", "/terms", "/refunds", "/contact", "/404-check", "/pricing", "/checkout"])
    args = ap.parse_args()
    origin = "https://oceanofjobs.com"
    rows, bad = [], []
    for path in args.paths:
        new, old = measure(args.local, path, origin), measure(args.live, path, origin)
        sm = difflib.SequenceMatcher(None, old["main_words"], new["main_words"], autojunk=False)
        kept = sum(b.size for b in sm.get_matching_blocks())
        match = 1.0 if not old["main_words"] else kept / len(old["main_words"])
        for site, m in (("new", new), ("live", old)):
            rows.append({"page": path, "site": site, **{k: v for k, v in m.items() if k != "main_words"},
                         "main_words": len(m["main_words"]), "main_match": round(match, 4) if site == "new" else None})
        why = []
        if new["status"] != old["status"]:
            why.append(f"status {new['status']} vs {old['status']}")
        if old["canonical"] and new["canonical"] != old["canonical"]:
            why.append(f"canonical {new['canonical']} vs {old['canonical']}")
        for k in ("title", "description", "robots", "og:url"):
            if new[k] != old[k]:
                why.append(f"{k} {new[k]!r} vs {old[k]!r}")
        if new["jsonld"] < old["jsonld"]:
            why.append("JSON-LD missing")
        if new["internal"] < old["internal"]:
            why.append(f"internal links {new['internal']} < {old['internal']}")
        if match < 0.99:
            why.append(f"main text {match:.1%} of live")
        if why:
            bad.append((path, why))

    cols = ["page", "site", "status", "words", "main_words", "main_match", "internal", "links", "jsonld", "h1", "canonical", "title", "description", "robots"]
    print("| " + " | ".join(cols) + " |")
    print("|" + "---|" * len(cols))
    for r in rows:
        print("| " + " | ".join("" if r[c] is None else str(r[c]) for c in cols) + " |")
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(rows, f, indent=1)
    for path, why in bad:
        print(f"FAIL {path}: " + "; ".join(why))
    if not bad:
        print("OK: every page matches live without JS")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
