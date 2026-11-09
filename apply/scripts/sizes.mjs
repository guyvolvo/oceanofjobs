// First-load weight of each page, new (local preview) against live: every
// same-origin script, module preload and stylesheet the delivered HTML
// names, raw and gzip -9 in KB. The same method as the parity audit's
// sizes.mjs, but over HTTP, so live and local are measured alike.
// usage: node scripts/sizes.mjs [--local http://127.0.0.1:4173] [--live https://oceanofjobs.com] [--pages name=/path,...] [--json file]
import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const SITES = { new: opt("--local", "http://127.0.0.1:4173"), live: opt("--live", "https://oceanofjobs.com") };
// --pages board=/board,privacy=/privacy picks the pages.
const PAGES = opt("--pages") ? Object.fromEntries(opt("--pages").split(",").map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]))
  : { privacy: "/privacy", terms: "/terms", refunds: "/refunds", contact: "/contact", "404": "/no-such-page" };

const get = async (url) => Buffer.from(await (await fetch(url, { headers: { "user-agent": "ooj-sizes (GET only)" } })).arrayBuffer());
const kb = (n) => Math.round(n / 102.4) / 10;
const size = (buf) => ({ raw: buf.length, gzip: gzipSync(buf, { level: 9 }).length });

function refs(html) {
  const out = [];
  for (const m of html.matchAll(/<(script|link)\b[^>]*>/g)) {
    const tag = m[0];
    const src = /(?:src|href)="([^"]+)"/.exec(tag)?.[1];
    if (!src || /^(https?:)?\/\//.test(src)) continue;
    if (m[1] === "script" && /\bsrc=/.test(tag)) out.push({ kind: "js", src });
    else if (/rel="stylesheet"/.test(tag)) out.push({ kind: "css", src });
    else if (/rel="modulepreload"/.test(tag)) out.push({ kind: "js", src });
  }
  return out;
}

const rows = [];
for (const [name, path] of Object.entries(PAGES)) for (const [site, base] of Object.entries(SITES)) {
  const page = new URL(path, base);
  const html = await get(page.href);
  const tot = { page: name, site, html: size(html), js: { raw: 0, gzip: 0 }, css: { raw: 0, gzip: 0 }, files: [] };
  for (const r of refs(html.toString("utf8"))) {
    const s = size(await get(new URL(r.src, page).href));
    tot[r.kind].raw += s.raw; tot[r.kind].gzip += s.gzip;
    tot.files.push({ ...r, ...s });
  }
  rows.push(tot);
}

console.log("| Page | Site | HTML gzip | JS raw / gzip | CSS raw / gzip | JS+CSS gzip |");
console.log("|---|---|---|---|---|---|");
for (const r of rows) console.log(`| ${r.page} | ${r.site} | ${kb(r.html.gzip)} | ${kb(r.js.raw)} / ${kb(r.js.gzip)} | ${kb(r.css.raw)} / ${kb(r.css.gzip)} | ${kb(r.js.gzip + r.css.gzip)} |`);
if (opt("--json")) writeFileSync(opt("--json"), JSON.stringify(rows, null, 1));
