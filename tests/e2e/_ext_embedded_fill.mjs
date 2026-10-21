// Forms embedded from another site, and the fill button, on live pages
// with our API stubbed. Every write that would leave the browser for
// anywhere but oceanofjobs.com is aborted and logged, CV uploads to S3 get
// a stub answer, and nothing ever presses a form's submit: no application
// is sent.
//  a. www.comeet.com, form in a www.comeet.co iframe: one fillTab fills it
//     where it is, with no navigation.
//  b. With access to every site: a company careers page that embeds Comeet
//     fills in one call, and the fill button shows on it.
//  c. The fill button: on ATS pages with a form, top right, and clicking
//     it fills; not on oceanofjobs.com, Google search or a news page, even
//     with access to every site.
//  d. Without that access, on a site outside the host list: fillTab works
//     as before on the page activeTab grants, and no button shows.
// Run from the repo root: node tests/e2e/_ext_embedded_fill.mjs [out-dir]
import { chromium } from "playwright";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const out = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "ooj-embedded-out-"));
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Some careers sites answer 403 to a user agent that says headless.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const CYERA = "https://www.comeet.com/jobs/cyera/17.008/customer-success-engineer---rest-of-west/3E.46C";
const CELLEBRITE = "https://cellebrite.com/en/about/careers/positions/?comeet_cat=usa-remote&comeet_pos=A3.47A&comeet_all=all";
// An open job's form page from our API: one API call, then up to four
// postings tried one at a time, since listings close.
async function liveForm(ats, suffix) {
  const res = await fetch(`https://oceanofjobs.com/api/jobs?ats=${ats}&limit=8&count=skip`, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(30000) });
  const { jobs = [] } = await res.json();
  for (const j of jobs.slice(0, 4)) {
    const url = j.url.replace(/\/$/, "") + suffix;
    const page = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) }).catch(() => null);
    // A redirect to a custom domain leaves the host permissions behind.
    if (page && page.ok && new URL(page.url).hostname === new URL(url).hostname && !/404|not found/i.test((/<title>([^<]*)/i.exec(await page.text()) || [])[1] || "")) return url;
    await sleep(1500);
  }
  throw new Error(`no open ${ats} form`);
}
const LEVER = await liveForm("lever", "/apply");
await sleep(3000);
const TEAMTAILOR = await liveForm("teamtailor", "/applications/new");
const RECRUITEE_OWN_DOMAIN = "https://careers.patsnap.com/o/it-support-analyst";
const NO_BUTTON = ["https://oceanofjobs.com/", "https://www.google.com/search?q=software+engineer+jobs", "https://www.bbc.com/news", "https://www.theguardian.com/technology"];

const profile = {
  contact: { first_name: "Test", last_name: "Person", email: "test.person@example.com", phone: "+972 50 000 0000", location: "Tel Aviv, Israel" },
  links: { linkedin: "https://www.linkedin.com/in/test-person", github: "", website: "" },
  work: { authorized_countries: ["IL"], needs_sponsorship: true, notice_period: "30 days", salary: "100000" },
  eeo: { gender: "decline", race: "decline", veteran: "decline", disability: "decline" },
  answers: [{ question: "How did you hear about us?", answer: "LinkedIn" }],
  settings: { mode: "queue", sources: ["board", "ats_pages"], unknowns: "skip", guardrails: { min_match: null, daily_limit: null, blocked_companies: [], one_per_company_days: null } },
};
const pdf = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF";

// A copy of the extension whose manifest gets extra host permissions:
// "https://*/*" for the optional access once granted, or one origin for
// what activeTab grants when the user opens the popup on that page.
function copyWith(hosts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ooj-ext-embedded-"));
  fs.cpSync(path.resolve("extension"), dir, { recursive: true });
  const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  m.host_permissions.push(...hosts);
  m.optional_host_permissions = m.optional_host_permissions.filter((h) => !hosts.includes(h));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(m));
  return dir;
}

