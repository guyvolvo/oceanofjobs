// Renders the link preview card (og.jpg) with the board's live counts.
//
// Reads the same stats.json the homepage reads, fills template.html, and
// screenshots the 1200 x 630 card as a JPEG. Run daily by
// .github/workflows/og-image.yml; runnable by hand too:
//
//   node scripts/og_image/render.mjs [out.jpg]
//
// Refuses to write a card with missing numbers: a preview reading
// "0 open jobs" is worse than yesterday's.
import { chromium } from "playwright";
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(process.argv[2] || "og.jpg");
const STATS_URL = process.env.STATS_URL || "https://oceanofjobs.com/stats.json";

const res = await fetch(STATS_URL, { headers: { "cache-control": "no-cache" } });
if (!res.ok) throw new Error(`stats.json: HTTP ${res.status}`);
const stats = await res.json();
const t = stats.totals || {};
const remote = ((stats.workplace || []).find((w) => w.workplace === "remote") || {}).n;
const counts = { jobs: t.open_jobs, remote, companies: t.companies_hiring };
for (const [k, v] of Object.entries(counts)) {
  if (!Number.isFinite(v) || v <= 0) throw new Error(`stats.json has no usable ${k}: ${v}`);
}
const fmt = (n) => Number(n).toLocaleString("en-US");

let html = readFileSync(join(HERE, "template.html"), "utf8");
for (const [k, v] of Object.entries(counts)) html = html.replace(`{{${k}}}`, fmt(v));
// Written beside the template so its relative font and photo paths resolve.
const page = join(HERE, "_card.html");
writeFileSync(page, html);

const browser = await chromium.launch();
try {
  const tab = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await tab.goto(pathToFileURL(page).href);
  await tab.evaluate(() => document.fonts.ready);
  const fonts = await tab.evaluate(() => document.fonts.check('500 112px "Geist"') && document.fonts.check('400 26px "Geist"'));
  if (!fonts) throw new Error("Geist did not load; refusing to render in a fallback face");
  await tab.locator(".card").screenshot({ path: OUT, type: "jpeg", quality: 88 });
} finally {
  await browser.close();
  unlinkSync(page);
}
console.log(`wrote ${OUT}: ${fmt(counts.jobs)} jobs, ${fmt(counts.remote)} remote, ${fmt(counts.companies)} companies`);
