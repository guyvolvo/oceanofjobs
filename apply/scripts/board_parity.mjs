// The same board scenarios on the live board and the new one, side by side:
// the live URL shapes, keyboard, history, the deferred count, /api/facets
// calls per search, "Alert me for this search", apply-click counting, sign
// out, the outage badge and the phone tab bar. Both read the live API, GET
// only: every write (/api/event, /api/me/*) and every /api/facets and
// /api/stats answer is fulfilled here and never reaches the site.
// Selectors are ones both boards share (#f-search, #result-count,
// #jobs-body [data-id], #job-detail.open, #m-alert, ...). The new list is
// virtual, so rows are found by data-id, never by position on the page.
// usage: node scripts/board_parity.mjs [--local http://127.0.0.1:4179] [--live https://oceanofjobs.com] [--only regex] [--json file]
import { writeFileSync } from "node:fs";
import { chromium } from "../../tests/e2e/node_modules/playwright/index.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const SITES = { live: opt("--live", "https://oceanofjobs.com"), new: opt("--local", "http://127.0.0.1:4179") };
const only = opt("--only") ? new RegExp(opt("--only")) : null;
const ROWS = "#jobs-body [data-id]";
const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const EMPTY_FACETS = JSON.stringify({ categories: [], seniority: [], workplace: [], companies: [], locations: [], salary: null, salary_disclosed: 0 });

const browser = await chromium.launch({ args: ["--disable-extensions"] });

