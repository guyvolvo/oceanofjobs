// The CRM overview's charts, from the local build (crm/dist) with a made-up
// /api/dashboard answer. Nothing reaches the live CRM.
//   (cd apply && npx vite build --config vite.crm.config.ts) && node tests/e2e/_crm_overview_shot.mjs <out dir>
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const OUT = process.argv[2] || ".";
const DIST = path.resolve("crm/dist");
const since = (d) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
const by_day = Array.from({ length: 30 }, (_, i) => [since(29 - i), [0, 1, 0, 2, 0, 0, 1][i % 7]]);
const growth = Array.from({ length: 90 }, (_, i) => [since(89 - i), 5 + Math.round(i / 4)]);
const dash = { complete: true, members: 28, new_7: 3, new_30: 12, newsletter: 9, agreed: 20, waitlist: { basic: 2, pro: 4 },
  plans: { free: 26, basic: 1, pro: 1 }, by_day, growth,
  funnel: [["Signed up", 28], ["Connected the extension", 11], ["Added a resume", 8], ["Sent an application", 5], ["Paid plan", 2]],
  providers: { google: 18, email: 7, github: 3 }, mcp: 4, apps_by_month: [["2026-05", 0], ["2026-06", 0], ["2026-07", 0], ["2026-08", 3], ["2026-09", 21], ["2026-10", 64]] };
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 1400 } });
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));
await p.route("https://crm.local/**", (r) => {
  const u = new URL(r.request().url());
  if (u.pathname === "/api/dashboard") return r.fulfill({ json: dash });
  if (u.pathname.startsWith("/api/")) return r.fulfill({ json: { sending: true, messages: [], flows: [], campaigns: [], segments: [] } });
  const file = path.join(DIST, u.pathname === "/" ? "crm.html" : u.pathname);
  return fs.existsSync(file) && fs.statSync(file).isFile() ? r.fulfill({ path: file }) : r.fulfill({ status: 404, body: "" });
});
await p.goto("https://crm.local/", { waitUntil: "load" });
await p.waitForSelector("canvas", { timeout: 15000 });
await p.waitForTimeout(1500);
console.log("charts drawn:", await p.locator("canvas").count(), "errors:", errs.length ? errs : "none");
await p.screenshot({ path: `${OUT}/crm-overview.png`, fullPage: true });
await b.close();
