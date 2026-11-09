// Screenshots of each migrated page, old (live) against new (local
// preview), light and dark, desktop 1440 and phone 390, plus what a phone
// width does to the page (horizontal overflow) and any console errors on
// the new page (a hydration mismatch shows up there).
// usage: node scripts/shots.mjs <out dir> [--local http://127.0.0.1:4173] [--live https://oceanofjobs.com] [--pages pricing,checkout]
// Needs Playwright from tests/e2e (cd tests/e2e && npm ci).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "../../tests/e2e/node_modules/playwright/index.mjs";

const args = process.argv.slice(2);
const out = args[0];
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const SITES = { live: opt("--live", "https://oceanofjobs.com"), new: opt("--local", "http://127.0.0.1:4173") };
const PAGES = { home: "/", privacy: "/privacy", terms: "/terms", refunds: "/refunds", contact: "/contact", "404": "/this-page-does-not-exist", "404-job": "/jobs/senior-backend-engineer-0a1b2c3d4e", pricing: "/pricing", checkout: "/checkout?plan=basic", "checkout-none": "/checkout" };
const VIEWS = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } };

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const report = [];
for (const [view, vp] of Object.entries(VIEWS)) for (const theme of ["light", "dark"]) for (const [site, base] of Object.entries(SITES)) {
  const { width, height, ...rest } = vp;
  const ctx = await browser.newContext({ viewport: { width, height }, ...rest });
  // No cookie banner over the page, and the theme chosen before first paint.
  await ctx.addInitScript((t) => { localStorage.setItem("ooj_cookie_consent", "no"); localStorage.setItem("iljobs_theme", t); }, theme);
  for (const [name, path] of Object.entries(PAGES).filter(([n]) => !opt("--pages", "") || opt("--pages", "").split(",").includes(n))) {
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    await page.goto(base + path, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    const m = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    const file = `${name}-${view}-${theme}-${site}.jpg`;
    await page.screenshot({ path: join(out, file), type: "jpeg", quality: 72, fullPage: true });
    report.push({ page: name, view, theme, site, file, overflowX: m.scrollWidth > m.clientWidth, ...m, errors });
    console.log(file, m.scrollWidth > m.clientWidth ? "OVERFLOW" : "", errors.length ? `errors: ${errors.join(" | ")}` : "");
    await page.close();
  }
  await ctx.close();
}
await browser.close();
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 1));