async function open(base, ctxOpts = DESKTOP, { init, facets } = {}) {
  const ctx = await browser.newContext(ctxOpts);
  await ctx.addInitScript(() => {
    try { localStorage.setItem("ooj_cookie_consent", "no"); localStorage.setItem("iljobs_geo_asked", "1"); } catch {}
  });
  if (init) await ctx.addInitScript(init);
  const seen = { facets: [], jobs: [], event: [] };
  // Writes and the heavy side calls stay here.
  await ctx.route(/\/api\/event/, (r) => { seen.event.push(r.request().url()); r.fulfill({ status: 204, body: "" }); });
  await ctx.route(/\/api\/me\//, (r) => r.fulfill({ status: 401, contentType: "application/json", body: '{"error":"Signed out"}' }));
  await ctx.route(/\/api\/(facets|stats)(\?|$)/, (r) => {
    if (/facets/.test(r.request().url())) seen.facets.push(r.request().url());
    if (facets) return facets(r);
    r.fulfill({ status: 200, contentType: "application/json", body: /facets/.test(r.request().url()) ? EMPTY_FACETS : "{}" });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  page.on("request", (r) => { if (/\/api\/jobs\?/.test(r.url())) seen.jobs.push(r.url()); });
  return { ctx, page, seen, errors };
}

async function settle(page, ms = 2000) {
  await page.waitForFunction((sel) => document.querySelector(sel) || document.querySelector("#jobs-empty:not([style*='none'])") || document.querySelector("#jobs-error:not([style*='none'])"),
    ROWS, { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(ms);
}

const state = (page) => page.evaluate((sel) => ({
  url: location.pathname + location.search,
  count: (document.querySelector("#result-count")?.textContent || "").trim().replace(/\s+/g, " "),
  rows: document.querySelectorAll(sel).length,
  pane: !!document.querySelector("#job-detail.open"),
  canonical: document.querySelector('link[rel="canonical"]')?.href || null,
}), ROWS);

const results = {};
async function scenario(name, fn) {
  if (only && !only.test(name)) return;
  results[name] = {};
  for (const [site, base] of Object.entries(SITES)) {
    try { results[name][site] = await fn(base, site); } catch (e) { results[name][site] = { error: e.message.split("\n")[0] }; }
  }
  console.log(`\n## ${name}`);
  for (const [site, r] of Object.entries(results[name])) console.log(`  ${site}: ${JSON.stringify(r)}`);
}

// 1. The audit's 29 live URL shapes: count, address after load, pane, canonical.
const firstJob = (await (await fetch(`${SITES.live}/api/jobs?confidence=all&sort=age&dir=asc&limit=1&offset=0&count=skip`, { headers: { "user-agent": "ooj-board-parity (GET only)" } })).json()).jobs[0];
const CASES = [
  "", "?roles=all", "?roles=tech", "?starred=1", `?job=${firstJob.id}`, `?company=${firstJob.company_domain}`, "?department=Data%20%26%20AI",
  "?search=python", "?search=python%20django&search_mode=any", "?search=%22data%20engineer%22&search_exact=1", "?q=python", "?q=python&keywords=django;flask",
  "?country=IL", "?israel_only=1", "?city=IL:Tel%20Aviv", "?workplace=remote", "?roles=all&workplace=remote", "?seniority=senior",
  "?salary_min=20000", "?salary_known=1", "?max_age_days=7", "?sort=company&dir=asc", "?offset=50", "?confidence=all", "?view=matches",
  "?skills=python", "?max_age_days=banana", "?sort=%3Cscript%3E", "?utm_source=x&search=react",
];
await scenario("url shapes", async (base) => {
  const out = [];
  for (const c of CASES) {
    const { ctx, page, errors } = await open(base);
    await page.goto(`${base}/board${c}`, { waitUntil: "domcontentloaded" });
    await settle(page, 2500);
    out.push({ case: c, ...(await state(page)), errors: errors.length });
    await ctx.close();
  }
  return out;
});

// 2. /api/facets per search: the page load, then typing "python".
await scenario("facets per search", async (base) => {
  const { ctx, page, seen } = await open(base);
  await page.goto(`${base}/board?roles=all`, { waitUntil: "domcontentloaded" });
  await settle(page, 4000);
  const onLoad = seen.facets.length;
  seen.facets.length = 0;
  await page.locator("#f-search").click();
  await page.keyboard.type("python", { delay: 80 });
  await page.waitForResponse((r) => /\/api\/jobs\?.*search=python/.test(r.url()), { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(6000);
  const r = { onLoad, perSearch: seen.facets.length, urls: seen.facets.map((u) => new URL(u).search) };
  await ctx.close();
  return r;
});

// 3. The deferred count with page 2 asked for at once (audit blocker 10).
await scenario("count with page 2 early", async (base) => {
  const { ctx, page, seen } = await open(base);
  await page.goto(`${base}/board?search=python`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(ROWS, { timeout: 30_000 });
  // Scroll whatever holds the rows to its end, at once and again.
  for (let i = 0; i < 6; i++) {
    await page.evaluate((sel) => {
      let el = document.querySelector(sel)?.parentElement;
      while (el && el !== document.body && !(el.scrollHeight > el.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
      (el && el !== document.body ? el : document.scrollingElement).scrollTop = 1e7;
    }, ROWS);
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(8000);
  const s = await state(page);
  const r = { url: s.url, count: s.count, offsetInUrl: /offset=/.test(s.url), plus: /\+/.test(s.count),
    pages: seen.jobs.filter((u) => !/count=only/.test(u)).map((u) => new URL(u).searchParams.get("offset")), countCalls: seen.jobs.filter((u) => /count=only/.test(u)).length };
  await ctx.close();
  return r;
});

// 4. Keyboard and history: ArrowDown twice, Back, Back, Forward, Escape.
await scenario("keyboard and history", async (base) => {
  const { ctx, page } = await open(base);
  await page.goto(`${base}/board?roles=all`, { waitUntil: "domcontentloaded" });
  await settle(page, 2500);
  const steps = [];
  const step = async (name) => { await page.waitForTimeout(1500); const s = await state(page); steps.push({ step: name, job: new URLSearchParams(s.url.split("?")[1]).get("job"), pane: s.pane, canonical: s.canonical?.replace(/^https?:\/\/[^/]+/, "") }); };
  await page.locator("body").click({ position: { x: 5, y: 600 } });
  await page.keyboard.press("ArrowDown"); await step("down");
  await page.keyboard.press("ArrowDown"); await step("down again");
  await page.goBack(); await step("back");
  await page.goBack(); await step("back again");
  await page.goForward(); await step("forward");
  await page.keyboard.press("Escape"); await step("escape");
  await ctx.close();
  return steps;
});

// 5. "Alert me for this search" on a phone: where it goes and what it hands over.
await scenario("alert me for this search", async (base) => {
  const { ctx, page } = await open(base, PHONE);
  let went = null;
  // A blank page of the same origin, so the account page's own script never reads the prefill first.
  await ctx.route(/\/account/, (r) => { went = r.request().url(); r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>account</title>" }); });
  await page.goto(`${base}/board?search=python&workplace=remote`, { waitUntil: "domcontentloaded" });
  await settle(page, 2000);
  await page.locator("#m-alert").click();
  await page.waitForTimeout(1500);
  const prefill = await page.evaluate(() => sessionStorage.getItem("iljobs_alert_prefill"));
  await ctx.close();
  const p = prefill ? JSON.parse(prefill) : null;
  return { went: went && new URL(went).pathname + new URL(went).hash, prefill: p && { search: p.search, workplace: p.workplace } };
});

// 6. Apply clicks reach count.js (as a person, not a robot; the count is caught here).
await scenario("apply click counted", async (base) => {
  // count.js counts nothing for a robot: no webdriver flag, no "Headless" in the agent.
  const ua = (await browser.version()).split("/")[1];
  const { ctx, page, seen } = await open(base, { ...DESKTOP, userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ua} Safari/537.36` }, { init: () => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    navigator.sendBeacon = undefined;
    document.addEventListener("click", (e) => { if (e.target.closest && e.target.closest("a[target=_blank]")) e.preventDefault(); });
  } });
  await page.goto(`${base}/board?job=${firstJob.id}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#job-detail.open a[target=_blank]", { timeout: 30_000 });
  await page.waitForTimeout(1500);
  const links = await page.evaluate(() => [...document.querySelectorAll("#job-detail a")].filter((a) => a.matches("a.apply-link, a.job-detail-apply, a.job-detail-source")).map((a) => a.className.split(" ")[0]));
  await page.locator("#job-detail a.job-detail-apply").first().click();
  await page.waitForTimeout(1000);
  const r = { countedLinks: links, events: seen.event.map((u) => new URL(u).searchParams.get("e")) };
  await ctx.close();
  return r;
});

// 7. Sign out on the page: stars and Best matches go with the account.
await scenario("sign out", async (base) => {
  const jwt = (o) => `x.${Buffer.from(JSON.stringify(o)).toString("base64url")}.x`;
  const token = jwt({ email: "parity@example.com", exp: 4102444800 });
  const { ctx, page } = await open(base, DESKTOP, { init: new Function(`try { if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1");
    localStorage.setItem("iljobs_auth_tokens", JSON.stringify({ id_token: "${token}", access_token: "x", refresh_token: "" }));
    localStorage.setItem("iljobs_starred", JSON.stringify(["${firstJob.id}"])); localStorage.setItem("iljobs_saved_merged", "1"); } } catch {}`) });
  await page.goto(`${base}/board?skills=python&job=${firstJob.id}`, { waitUntil: "domcontentloaded" });
  await settle(page, 3000);
  const look = () => page.evaluate(() => ({ url: location.search, saved: [...document.querySelectorAll("#job-detail button")].some((b) => b.textContent.trim() === "Saved"),
    count: (document.querySelector("#result-count")?.textContent || "").trim() }));
  const before = await look();
  await page.evaluate(() => signOut());
  await page.waitForTimeout(4000);
  const after = await look();
  await ctx.close();
  return { before, after };
});

// 8. The outage badge.
await scenario("outage badge", async (base) => {
  const { ctx, page } = await open(base);
  await ctx.route(/\/api\/pipeline-status/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ upstream: [{ service: "Parity check", effect: "a test badge" }] }) }));
  await page.goto(`${base}/board`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  const r = await page.evaluate(() => [...document.querySelectorAll(".upstream-badge")].map((b) => b.textContent.trim()));
  await ctx.close();
  return { badges: r };
});

// 9. The phone: tab bar, what overlaps, horizontal scroll.
await scenario("phone layout", async (base) => {
  const { ctx, page } = await open(base, PHONE);
  await page.goto(`${base}/board`, { waitUntil: "domcontentloaded" });
  await settle(page, 2500);
  const r = await page.evaluate(() => {
    const box = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return b.width && b.height ? b : null; };
    const hit = (a, b) => a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const search = box("#f-search"), where = box("#f-location"), filters = box("#m-filters");
    const tabs = document.querySelector('nav:has(> a[href="/account#alerts"])');
    return { overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth, tabs: tabs ? [...tabs.querySelectorAll("a")].map((a) => a.textContent.trim()) : null,
      tabsVisible: !!(tabs && tabs.getBoundingClientRect().height), overlap: !!(hit(search, where) || hit(search, filters) || hit(where, filters)) };
  });
  await ctx.close();
  return r;
});

await browser.close();
if (opt("--json")) writeFileSync(opt("--json"), JSON.stringify(results, null, 1));
