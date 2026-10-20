// The board's "Queue for auto apply" button, with a stubbed session and
// API. Needs the frontend on a local static server first:
//
//   python -m http.server 8011 -d frontend --bind 127.0.0.1
//   node _board_queue.mjs <screenshot dir>
import { chromium } from "playwright";
import assert from "node:assert/strict";

const out = process.argv[2] || ".";
const job = (id, ats, title) => ({
  id, ats, title, company_domain: `${ats}.example`, company_name: ats === "greenhouse" ? "Acme" : "Globex",
  location: "Tel Aviv, Israel", country: "IL", url: `https://${ats}.example/jobs/${id}`, confidence: "verified",
  posted_at: new Date().toISOString(), first_seen: new Date().toISOString(), description: "Build things.",
});
const JOBS = [job("gh0000000000001", "greenhouse", "Backend Engineer"), job("wd0000000000002", "workday", "Platform Engineer")];

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const puts = [];
// Registered first, so every route after it wins over this catch-all.
await ctx.route("**/api/**", (r) => r.fulfill({ json: {} }));
await ctx.route(/\/bootstrap(-il)?\.json/, (r) => r.fulfill({ status: 404, body: "" }));
await ctx.route((u) => u.pathname === "/api/jobs", (r) => r.fulfill({ json: { jobs: JOBS, total: 2, limit: 50, offset: 0 } }));
await ctx.route((u) => u.pathname.startsWith("/api/jobs/"), (r) =>
  r.fulfill({ json: JOBS.find((j) => r.request().url().includes(j.id)) }));
await ctx.route("**/api/me/saved", (r) => r.fulfill({ json: { saved: [] } }));
await ctx.route("**/api/me/alerts", (r) => r.fulfill({ json: { alerts: [] } }));
await ctx.route("**/api/me/apply/queue", (r) => r.fulfill({ json: { queue: [] } }));
await ctx.route("**/api/me/apply/queue/*", (r) => {
  puts.push(`${r.request().method()} ${new URL(r.request().url()).pathname}`);
  r.fulfill({ status: 204, body: "" });
});

const p = await ctx.newPage();
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));
await p.addInitScript(() => {
  localStorage.setItem("ooj_cookie_consent", "no");
  localStorage.setItem("iljobs_geo_asked", "1");
  const payload = btoa(JSON.stringify({ email: "guy@example.com", exp: Math.floor(Date.now() / 1000) + 3600, sub: "x" })).replace(/=+$/, "");
  localStorage.setItem("iljobs_auth_tokens", JSON.stringify({ id_token: "eyJhbGciOiJub25lIn0." + payload + ".sig", access_token: "a", refresh_token: "r" }));
});
await p.goto("http://127.0.0.1:8011/board.html", { waitUntil: "domcontentloaded" });

await p.click(`tr[data-id="${JOBS[0].id}"]`);
const btn = p.locator(`.job-detail-actions [data-queue="${JOBS[0].id}"]`);
await btn.waitFor();
assert.equal(await btn.getAttribute("aria-pressed"), "false");
await p.screenshot({ path: `${out}/board-queue-before.png` });
await btn.click();
await p.waitForFunction((id) => document.querySelector(`.job-detail-actions [data-queue="${id}"]`).getAttribute("aria-pressed") === "true", JOBS[0].id);
assert.deepEqual(puts, [`PUT /api/me/apply/queue/${JOBS[0].id}`]);
await p.screenshot({ path: `${out}/board-queue-queued.png` });

await p.click(`tr[data-id="${JOBS[1].id}"]`);
await p.waitForFunction(() => document.querySelector(".job-detail-title")?.textContent.includes("Platform Engineer"));
assert.equal(await p.locator("[data-queue]").count(), 0, "a Workday listing must not get a queue button");
await p.screenshot({ path: `${out}/board-queue-workday.png` });

assert.deepEqual(errors, []);
console.log("ok", puts);
await b.close();
