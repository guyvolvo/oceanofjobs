import { chromium } from "playwright";
const browser = await chromium.launch();
for (const theme of ["light", "dark"]) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript((t) => { localStorage.setItem("iljobs_theme", t); localStorage.setItem("iljobs_geo_asked", "1"); }, theme);
  await page.route(/\/style\.css(\?|$)/, (r) => r.fulfill({ path: "../../frontend/style.css", contentType: "text/css" }));
  await page.goto("https://oceanofjobs.com/board?country=IL", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("tr[data-id]"); await page.waitForTimeout(2000);
  const b = await page.evaluate(() => ({
    rail: getComputedStyle(document.querySelector(".filter-rail")).borderRightWidth,
    row: getComputedStyle(document.querySelector("tr[data-id]")).borderBottomWidth,
    group: getComputedStyle(document.querySelectorAll(".rail-acc")[1]).borderTopWidth,
  }));
  console.log(theme, b);
  await page.screenshot({ path: `lines-${theme}.png`, clip: { x: 40, y: 110, width: 880, height: 520 } });
  await page.close();
}
await browser.close();
