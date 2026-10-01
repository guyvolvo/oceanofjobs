// Screenshots of the account page's overview as a signed-in reader
// would see it. The token is crafted and the reader's own endpoints
// (/api/me/*) are stubbed, since those need a real session; the public
// endpoints (jobs, jobs/history) are the live ones unless MOCK_HISTORY=1
// stubs the history too, for a box that has not deployed it yet.
import { chromium } from "playwright";
const base = process.env.BASE || "http://localhost:8010";
const b = await chromium.launch();
const ctx = await b.newContext();
const errors = [];
const SKILLS = ["Python", "AWS", "Kubernetes", "Terraform", "Docker", "Linux", "Go"];
await ctx.route("**/api/me/profile", (r) => r.fulfill({ json: { profile: { skills: SKILLS, seniority: "senior", workplace: [], israel_only: true, country: ["IL"], city: [], cadence: "daily", digest_time: "09:00", digest_tz: "Asia/Jerusalem", digest_day: 0 }, skill_spec: null } }));
await ctx.route("**/api/me/alerts", (r) => r.fulfill({ json: { alerts: [
  { alert_id: "a1", active: true, filter: { search: "devops", department: "Infrastructure", country: "IL" }, created_at: "2026-09-20T09:00:00Z", last_notified_at: new Date(Date.now() - 3 * 36e5).toISOString() },
  { alert_id: "a2", active: false, filter: { search: "sre", country: "IL" }, created_at: "2026-09-01T09:00:00Z", last_notified_at: "2026-09-29T09:00:00Z" },
] } }));
await ctx.route("**/api/me/saved", (r) => r.fulfill({ json: { saved: [] } }));
if (process.env.MOCK_HISTORY === "1") {
  await ctx.route("**/api/jobs/history*", (r) => {
    const days = Array.from({ length: 90 }, (_, i) => ({ day: new Date(Date.now() - (89 - i) * 864e5).toISOString().slice(0, 10), open: 240 + Math.round(30 * Math.sin(i / 9)) + Math.round(i / 3), new: 5 + Math.round(8 * Math.abs(Math.sin(i / 2))) }));
    r.fulfill({ json: { skills: SKILLS, min_match: 3, country: ["IL"], days } });
  });
}
for (const [w, h] of [[1440, 1000], [390, 900]]) {
  const p = await ctx.newPage();
  await p.setViewportSize({ width: w, height: h });
  p.on("pageerror", (e) => errors.push(`${w}: ${e.message}`));
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`${w} console: ${m.text().slice(0, 140)}`); });
  await p.addInitScript(() => {
    localStorage.setItem("iljobs_theme", "dark");
    const payload = btoa(JSON.stringify({ email: "guy@example.com", name: "Guy Example", exp: Math.floor(Date.now() / 1000) + 3600, sub: "x" })).replace(/=+$/, "");
    localStorage.setItem("iljobs_auth_tokens", JSON.stringify({ id_token: "eyJhbGciOiJub25lIn0." + payload + ".sig", access_token: "a", refresh_token: "r" }));
  });
  await p.goto(base + "/account", { waitUntil: "domcontentloaded" });
  await p.waitForFunction(() => document.querySelectorAll("#acct-stats .acct-stat").length === 4, null, { timeout: 60000 }).catch(() => errors.push(`${w}: tiles never drew`));
  await p.waitForFunction(() => document.querySelector("#acct-demand .acct-demand-fill"), null, { timeout: 60000 }).catch(() => errors.push(`${w}: demand bars never drew`));
  await p.waitForTimeout(1500);
  console.log(w, JSON.stringify(await p.evaluate(() => ({
    greeting: document.querySelector("#acct-greeting")?.textContent, summary: document.querySelector("#acct-summary")?.textContent.trim().slice(0, 90),
    tiles: [...document.querySelectorAll(".acct-stat")].map((t) => t.querySelector(".acct-stat-label").textContent + "=" + t.querySelector(".acct-stat-value").textContent),
    chart: !!document.querySelector(".acct-market-svg"), demand: document.querySelectorAll(".acct-demand-row").length, note: document.querySelector("#acct-demand-note")?.textContent.slice(0, 80),
    pay: document.querySelector("#acct-pay")?.textContent.trim().slice(0, 60), activity: document.querySelectorAll(".acct-act").length, matches: document.querySelectorAll("#acct-matches .acct-match").length,
    tabs: [...document.querySelectorAll(".acct-tabs .account-nav-link")].map((a) => a.textContent.trim()).join(","), overflow: document.documentElement.scrollWidth - innerWidth,
    dim: (() => { let e = document.querySelector(".acct-stat"); const out = []; while (e) { const o = getComputedStyle(e).opacity; if (o !== "1") out.push(`${e.tagName}.${e.className.toString().split(" ")[0]}=${o}`); e = e.parentElement; } return out.join(" ") || "none"; })(),
    tabRow: new Set([...document.querySelectorAll(".acct-tabs .account-nav-link")].map((a) => Math.round(a.getBoundingClientRect().top))).size,
  }))));
  await p.screenshot({ path: `tests/e2e/account-${w}.png`, fullPage: true });
  await p.close();
}
await b.close();
console.log(errors.length ? "ERRORS:\n" + errors.join("\n") : "no page errors");