let log = null;
async function launch(ext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ooj-ext-embedded-profile-"));
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: "chromium", headless: true, viewport: { width: 1280, height: 900 }, userAgent: UA,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  await ctx.addInitScript(() => {
    const none = { register: () => Promise.reject(new Error("blocked in this test")), getRegistrations: async () => [], getRegistration: async () => undefined,
      ready: new Promise(() => {}), controller: null, addEventListener() {}, removeEventListener() {} };
    try { Object.defineProperty(Navigator.prototype, "serviceWorker", { get: () => none, configurable: true }); } catch { /* already gone */ }
  });
  await ctx.route("**/*", (r) => {
    const req = r.request();
    const u = new URL(req.url());
    if (u.hostname === "oceanofjobs.com" && u.pathname.startsWith("/api/")) {
      const p = u.pathname;
      if (p.startsWith("/api/me/apply/")) log && log.api.push(p);
      if (p === "/api/me/apply/profile") return r.fulfill({ json: { profile, preferences: { skills: ["Python"] } } });
      if (p === "/api/me/apply/usage" || p === "/api/me/apply/summary") return r.fulfill({ json: { plan: "pro", period: "day", limit: 50, used: 0, remaining: 50 } });
      if (p === "/api/me/apply/history") return r.fulfill({ json: { applied: [] } });
      if (p === "/api/me/apply/draft") {
        const body = req.postDataJSON();
        return r.fulfill({ json: { answer: body.options.length ? body.options[0] : "Test answer" } });
      }
      if (p === "/api/me/apply/claim") { log && log.claims.push(p); return r.fulfill({ json: { remaining: 49 } }); }
      return r.fulfill({ status: 204, body: "" });
    }
    if (req.method() === "POST" && /\.s3[.-]([a-z0-9-]+\.)?amazonaws\.com$/.test(u.hostname)) {
      log && log.blocked.push(`stubbed POST ${u.hostname}${u.pathname}`.slice(0, 140));
      const key = /name="key"\r\n\r\n([^\r]*)/.exec((req.postDataBuffer() || "").toString("latin1"));
      return r.fulfill({ status: 201, contentType: "application/xml",
        body: `<?xml version="1.0" encoding="UTF-8"?><PostResponse><Location>${u.origin}/${key && key[1]}</Location><Key>${key && key[1]}</Key><ETag>"0"</ETag></PostResponse>` });
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method()) && u.hostname !== "oceanofjobs.com") {
      log && log.blocked.push(`${req.method()} ${u.hostname}${u.pathname}`.slice(0, 140));
      return r.abort();
    }
    return r.continue();
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
  await sw.evaluate(async (data) => {
    await chrome.storage.local.set({ token: "ooj_test.00000000.x", cv: { name: "Test_Person_CV.pdf", type: "application/pdf", size: data.length, data: btoa(data) } });
    await chrome.alarms.clearAll();
    // Keep what the fill button's fill returned, for the results.
    const inner = assist;
    assist = async (...a) => (globalThis.__assist = await inner(...a));
  }, pdf);
  // onInstalled registers the every-site script; give it a moment.
  await sleep(1500);
  for (const p of ctx.pages()) await p.close();
  return { ctx, sw };
}

// What the frames of the tab hold afterwards.
async function holds(tab) {
  const res = { where: [] };
  for (const f of tab.frames()) {
    const got = await f.evaluate(() => {
      const vals = [...document.querySelectorAll("input, textarea")].map((el) => (el.type === "file" ? "" : el.value || ""));
      const has = (s) => vals.some((v) => v.replace(/[\s-]/g, "").includes(s.replace(/[\s-]/g, "")));
      return { email: has("test.person@example.com"), name: has("Test"), phone: has("0000000"),
        cv: [...document.querySelectorAll('input[type="file"]')].some((el) => el.files && el.files.length) || document.body.innerText.includes("Test_Person_CV") };
    }).catch(() => ({}));
    if (got.email) res.where.push(new URL(f.url()).hostname);
    for (const k of ["email", "name", "phone", "cv"]) res[k] = res[k] || !!got[k];
  }
  return res;
}

// The fill button's box on the page, in page coordinates, from whichever
// frame shows it.
async function button(tab) {
  for (const f of tab.frames()) {
    const box = await f.evaluate(() => {
      const el = document.querySelector("[data-ooj-fill]");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, right: document.documentElement.clientWidth - r.right };
    }).catch(() => null);
    if (!box) continue;
    if (f !== tab.mainFrame()) {
      const at = await (await f.frameElement()).boundingBox();
      box.x += at.x; box.y += at.y; box.frame = new URL(f.url()).hostname;
    }
    return box;
  }
  return null;
}

async function fillTabNow(sw, prefix) {
  return sw.evaluate(async (prefix) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url && t.url.startsWith(prefix)) || tabs.sort((a, b) => b.id - a.id)[0];
    const res = await fillTab(tab.id);
    return res;
  }, prefix);
}

