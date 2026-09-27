// The overview tiles while a filtered answer is being counted, then after:
// same size, dots in the number's place. Holds /api/stats back on purpose.
import { chromium } from "playwright";
const browser = await chromium.launch();
for (const theme of ["dark", "light"]) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript((t) => { localStorage.setItem("iljobs_theme", t); localStorage.setItem("iljobs_geo_asked", "1"); }, theme);
  await page.route(/\/app\.js(\?|$)/, (r) => r.fulfill({ path: "../../frontend/app.js", contentType: "application/javascript" }));
  await page.route(/\/style\.css(\?|$)/, (r) => r.fulfill({ path: "../../frontend/style.css", contentType: "text/css" }));
  let release;
  const held = new Promise((res) => { release = res; });
  await page.route((u) => u.pathname === "/api/stats" && u.search.includes("country="), async (r) => { await held; r.continue(); });
  await page.goto("https://oceanofjobs.com/board?country=IL", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".ov-dots", { timeout: 30000 });
  await page.waitForTimeout(700);
  const size = () => page.$$eval(".ov-tile", (els) => els.map((e) => { const r = e.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}`; }));
  const before = await size();
  await page.locator(".ov-tiles").screenshot({ path: `ov-loading-${theme}.png` });
  release();
  await page.waitForSelector(".ov-delta", { timeout: 30000 });
  await page.waitForTimeout(500);
  const after = await size();
  console.log(theme, "loading", before.join(" "), "| loaded", after.join(" "), "| same:", before.join() === after.join());
  await page.close();
}
await browser.close();
