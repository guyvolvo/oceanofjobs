import { chromium } from "playwright";
const browser = await chromium.launch();
for (const theme of ["light", "dark"]) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript((t) => { localStorage.setItem("iljobs_geo_asked", "1"); localStorage.setItem("iljobs_theme", t); localStorage.setItem("iljobs_rail_open", JSON.stringify(["role", "employer"])); }, theme);
  await page.route(/\/app\.js(\?|$)/, (r) => r.fulfill({ path: "../../frontend/app.js", contentType: "application/javascript" }));
  await page.route(/\/style\.css(\?|$)/, (r) => r.fulfill({ path: "../../frontend/style.css", contentType: "text/css" }));
  await page.goto("https://oceanofjobs.com/board?country=IL", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('.rail-acc[data-acc="employer"].open .rail-count', { timeout: 30000 }); await page.waitForTimeout(1500);
  console.log(theme, await page.evaluate(() => [...document.querySelectorAll(".rail-acc.open .rail-option:not(.rail-bone)")].slice(0, 6).map((o) => {
    const c = o.querySelector(".rail-count"), l = o.querySelector(".rail-option-label");
    return `${l ? l.innerText.trim().slice(0, 14) : "?"}: label ${l ? getComputedStyle(l).fontSize : "?"} count ${c ? getComputedStyle(c).fontSize + " " + getComputedStyle(c).color : "?"}${o.classList.contains("on") ? " (ticked)" : ""}`;
  })));
  await page.close();
}
await browser.close();
