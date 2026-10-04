// The board reports a visit, a new visitor, a search, a job view and an
// apply click, the visit once per tab, and an automated browser reports
// nothing (frontend/count.js). Chromium doesn't show sendBeacon requests
// to Playwright, so the page's beacon is swapped for an in-page list:
// this checks what count.js decides to send, and api/events.py's tests
// check the receiving end. Nothing reaches the live site.
import { chromium } from "playwright";
const base = process.env.BASE || "http://localhost:8010";
const b = await chromium.launch();

async function run(human) {
  // A person's browser says Chrome; headless Chromium says HeadlessChrome,
  // which count.js ignores like any other robot.
  const ctx = await b.newContext(human ? { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36" } : {});
  await ctx.addInitScript((h) => {
    if (h) Object.defineProperty(navigator, "webdriver", { get: () => false });
    window.__beacons = [];
    Object.defineProperty(Navigator.prototype, "sendBeacon", {
      configurable: true, value: (u) => { const q = new URL(u, location.href).searchParams; window.__beacons.push(q.get("e") + (q.get("q") ? ":" + q.get("q") : "")); return true; } });
  }, human);
  await ctx.route("**/*", (r) => {
    // The apply link opens the employer's site in a new tab: answer it empty.
    if (!r.request().url().startsWith(base) && r.request().resourceType() === "document") return r.fulfill({ status: 204 });
    return r.continue();
  });
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 1440, height: 900 });
  const sent = [];
  const drain = async () => sent.push(...(await p.evaluate(() => window.__beacons.splice(0))));
  await p.goto(`${base}/board`, { waitUntil: "load" });
  await p.waitForSelector("tr[data-id]", { state: "attached", timeout: 30000 });
  // A new browser is asked where it is first; skip it as a person would.
  await p.locator("#geo-skip").click({ timeout: 4000 }).catch(() => {});
  await p.fill("#f-search", "python");
  await p.press("#f-search", "Enter");
  await p.waitForTimeout(3000);
  await p.locator("tr[data-id] .job-title-link").first().click({ timeout: 5000 }).catch(() => console.error("row click failed"));
  await p.waitForTimeout(1500);
  await p.locator("a.job-detail-apply").first().click({ timeout: 5000 }).catch(() => console.error("apply click failed"));
  await p.waitForTimeout(800);
  await drain();
  await p.reload({ waitUntil: "load" });
  await p.waitForTimeout(1500);
  await drain();
  await ctx.close();
  return sent;
}

const human = await run(true);
const robot = await run(false);
console.log(JSON.stringify({ human, robot }));
await b.close();
const n = (e) => human.filter((x) => x === e).length;
const ok = ["search:python", "job_view", "apply"].every((e) => n(e) >= 1) && n("visit") === 1 && n("new_visitor") === 1 && robot.length === 0;
process.exit(ok ? 0 : 1);
