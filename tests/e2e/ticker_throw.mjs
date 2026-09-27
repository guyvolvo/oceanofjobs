// Drag a landing ticker and let go: it should take the throw and keep
// spinning. Working copy of the page over the live site.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = []; page.on("pageerror", (e) => errs.push(e.message));
await page.route((u) => u.pathname === "/", (r) => r.fulfill({ path: "../../frontend/index.html", contentType: "text/html" }));
await page.goto("https://oceanofjobs.com/", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
const box = await page.locator(".hero-ticker.to-right").boundingBox();
const x0 = await page.evaluate(() => new DOMMatrix(getComputedStyle(document.getElementById("ticker-top")).transform).m41);
const y = box.y + box.height / 2;
await page.mouse.move(box.x + 900, y); await page.mouse.down();
for (let i = 1; i <= 8; i++) { await page.mouse.move(box.x + 900 - i * 60, y); await page.waitForTimeout(12); }
await page.mouse.up();
await page.waitForTimeout(300);
const x1 = await page.evaluate(() => new DOMMatrix(getComputedStyle(document.getElementById("ticker-top")).transform).m41);
console.log("thrown left by", Math.round(x0 - x1), "px in 0.4s | errors:", errs);
await browser.close();
