// Every dropdown eases open and closed: samples each one mid-animation
// and at rest, and screenshots the rail section and the Sort picker.
import { chromium } from "playwright";
const browser = await chromium.launch();
console.log("chromium", browser.version());
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.route(/\/style\.css(\?|$)/, (r) => r.fulfill({ path: "../../frontend/style.css", contentType: "text/css" }));
await page.route(/\/app\.js(\?|$)/, (r) => r.fulfill({ path: "../../frontend/app.js", contentType: "text/javascript" }));
await page.route(/\/hero_nav\.js(\?|$)/, (r) => r.fulfill({ path: "../../frontend/hero_nav.js", contentType: "text/javascript" }));
await page.addInitScript(() => localStorage.setItem("iljobs_geo_asked", "1"));

await page.goto("https://oceanofjobs.com/", { waitUntil: "domcontentloaded" });
const btn = page.locator(".site-menu-btn").first();
const panel = page.locator(".site-menu-panel").first();
const look = () => panel.evaluate((e) => { const s = getComputedStyle(e); return `${s.display} op=${(+s.opacity).toFixed(2)} ${s.transform}`; });
await btn.click(); await page.waitForTimeout(30); const m1 = await look(); await page.waitForTimeout(300); const m2 = await look();
await page.keyboard.press("Escape"); await page.waitForTimeout(40); const m3 = await look(); await page.waitForTimeout(300); const m4 = await look();
console.log("site menu open:", m1, "=>", m2); console.log("site menu close:", m3, "=>", m4);

await page.goto("https://oceanofjobs.com/board?country=IL", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".rail-acc-head"); await page.waitForTimeout(2000);
const acc = page.locator(".rail-acc").first();
const body = () => acc.evaluate((e) => { const b = e.querySelector(".rail-acc-body"); return b.hidden ? "hidden" : `${Math.round(b.getBoundingClientRect().height)}px op=${(+getComputedStyle(b).opacity).toFixed(2)}`; });
const wasOpen = await acc.evaluate((e) => e.classList.contains("open"));
await acc.locator(".rail-acc-head").click(); await page.waitForTimeout(80); const a1 = await body(); await page.waitForTimeout(350); const a2 = await body();
console.log(`rail ${wasOpen ? "close" : "open"}:`, a1, "=>", a2);
await page.locator(".rail-acc").first().locator(".rail-acc-head").click(); await page.waitForTimeout(80); const a3 = await body();
await page.screenshot({ path: "dd-rail-mid.png", clip: { x: 0, y: 60, width: 420, height: 500 } });
await page.waitForTimeout(350); const a4 = await body();
console.log(`rail ${wasOpen ? "open" : "close"}:`, a3, "=>", a4);
await page.screenshot({ path: "dd-rail.png", clip: { x: 0, y: 60, width: 420, height: 500 } });

const sort = page.locator("#f-sort");
console.log("select appearance:", await sort.evaluate((e) => getComputedStyle(e).appearance));
await sort.click(); await page.waitForTimeout(40);
await page.screenshot({ path: "dd-sort-mid.png", clip: { x: 700, y: 0, width: 740, height: 320 } });
await page.waitForTimeout(300);
await page.screenshot({ path: "dd-sort.png", clip: { x: 700, y: 0, width: 740, height: 320 } });
await page.keyboard.press("Escape");
await page.emulateMedia({ colorScheme: "dark" });
await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
await page.locator("#f-date-posted").click(); await page.waitForTimeout(350);
await page.screenshot({ path: "dd-date-dark.png", clip: { x: 700, y: 0, width: 740, height: 360 } });
await browser.close();
