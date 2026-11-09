// First-load weight of /account and /apply, new (local preview) against
// live, the same way as apply/scripts/sizes.mjs: every same-origin script,
// module preload and stylesheet the delivered HTML names, gzip -9 in KB.
// Then the route's own lazy chunk, which the workspace loads next.
// usage: node audit/ui-overhaul/account/sizes.mjs [--local http://127.0.0.1:4178]
import { gzipSync } from "node:zlib";

const args = process.argv.slice(2);
const SITES = { new: args.includes("--local") ? args[args.indexOf("--local") + 1] : "http://127.0.0.1:4178", live: "https://oceanofjobs.com" };
const PAGES = { account: "/account", apply: "/apply" };
const get = async (url) => Buffer.from(await (await fetch(url, { headers: { "user-agent": "ooj-sizes (GET only)" } })).arrayBuffer());
const kb = (n) => Math.round(n / 102.4) / 10;
const gz = (b) => gzipSync(b, { level: 9 }).length;

console.log("| Page | Site | JS gzip | CSS gzip | JS+CSS gzip | files |");
console.log("|---|---|---|---|---|---|");
for (const [name, path] of Object.entries(PAGES)) for (const [site, base] of Object.entries(SITES)) {
  const page = new URL(path, base);
  const html = (await get(page.href)).toString("utf8");
  let js = 0, css = 0, n = 0;
  for (const m of html.matchAll(/<(script|link)\b[^>]*>/g)) {
    const tag = m[0];
    const src = /(?:src|href)="([^"]+)"/.exec(tag)?.[1];
    if (!src || /^(https?:)?\/\//.test(src)) continue;
    const isJs = (m[1] === "script" && /\bsrc=/.test(tag)) || /rel="modulepreload"/.test(tag);
    const isCss = /rel="stylesheet"/.test(tag);
    if (!isJs && !isCss) continue;
    const size = gz(await get(new URL(src, page).href));
    if (isJs) js += size; else css += size;
    n++;
  }
  console.log(`| ${name} | ${site} | ${kb(js)} | ${kb(css)} | ${kb(js + css)} | ${n} |`);
}
