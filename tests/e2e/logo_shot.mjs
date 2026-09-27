import { chromium } from "playwright";
const browser = await chromium.launch();
for (const theme of ["light", "dark"]) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript((t) => { localStorage.setItem("iljobs_theme", t); localStorage.setItem("iljobs_geo_asked", "1"); }, theme);
  await page.route(/\/style\.css(\?|$)/, (r) => r.fulfill({ path: "../../frontend/style.css", contentType: "text/css" }));
  await page.goto("https://oceanofjobs.com/board?country=IL", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("tr[data-id] .company-logo"); await page.waitForTimeout(2500);
  console.log(theme, "logo border:", await page.$eval("tr[data-id] .company-logo", (e) => getComputedStyle(e).borderTopWidth));
  await page.screenshot({ path: `logos-${theme}.png`, clip: { x: 330, y: 120, width: 420, height: 400 } });
  await page.close();
}
await browser.close();
