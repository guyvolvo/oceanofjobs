import { chromium } from "playwright";
const browser = await chromium.launch();
for (const [theme, w] of [["light", 1440], ["dark", 1440], ["light", 1024]]) {
  const page = await browser.newPage({ viewport: { width: w, height: 900 } });
  await page.addInitScript((t) => { localStorage.setItem("iljobs_theme", t); localStorage.setItem("iljobs_geo_asked", "1"); }, theme);
  await page.route(/\/style\.css(\?|$)/, (r) => r.fulfill({ path: "../../frontend/style.css", contentType: "text/css" }));
  await page.goto("https://oceanofjobs.com/board?country=IL", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("tr[data-id]"); await page.waitForTimeout(2000);
  const r = await page.evaluate(() => {
    const b = (s) => { const e = document.querySelector(s); if (!e) return null; const x = e.getBoundingClientRect(); return [Math.round(x.left), Math.round(x.right), Math.round(x.top), Math.round(x.bottom)]; };
    const list = document.querySelector(".board-list");
    return { rail: b(".filter-rail"), list: b(".board-list"), pane: b("#job-detail"), listScrolls: list.scrollHeight > list.clientHeight, overflowX: document.documentElement.scrollWidth > innerWidth };
  });
  console.log(theme, w, JSON.stringify(r));
  await page.screenshot({ path: `boxes-${theme}-${w}.png`, clip: { x: 0, y: 100, width: w, height: 420 } });
  await page.close();
}
await browser.close();
