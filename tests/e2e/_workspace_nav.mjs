// /apply and /account: a link to another workspace page draws it in the
// same document (workspace/main.tsx). Clicks through the sidebar, the
// account menu and the Settings tabs, then Back and Forward, and checks
// the document never reloads, the address, title, focus and active
// sidebar item follow, a page seen before paints its last data at once,
// and an open edit on Preferences asks before leaving.
// Every /api call is answered here; nothing reaches the live API.
//   (cd apply && npx vite --port 5183 --strictPort --host 127.0.0.1) & node tests/e2e/_workspace_nav.mjs [base url]
import { chromium } from "playwright";

const BASE = process.argv[2] || "http://127.0.0.1:5183";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const idToken = `${b64({ alg: "none" })}.${b64({ sub: "u1", email: "a@b.c", name: "Test Reader", exp: Math.floor(Date.now() / 1000) + 3600 })}.x`;
const failures = [];
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failures.push(what); };

const summary = { plan: "pro", period: "month", limit: 100, remaining: 48, used: 52, in_progress: 0, applied_today: 0, filled_today: 0,
  unconfirmed: 0, needs_input: 0, queued: 7, disputes_left: 3, ai: { used: 0, limit: 3000 }, tz: "UTC" };
const profile = { skills: ["Go"], seniority: null, workplace: ["remote"], israel_only: true, country: [], city: [], cadence: "instant",
  digest_time: "09:00", digest_tz: "UTC", digest_day: 0 };
const applyProfile = { contact: { first_name: "A", last_name: "B", email: "a@b.c", phone: "", location: "" }, links: { linkedin: "", github: "", website: "" },
  work: { authorized_countries: [], needs_sponsorship: null, notice_period: "", salary: "" }, eeo: {}, answers: [],
  settings: { mode: "queue", fill: "half", sources: ["board"], unknowns: "ai", consent: true,
    guardrails: { min_match: null, daily_limit: null, blocked_companies: [], one_per_company_days: null } } };
const JSON_FOR = {
  "/api/me/apply/summary": summary,
  "/api/me/apply/queue": { queue: [] }, "/api/me/apply/needs": { needs: [] }, "/api/me/apply/history": { applied: [] },
  "/api/me/apply/profile": { profile: applyProfile, onboarded: true },
  "/api/me/apply/agent": { agent: { resume: null, editable: true, version: 1, style: { tone: "plain", length: "short", language: "", notes: "" }, topics: Object.fromEntries(["referral_source", "start_date", "relocation", "onsite_days", "why_company", "why_role"].map((t) => [t, { action: "ask", value: "" }])), facts: [], never_claim: [] } },
  "/api/me/profile": { profile, skill_spec: null },
  "/api/me/alerts": { alerts: [{ alert_id: "a1", active: true, filter: { search: "kubernetes" } }] },
  "/api/me/saved": { saved: [] }, "/api/me/billing": { paid: null, license: null }, "/api/me/tokens": { tokens: [] },
  "/api/me/consent": { newsletter: false }, "/api/me/storage": { files: [] },
  "/api/companies": { companies: [] },
};
let slow = 0;
const errs = [];

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
p.on("pageerror", (e) => errs.push(e.message));
await p.addInitScript((t) => localStorage.setItem("iljobs_auth_tokens", JSON.stringify({ id_token: t, access_token: t, refresh_token: "r" })), idToken);
await p.route(/amazonaws\.com/, (r) => r.abort());
await p.route(/\/api\//, async (r) => {
  const u = new URL(r.request().url());
  if (slow) await new Promise((res) => setTimeout(res, slow));
  return r.fulfill({ json: JSON_FOR[u.pathname] || {} }).catch(() => {});
});
await p.route(/\/(facets|stats)\.json/, (r) => r.fulfill({ json: {} }));

