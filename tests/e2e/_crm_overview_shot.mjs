// The CRM overview's charts, from the local build (crm/dist) with a made-up
// /api/dashboard answer. Nothing reaches the live CRM.
//   (cd apply && npx vite build --config vite.crm.config.ts) && node tests/e2e/_crm_overview_shot.mjs <out dir>
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const OUT = process.argv[2] || ".";
const DIST = path.resolve("crm/dist");
const since = (d) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
const hours = (h) => new Date(Date.now() - h * 36e5).toISOString().slice(0, 13);
const dash = (range) => {
  const [n, key] = range === "24h" ? [24, hours] : [Number(range.slice(0, -1)), since];
  const b = Array.from({ length: n }, (_, i) => key(n - 1 - i));
  return { complete: true, range, members: 28, new: range === "24h" ? 2 : 12, newsletter: 9, waitlist: { basic: 2, pro: 4 }, mcp: 4,
    signups: b.map((k, i) => [k, [0, 1, 0, 2, 0, 0, 1][i % 7]]), total: b.map((k, i) => [k, 16 + Math.round((i / n) * 12)]),
    funnel: [["Signed up", 12], ["Extension", 6], ["Resume", 4], ["Applied (confirmed)", 3], ["Paid", 1]],
    providers: { google: 8, email: 3, github: 1 }, plans: { free: 11, pro: 1 },
    applications: { confirmed: 41, unconfirmed: 6, failed: 9, weeks: range === "90d" ? 12 : range === "30d" ? 4 : 1, active_user_weeks: 18, per_user_week: 1.83, unconfirmed_per_user_week: 0.33, disputed: 2, older: 4,
      by_time: b.map((k, i) => [k, [2, 0, 3, 1, 0, 2, 1][i % 7], [0, 1, 0, 0, 0, 0, 1][i % 7], [1, 0, 0, 1, 0, 0, 0][i % 7]]),
      by_system: [["Greenhouse", 18, 2, 3], ["Workday", 9, 3, 4], ["Lever", 7, 1, 0], ["Ashby", 5, 0, 1], ["careers.acme.com", 2, 0, 1]] } };
};
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 1400 } });
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));
await p.route("https://crm.local/**", (r) => {
  const u = new URL(r.request().url());
  if (u.pathname === "/api/dashboard") return r.fulfill({ json: dash(u.searchParams.get("range") || "30d") });
  if (u.pathname.startsWith("/api/")) return r.fulfill({ json: { sending: true, messages: [], flows: [], campaigns: [], segments: [] } });
  const file = path.join(DIST, u.pathname === "/" ? "crm.html" : u.pathname);
  return fs.existsSync(file) && fs.statSync(file).isFile() ? r.fulfill({ path: file }) : r.fulfill({ status: 404, body: "" });
});
await p.goto("https://crm.local/", { waitUntil: "load" });
await p.waitForSelector("canvas", { timeout: 15000 });
await p.waitForTimeout(1500);
console.log("charts drawn:", await p.locator("canvas").count(), "errors:", errs.length ? errs : "none");
await p.screenshot({ path: `${OUT}/crm-overview.png`, fullPage: true });
await p.getByRole("tab", { name: "24h" }).click();
await p.waitForTimeout(1500);
await p.screenshot({ path: `${OUT}/crm-overview-24h.png`, clip: { x: 0, y: 0, width: 1280, height: 560 } });
await b.close();
