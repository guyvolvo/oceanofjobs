// Picking from the customizable select still drives the board, and the
// stats page's selects keep their shape.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.route(/\/style\.css(\?|$)/, (r) => r.fulfill({ path: "../../frontend/style.css", contentType: "text/css" }));
await page.route(/\/app\.js(\?|$)/, (r) => r.fulfill({ path: "../../frontend/app.js", contentType: "text/javascript" }));
await page.addInitScript(() => localStorage.setItem("iljobs_geo_asked", "1"));
await page.goto("https://oceanofjobs.com/board?country=IL", { waitUntil: "domcontentloaded" });
await page.waitForSelector("tr[data-id]"); await page.waitForTimeout(1500);
await page.locator("#f-sort").click(); await page.waitForTimeout(300);
await page.getByRole("option", { name: "Oldest" }).click(); await page.waitForTimeout(1500);
console.log("sort value:", await page.locator("#f-sort").inputValue(), "| url:", page.url());
await page.goto("https://oceanofjobs.com/stats", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".qb-select"); await page.waitForTimeout(2000);
await page.locator(".qb-select").first().scrollIntoViewIfNeeded();
await page.locator(".qb-select").first().click(); await page.waitForTimeout(300);
const box = await page.locator(".qb-select").first().boundingBox();
await page.screenshot({ path: "dd-stats.png", clip: { x: Math.max(0, box.x - 20), y: Math.max(0, box.y - 60), width: 700, height: 380 } });
await browser.close();