const title = () => p.locator("main h1").first().innerText({ timeout: 10000 }).catch(() => "");
const active = () => p.locator('[data-sidebar="menu-button"][data-active="true"]').first().innerText().catch(() => "");
async function at(path, h1, side) {
  await p.waitForURL((u) => u.pathname === path, { timeout: 10000 }).catch(() => {});
  await p.locator("main h1", { hasText: h1 }).first().waitFor({ timeout: 10000 }).catch(() => {});
  const url = new URL(p.url()).pathname;
  const kept = await p.evaluate(() => window.__nav === 1);
  const focus = await p.evaluate(() => document.activeElement?.tagName === "H1" ? document.activeElement.textContent : document.activeElement?.id || document.activeElement?.tagName);
  check(url === path && (await title()) === h1 && (await active()) === side && kept,
    `${path}: "${h1}", sidebar "${side}", same document (url ${url}, h1 "${await title()}", sidebar "${await active()}", kept ${kept}, focus ${focus})`);
}
const click = (href) => p.locator(`a[href="${href}"]:visible`).first().click();

await p.goto(`${BASE}/apply`, { waitUntil: "load" });
await p.locator("main h1", { hasText: "Overview" }).waitFor({ timeout: 15000 });
await p.evaluate(() => { window.__nav = 1; });
await at("/apply", "Overview", "Overview");
// Every page's code loads once the first page is up (account/Billing.tsx on the dev server, Billing-<hash>.js built).
const preloaded = await p.waitForFunction(() => performance.getEntriesByType("resource").some((r) => /Billing[-.]/.test(r.name)), null, { timeout: 5000 })
  .then(() => true, () => false);
check(preloaded, "the other pages' code loads in the background");

await click("/apply/queue"); await at("/apply/queue", "Queue", "Queue");
check((await p.evaluate(() => document.activeElement?.textContent)) === "Queue", "focus moves to the new page's title");
await click("/apply/history"); await at("/apply/history", "Applications", "Applications");
await click("/apply/agent"); await at("/apply/agent", "AI agent", "AI agent");
await click("/account/settings"); await at("/account/settings", "Settings", "Settings");
check((await p.title()) === "Account | Ocean of Jobs", `the title follows the section (${await p.title()})`);
await p.getByRole("button", { name: "My account" }).click();
await p.getByRole("menuitem", { name: "Account" }).click();
await at("/account", "Account", "Overview");
await click("/account/alerts"); await at("/account/alerts", "Alerts", "Alerts");
await p.getByText("kubernetes").first().waitFor({ timeout: 10000 }).catch(() => {});
// Preferences is a Settings tab.
await click("/account/settings"); await at("/account/settings", "Settings", "Settings");
await click("/account/preferences"); await at("/account/preferences", "Preferences", "Settings");
await click("/account/billing"); await at("/account/billing", "Billing", "Settings");

// Back and Forward.
await p.goBack(); await at("/account/preferences", "Preferences", "Settings");
await p.goBack(); await at("/account/settings", "Settings", "Settings");
await p.goForward(); await at("/account/preferences", "Preferences", "Settings");

// A page seen before paints its data while the API takes 4 seconds, with
// no "Loading" row on the way.
await p.evaluate(() => {
  window.__loading = 0;
  new MutationObserver(() => { if (/Loading/.test(document.querySelector("#root")?.innerText || "")) window.__loading++; })
    .observe(document.body, { subtree: true, childList: true, characterData: true });
});
slow = 4000;
await p.locator('[data-sidebar="menu-button"]', { hasText: "Alerts" }).first().click();
const t0 = Date.now();
const alertsAtOnce = await p.getByText("kubernetes").first().waitFor({ timeout: 1500 }).then(() => true, () => false);
check(alertsAtOnce, `alerts seen before show at once (${Date.now() - t0} ms)`);
await click("/apply/queue");
const badgeAtOnce = await p.locator('[data-sidebar="menu-badge"]', { hasText: "7" }).first().waitFor({ timeout: 1500 }).then(() => true, () => false);
const statusAtOnce = await p.getByText("48 applications left").first().waitFor({ timeout: 1500 }).then(() => true, () => false);
check(badgeAtOnce && statusAtOnce, "the queue count and plan line show at once on an apply page");
check((await p.evaluate(() => window.__loading)) === 0, "no Loading row between pages seen before");
slow = 0;

