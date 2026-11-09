// Board load timings, live against new, on the same live data (GET only).
// Median of N cold loads (fresh context, HTTP cache off) per profile:
//   desktop  1440x900, no throttling
//   phone    390x844, 4x CPU slowdown, Lighthouse "slow 4G" (150 ms RTT, 1.6 Mbit/s down, 750 kbit/s up)
// Measures: rows (first job row in the page), TTI-ish (the later of rows and
// the end of the last long task), TBT (long-task time over 50 ms up to rows
// + 2 s), and typing "python" into the search: last key to the first row
// changing. /api/facets and /api/stats are answered here with an empty
// body on both, so the bench adds no load to the box's slowest calls; they
// are not on the path to the rows on either board. Run the preview with
// --gzip so the local files travel compressed, as CloudFront sends them.
// usage: node scripts/board_bench.mjs [runs=5] [--local http://127.0.0.1:4179] [--live https://oceanofjobs.com] [--json file]
import { writeFileSync } from "node:fs";
import { chromium } from "../../tests/e2e/node_modules/playwright/index.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const RUNS = Number(args.find((a) => /^\d+$/.test(a)) || 5);
const TARGETS = { live: opt("--live", "https://oceanofjobs.com"), new: opt("--local", "http://127.0.0.1:4179") };
const ROWS = "#jobs-body [data-id]";
const PROFILES = {
  desktop: { ctx: { viewport: { width: 1440, height: 900 } }, cpu: 1, net: null },
  phone: { ctx: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, cpu: 4,
    net: { offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8 } },
};
const OBSERVE = () => {
  window.__b = { long: [] };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__b.long.push([e.startTime, e.duration]); }).observe({ type: "longtask", buffered: true });
};
const median = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? Math.round(s[Math.floor((s.length - 1) / 2)]) : null; };

async function run(browser, base, profile, typing) {
  const ctx = await browser.newContext(profile.ctx);
  await ctx.addInitScript(() => { try { localStorage.setItem("ooj_cookie_consent", "no"); localStorage.setItem("iljobs_geo_asked", "1"); } catch {} });
  await ctx.addInitScript(OBSERVE);
  await ctx.route(/\/api\/(facets|stats)(\?|$)/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await ctx.route(/\/api\/event/, (r) => r.fulfill({ status: 204, body: "" }));
  const p = await ctx.newPage();
  const cdp = await ctx.newCDPSession(p);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  if (profile.net) await cdp.send("Network.emulateNetworkConditions", profile.net);
  if (profile.cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpu });
  await p.goto(`${base}/board?roles=all`, { waitUntil: "commit", timeout: 120_000 });
  await p.waitForSelector(ROWS, { timeout: 120_000 });
  const rowsAt = await p.evaluate(() => performance.now());
  await p.waitForTimeout(3000);
  const m = await p.evaluate((rowsAt) => {
    const until = rowsAt + 2000;
    const long = window.__b.long.filter(([s]) => s < until);
    return { fcp: performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null, rows: rowsAt,
      tti: Math.max(rowsAt, long.reduce((a, [s, d]) => Math.max(a, s + d), 0)), tbt: long.reduce((a, [, d]) => a + Math.max(0, d - 50), 0) };
  }, rowsAt);
  if (typing) {
    const before = await p.locator(ROWS).first().getAttribute("data-id");
    await p.locator("#f-search").click();
    await p.keyboard.type("python", { delay: 60 });
    const typedAt = Date.now();
    await p.waitForFunction(([sel, before]) => document.querySelector(sel)?.getAttribute("data-id") !== before, [ROWS, before], { timeout: 60_000 }).catch(() => {});
    m.keyToRows = Date.now() - typedAt;
  }
  await ctx.close();
  return m;
}

const browser = await chromium.launch({ args: ["--disable-extensions"] });
const out = {};
for (const [pname, profile] of Object.entries(PROFILES)) for (const [tname, base] of Object.entries(TARGETS)) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    try { runs.push(await run(browser, base, profile, true)); } catch (e) { runs.push({ error: e.message.split("\n")[0] }); }
    console.error(pname, tname, i, JSON.stringify(runs[runs.length - 1]));
  }
  const med = {};
  for (const k of ["fcp", "rows", "tti", "tbt", "keyToRows"]) med[k] = median(runs.map((r) => r[k]));
  out[`${pname}/${tname}`] = { median: med, runs };
}
await browser.close();
console.log("| Profile | Board | FCP | Rows visible | TTI-ish | TBT | Keystroke to rows |");
console.log("|---|---|---|---|---|---|---|");
for (const [k, v] of Object.entries(out)) { const [p, t] = k.split("/"); const m = v.median; console.log(`| ${p} | ${t} | ${m.fcp} | ${m.rows} | ${m.tti} | ${m.tbt} | ${m.keyToRows} |`); }
if (opt("--json")) writeFileSync(opt("--json"), JSON.stringify(out, null, 1));