const rows = [];
function row(part, url, r, extra = {}) {
  const x = { part, host: new URL(url).hostname, ...extra, error: r && r.error, filled: r && r.filled, errors: r && r.errors, missing: r && r.missing, blocked: log.blocked, claims: log.claims.length };
  rows.push(x);
  console.log(`\n== ${part} ${url}`);
  console.log(JSON.stringify({ ...x, blocked: x.blocked.length }));
}

async function open(ctx, url, wait = 4000) {
  const tab = await ctx.newPage();
  const navs = [];
  await tab.goto(url, { waitUntil: "load", timeout: 45000 });
  tab.on("framenavigated", (f) => { if (f === tab.mainFrame()) navs.push(f.url()); });
  await sleep(wait);
  return { tab, navs };
}

const slug = (s) => s.replace(/[^a-z0-9]+/gi, "_").slice(0, 40);

// a and c with the extension as shipped.
{
  const { ctx, sw } = await launch(path.resolve("extension"));

  log = { api: [], blocked: [], claims: [] };
  {
    const { tab, navs } = await open(ctx, CYERA);
    const r = await fillTabNow(sw, "https://www.comeet.com/");
    await sleep(1500);
    const held = await holds(tab);
    await tab.screenshot({ path: path.join(out, "a-cyera.png"), fullPage: true }).catch(() => {});
    row("a", CYERA, r, { held, navigations: navs.length, stayed: tab.url() === CYERA });
    await tab.close();
  }
  await sleep(3000);

  for (const url of [LEVER, TEAMTAILOR]) {
    log = { api: [], blocked: [], claims: [] };
    const { tab } = await open(ctx, url, 7000);
    const box = await button(tab);
    let r = null;
    const api = log.api.length;
    if (box) {
      await tab.screenshot({ path: path.join(out, `c-${slug(new URL(url).hostname)}-collapsed.png`) });
      await tab.mouse.click(box.x + box.w / 2, box.y + box.h / 2);
      await sleep(1200);
      const card = await button(tab);
      await tab.screenshot({ path: path.join(out, `c-${slug(new URL(url).hostname)}-expanded.png`) });
      // The card's fill button sits above its "Hide on ..." line.
      await tab.mouse.click(card.x + card.w / 2, card.y + card.h - 62);
      for (let i = 0; i < 40 && !(await holds(tab)).email; i++) await sleep(500);
      await sleep(2000);
      await tab.screenshot({ path: path.join(out, `c-${slug(new URL(url).hostname)}-filled.png`) });
      r = (await sw.evaluate(() => globalThis.__assist)) || { error: "the button filled nothing" };
    }
    const held = await holds(tab);
    row("c", url, r, { button: box ? `top ${Math.round(box.y)} right ${Math.round(box.right)}${box.frame ? " in " + box.frame : ""}` : "none", apiBeforeClick: api, held });
    await tab.close();
    await sleep(3000);
  }
  await ctx.close();
}

// b and c's pages without a button, with access to every site.
{
  const { ctx, sw } = await launch(copyWith(["https://*/*"]));
  const registered = await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts().then((s) => s.map((x) => x.id)));
  console.log("registered content scripts with every-site access:", JSON.stringify(registered));

  log = { api: [], blocked: [], claims: [] };
  {
    const { tab, navs } = await open(ctx, CELLEBRITE, 8000);
    const box = await button(tab);
    if (box) await tab.screenshot({ path: path.join(out, "b-cellebrite-button.png") });
    const r = await fillTabNow(sw, "https://cellebrite.com/");
    await sleep(1500);
    const held = await holds(tab);
    await tab.screenshot({ path: path.join(out, "b-cellebrite.png"), fullPage: true }).catch(() => {});
    row("b", CELLEBRITE, r, { held, navigations: navs.length, stayed: tab.url() === CELLEBRITE, registered,
      button: box ? `top ${Math.round(box.y)} right ${Math.round(box.right)}${box.frame ? " in " + box.frame : ""}` : "none" });
    await tab.close();
  }
  await sleep(3000);

  for (const url of NO_BUTTON) {
    log = { api: [], blocked: [], claims: [] };
    const { tab } = await open(ctx, url, 8000);
    // A click anywhere makes detect.js look again.
    await tab.mouse.click(640, 450).catch(() => {});
    await sleep(2500);
    const box = await button(tab);
    await tab.screenshot({ path: path.join(out, `c-none-${slug(new URL(url).hostname)}.png`) });
    row("c", url, null, { button: box ? "SHOWN" : "none", apiCalls: log.api.length });
    await tab.close();
    await sleep(3000);
  }
  await ctx.close();
}