// An open edit on Preferences asks before a link leaves it.
await click("/account/settings"); await at("/account/settings", "Settings", "Settings");
await click("/account/preferences"); await at("/account/preferences", "Preferences", "Settings");
await p.getByRole("button", { name: /^Workplace/ }).first().click();
await p.locator('[data-sidebar="menu-button"]', { hasText: "Queue" }).first().click();
const asked = await p.getByRole("dialog").getByText("Save your changes?").waitFor({ timeout: 5000 }).then(() => true, () => false);
check(asked && new URL(p.url()).pathname === "/account/preferences", "a link with an open edit shows the dialog and stays");
await p.getByRole("button", { name: "Keep editing" }).click();
await p.waitForTimeout(300);
check(new URL(p.url()).pathname === "/account/preferences" && !(await p.getByRole("dialog").isVisible().catch(() => false)), "Keep editing stays on Preferences");
await p.locator('[data-sidebar="menu-button"]', { hasText: "Queue" }).first().click();
await p.getByRole("button", { name: "Discard" }).click();
await at("/apply/queue", "Queue", "Queue");
// The dialog's close animation ends first: opened again mid-close, Radix draws its overlay over it.
await p.waitForTimeout(500);

// Back onto Preferences, open an edit, then Back asks too.
await p.goBack(); await at("/account/preferences", "Preferences", "Settings");
await p.getByRole("button", { name: /^Workplace/ }).first().click();
await p.goBack();
const askedBack = await p.getByRole("dialog").getByText("Save your changes?").waitFor({ timeout: 5000 }).then(() => true, () => false);
check(askedBack && new URL(p.url()).pathname === "/account/preferences", "Back with an open edit shows the dialog and keeps the address");
await p.getByRole("button", { name: "Discard" }).click();
await at("/account/settings", "Settings", "Settings");
await p.goForward(); await at("/account/preferences", "Preferences", "Settings");

// Links from before still open their page.
await p.goto(`${BASE}/account#settings`, { waitUntil: "load" });
await p.evaluate(() => { window.__nav = 1; });
await at("/account/settings", "Settings", "Settings");
await p.goto(`${BASE}/apply#queue`, { waitUntil: "load" });
await p.evaluate(() => { window.__nav = 1; });
await at("/apply/queue", "Queue", "Queue");
await p.goto(`${BASE}/apply/queue?source=alert`, { waitUntil: "load" });
await click("/apply/history"); await p.waitForURL("**/apply/history"); await p.goBack();
check(new URL(p.url()).search === "?source=alert", `Back keeps the query (${p.url()})`);

// On a phone the sidebar is a drawer: a link in it closes it and leaves nothing over the page.
await p.setViewportSize({ width: 390, height: 800 });
await p.goto(`${BASE}/apply`, { waitUntil: "load" });
await p.locator("main h1", { hasText: "Overview" }).waitFor({ timeout: 15000 });
await p.evaluate(() => { window.__nav = 1; });
for (const [href, h1] of [["/apply/queue", "Queue"], ["/apply/history", "Applications"]]) {
  await p.locator('[data-sidebar="trigger"]:visible').first().click();
  await p.getByRole("dialog").locator(`a[href="${href}"]`).click();
  await p.locator("main h1", { hasText: h1 }).waitFor({ timeout: 10000 });
  await p.waitForTimeout(600);
  const free = await p.evaluate(() => getComputedStyle(document.body).pointerEvents !== "none" && window.__nav === 1);
  check(free && !(await p.getByRole("dialog").count()), `phone: ${href} from the drawer, drawer closed, page usable`);
}

check(errs.length === 0, `no page errors${errs.length ? `: ${errs.join(" | ")}` : ""}`);
await b.close();

console.log(failures.length ? `\n${failures.length} failed` : "\nall passed");
process.exit(failures.length ? 1 : 0);
