// The showcase card's hover depth: photograph zooms and shifts against
// the pointer, the board lifts and shifts with it.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => console.log("pageerror", e.message));
await page.route(/^https:\/\/oceanofjobs\.com\/(\?.*)?$/, (r) => r.fulfill({ path: "../../frontend/index.html", contentType: "text/html" }));
await page.route((u) => u.pathname === "/style.css", (r) => r.fulfill({ path: "../../frontend/style.css", contentType: "text/css" }));
await page.goto("https://oceanofjobs.com/", { waitUntil: "load" });
const card = page.locator(".hero-showcase");
await card.scrollIntoViewIfNeeded(); await page.waitForTimeout(800);
const look = () => page.evaluate(() => {
  const c = document.querySelector(".hero-showcase");
  return { photo: getComputedStyle(c, "::before").transform, veil: getComputedStyle(c, "::after").backgroundColor,
           board: getComputedStyle(document.querySelector(".showcase-pc")).transform };
});
console.log("rest :", JSON.stringify(await look()));
await card.screenshot({ path: "hero-rest.png" });
const b = await card.boundingBox();
await page.mouse.move(b.x + b.width * 0.15, b.y + b.height * 0.2);
await page.waitForTimeout(1200);
console.log("hover:", JSON.stringify(await look()));
await card.screenshot({ path: "hero-hover.png" });
await browser.close();