// d: no every-site access. activeTab is what opening the popup grants, so
// the page's own origin stands in for it.
{
  const origin = new URL(RECRUITEE_OWN_DOMAIN).origin;
  const { ctx, sw } = await launch(copyWith([origin + "/*"]));
  const registered = await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts().then((s) => s.map((x) => x.id)));
  log = { api: [], blocked: [], claims: [] };
  const { tab, navs } = await open(ctx, RECRUITEE_OWN_DOMAIN, 6000);
  const box = await button(tab);
  const r = await fillTabNow(sw, origin);
  await sleep(1500);
  const held = await holds(tab);
  await tab.screenshot({ path: path.join(out, "d-own-domain.png"), fullPage: true }).catch(() => {});
  row("d", RECRUITEE_OWN_DOMAIN, r, { held, navigations: navs.length, registered, button: box ? "SHOWN" : "none" });
  await tab.close();
  await ctx.close();
}

// And with no access at all (the popup never opened): nothing to fill.
{
  const { ctx, sw } = await launch(path.resolve("extension"));
  log = { api: [], blocked: [], claims: [] };
  const { tab } = await open(ctx, RECRUITEE_OWN_DOMAIN, 3000);
  const r = await fillTabNow(sw, "none");
  row("d", RECRUITEE_OWN_DOMAIN + " (no access)", r, { button: (await button(tab)) ? "SHOWN" : "none" });
  await ctx.close();
}

fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(rows, null, 1));
const pad = (s, n) => String(s ?? "-").slice(0, n).padEnd(n);
console.log("\n" + [pad("part", 4), pad("host", 30), pad("button", 34), pad("filled", 10), pad("err", 4), pad("e/n/p/cv", 9), pad("in frame", 18), pad("navs", 4), "notes"].join(" "));
let bad = 0;
for (const x of rows) {
  const h = x.held || {};
  const std = h.where ? ["email", "name", "phone", "cv"].map((k) => (h[k] ? "y" : "-")).join("/") : "-";
  console.log([pad(x.part, 4), pad(x.host, 30), pad(x.button, 34), pad(x.filled, 10), pad(x.errors ? x.errors.length : "-", 4), pad(std, 9), pad((h.where || []).join(","), 18), pad(x.navigations, 4),
    (x.error || "") + (x.errors && x.errors.length ? " " + x.errors.join("; ") : "")].join(" ").slice(0, 220));
}
const need = (ok, what) => { if (!ok) { bad++; console.log("FAIL", what); } };
const a = rows.find((x) => x.part === "a");
need(a && !a.error && a.errors.length === 0 && a.held.email && a.held.name && a.held.phone && a.held.cv && a.held.where.includes("www.comeet.co") && a.stayed && a.navigations === 0, "a: Cyera fills the comeet.co frame in one call, no navigation");
const b = rows.find((x) => x.part === "b");
need(b && !b.error && b.errors.length === 0 && b.held.email && b.held.cv && b.stayed && b.registered.includes("detect-all") && b.button !== "none", "b: Cellebrite fills in one call with every-site access, button shown");
// A Teamtailor form can open on its own questions, with the contact
// fields a step later, so the button's own result is what counts here.
const ats = rows.filter((x) => x.part === "c" && "apiBeforeClick" in x);
for (const x of ats) need(x.button !== "none" && !x.error && x.filled > 0 && x.errors.length === 0 && x.apiBeforeClick === 0, `c: ${x.host} button shows and fills, no API call before the click`);
need(ats.length === 2, "c: both ATS pages tried");
for (const x of rows.filter((x) => x.part === "c" && !("apiBeforeClick" in x))) need(x.button === "none" && x.apiCalls === 0, `c: no button and no API call on ${x.host}`);
const d = rows.filter((x) => x.part === "d");
need(d[0] && !d[0].error && d[0].held.email && d[0].button === "none" && d[0].registered.length === 0, "d: fills the page activeTab grants; no button, no every-site script");
need(d[1] && d[1].error === "This page isn't supported.", "d: no access, nothing filled");
console.log(`\nclaims made: ${rows.reduce((n, x) => n + x.claims, 0)} (must be 0)`);
console.log(`writes to other hosts, all aborted or answered in the browser: ${rows.reduce((n, x) => n + x.blocked.length, 0)}`);
for (const x of rows) for (const w of x.blocked) console.log(`  ${x.part} ${x.host}: ${w}`);
console.log(bad ? `\n${bad} check(s) failed` : "\nall checks passed");
console.log(`screenshots and results: ${out}`);
process.exitCode = bad || rows.reduce((n, x) => n + x.claims, 0) ? 1 : 0;
