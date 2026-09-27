// Board rows fade on hover and the selected bar grows, not snaps.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.route(/\/style\.css(\?|$)/, (r) => r.fulfill({ path: "../../frontend/style.css", contentType: "text/css" }));
await page.addInitScript(() => localStorage.setItem("iljobs_geo_asked", "1"));
await page.goto("https://oceanofjobs.com/board?country=IL", { waitUntil: "domcontentloaded" });
await page.waitForSelector("tr[data-id]"); await page.waitForTimeout(1500);
const row = page.locator("tr[data-id]").nth(2);
const bg = () => row.evaluate((e) => getComputedStyle(e).backgroundColor);
const before = await bg();
await row.hover(); await page.waitForTimeout(40); const mid = await bg(); await page.waitForTimeout(200); const after = await bg();
console.log("row hover:", before, "->", mid, "->", after, "| transition:", await row.evaluate((e) => getComputedStyle(e).transition));
await row.click(); await page.waitForTimeout(40);
const barMid = await row.evaluate((e) => getComputedStyle(e, "::before").transform);
await page.waitForTimeout(250);
const barEnd = await row.evaluate((e) => getComputedStyle(e, "::before").transform);
console.log("selected bar:", barMid, "->", barEnd, "| left:", await row.evaluate((e) => getComputedStyle(e, "::before").left));
await browser.close();
