// Where does a filter click spend its time: main thread (long tasks),
// the rail redraw, or the API?
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => {
  localStorage.setItem("iljobs_geo_asked", "1");
  window.__lt = [];
  new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push(Math.round(e.duration)))).observe({ type: "longtask", buffered: true });
});
const api = [];
page.on("requestfinished", async (r) => { if (r.url().includes("/api/") || r.url().includes("precomputed")) { const t = r.timing(); api.push(`${Math.round(t.responseEnd)}ms ${r.url().replace(/^https:\/\/[^/]+/, "")}`); } });
await page.goto("https://oceanofjobs.com/board?country=IL", { waitUntil: "domcontentloaded" });
await page.waitForSelector("tr[data-id]"); await page.waitForTimeout(3000);
const reset = async () => { api.length = 0; await page.evaluate(() => { window.__lt = []; }); };

async function act(label, fn) {
  await reset();
  const t0 = Date.now();
  await fn();
  const tSync = Date.now() - t0;
  await page.waitForTimeout(3000);
  const lt = await page.evaluate(() => window.__lt);
  console.log(`\n== ${label}: action returned ${tSync}ms | long tasks: ${JSON.stringify(lt)}`);
  api.forEach((a) => console.log("   ", a));
}
// Tick the first option in the first open section, time until checked.
await act("tick option", async () => {
  const opt = page.locator(".rail-acc.open .rail-acc-body label:has(input[type=checkbox])").nth(1);
  const t = Date.now(); await opt.click();
  await page.waitForFunction(() => document.querySelectorAll(".rail-acc.open .rail-acc-body input[type=checkbox]")[1]?.checked);
  console.log("checkbox shows checked after", Date.now() - t, "ms");
  const t2 = Date.now();
  await page.waitForResponse((r) => r.url().includes("/api/jobs"), { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(50);
  console.log("list request done after", Date.now() - t2, "ms more");
});
await act("toggle section", async () => {
  const head = page.locator(".rail-acc-head").nth(2);
  const t = Date.now(); await head.click();
  await page.waitForFunction(() => !document.querySelector(".rail-acc-body.animating"));
  console.log("section settled after", Date.now() - t, "ms");
});
// Cost of one rail redraw on its own.
console.log("\nrenderFilterRail x10 avg:", await page.evaluate(() => { const t = performance.now(); for (let i = 0; i < 10; i++) renderFilterRail(); return ((performance.now() - t) / 10).toFixed(1) + "ms"; }));
console.log("rail DOM nodes:", await page.evaluate(() => document.getElementById("rail-groups").getElementsByTagName("*").length));
await browser.close();
