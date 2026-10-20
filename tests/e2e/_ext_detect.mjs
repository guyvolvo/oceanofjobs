// The on-page offer on a real Greenhouse form, with our API stubbed. Fills
// the form but NEVER presses Submit: nothing reaches the employer.
import { chromium } from "playwright";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
const out = process.argv[2];
const URL_ = "https://job-boards.greenhouse.io/embed/job_app?for=appsflyer&token=8882905002";
const ext = path.resolve("extension");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ooj-ext-"));
const ctx = await chromium.launchPersistentContext(dir, { channel: "chromium", headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
const calls = [];
const profile = { contact: { first_name: "Test", last_name: "Person", email: "test@example.com", phone: "+972 50 000 0000", location: "Tel Aviv, Israel" },
  links: { linkedin: "https://linkedin.com/in/test", github: "", website: "" }, work: { authorized_countries: ["IL"], needs_sponsorship: false, notice_period: "30 days", salary: "" },
  eeo: { gender: "decline", race: null, veteran: null, disability: null }, answers: [],
  settings: { mode: "queue", sources: ["board", "ats_pages"], unknowns: "skip", guardrails: { min_match: null, daily_limit: null, blocked_companies: [], one_per_company_days: null } } };
await ctx.route("https://oceanofjobs.com/api/**", (r) => {
  const u = new URL(r.request().url()); calls.push(r.request().method() + " " + u.pathname);
  if (u.pathname.endsWith("/me/apply/profile")) return r.fulfill({ json: { profile, preferences: { skills: ["Python"] } } });
  if (u.pathname.endsWith("/me/apply/usage")) return r.fulfill({ json: { plan: "pro", period: "day", limit: 50, used: 0, remaining: 50 } });
  if (u.pathname.endsWith("/me/apply/history")) return r.fulfill({ json: { applied: [] } });
  if (u.pathname.endsWith("/me/apply/claim")) return r.fulfill({ json: { remaining: 49 } });
  return r.fulfill({ status: 204, body: "" });
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
await sw.evaluate(() => chrome.storage.local.set({ token: "ooj_test.00000000.x", cv: { name: "cv.pdf", type: "application/pdf", data: btoa("%PDF-1.4 test") } }));
const p = await ctx.newPage();
const submits = [];
// Every POST to Greenhouse is stopped in the browser and only its address kept.
await p.route(/greenhouse\.io/, (r) => {
  if (r.request().method() !== "POST") return r.continue();
  submits.push(r.request().url().split("?")[0]);
  return r.abort();
});
await p.goto(URL_, { waitUntil: "load" });
await p.waitForTimeout(6000);
const box = () => p.evaluate(() => {
  const el = document.querySelector("[data-ooj-fill]");
  const r = el && el.getBoundingClientRect();
  return r && { x: r.x, y: r.y, w: r.width, h: r.height };
});
const fab = await box();
console.log("button present:", !!fab, fab && `top ${Math.round(fab.y)}`);
await p.screenshot({ path: `${out}/detect-button.png` });
// The button and card are in a closed shadow root: click by coordinates.
await p.mouse.click(fab.x + fab.w / 2, fab.y + fab.h / 2);
await p.waitForTimeout(3000);
const card = await box();
await p.screenshot({ path: `${out}/detect-offer.png` });
// "Fill in this application" sits above the card's "Hide on this site" line.
await p.mouse.click(card.x + card.w / 2, card.y + card.h - 62);
await p.waitForTimeout(8000);
await p.screenshot({ path: `${out}/detect-filled.png`, fullPage: true });
const after = await box();
await p.screenshot({ path: `${out}/detect-card.png`, clip: { x: after.x - 20, y: Math.max(0, after.y - 20), width: after.w + 40, height: after.h + 40 } });
const vals = await p.evaluate(() => ["first_name", "last_name", "email", "phone"].map((id) => [id, (document.getElementById(id) || {}).value]));
console.log("filled:", JSON.stringify(vals));
console.log("api calls:", calls.join(", "));
console.log("POSTs to greenhouse, all blocked:", JSON.stringify(submits));
await ctx.close();
