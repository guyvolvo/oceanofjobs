// The homepage features as the "Tulips - Blur" cards: the reveal, the
// settled block on desktop (light and dark) and on a phone.
import { chromium } from "playwright";
const browser = await chromium.launch();
const LOCAL = ["style.css", "hero_nav.js", "showcase_video.js", "img/features-tulips.webp", "fonts/Geist-500-latin.woff2"];
const TYPES = { css: "text/css", js: "text/javascript", webp: "image/webp", woff2: "font/woff2" };
async function open(viewport, dark) {
  const page = await browser.newPage({ viewport });
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  if (dark) await page.addInitScript(() => localStorage.setItem("iljobs_theme", "dark"));
  await page.route(/^https:\/\/oceanofjobs\.com\/(\?.*)?$/, (r) => r.fulfill({ path: "../../frontend/index.html", contentType: "text/html" }));
  for (const f of LOCAL)
    await page.route((u) => u.pathname === `/${f}`, (r) => r.fulfill({ path: `../../frontend/${f}`, contentType: TYPES[f.split(".").pop()] }));
  await page.goto("https://oceanofjobs.com/", { waitUntil: "load" });
  return page;
}
{
  const page = await open({ width: 1440, height: 900 });
  const sec = page.locator(".hero-features");
  await sec.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(250);
  await page.screenshot({ path: "tulips-reveal.png" });
  await page.waitForTimeout(1800);
  await page.screenshot({ path: "tulips-desktop.png" });
  const box = await sec.boundingBox();
  console.log("block", Math.round(box.width), "x", Math.round(box.height),
    "| cards:", await page.evaluate(() => [...document.querySelectorAll(".feature-card")].map((c) => { const r = c.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.top)}`; }).join(" ")),
    "| title font:", await page.evaluate(() => { const h = document.querySelector(".feature-card h2"); return getComputedStyle(h).fontSize + " " + (document.fonts.check('500 64px "Geist"') ? "Geist loaded" : "Geist missing"); }));
  await page.mouse.wheel(0, 300); await page.waitForTimeout(600);
  console.log("drift after scroll:", await sec.evaluate((el) => el.style.getPropertyValue("--drift")));
  await page.close();
}
{
  const page = await open({ width: 1440, height: 900 }, true);
  await page.locator(".hero-features").evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(2000);
  await page.screenshot({ path: "tulips-dark.png" });
  await page.close();
}
{
  const page = await open({ width: 390, height: 844 });
  const sec = page.locator(".hero-features");
  await sec.evaluate((el) => el.scrollIntoView({ block: "start" }));
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 250); await page.waitForTimeout(250); }
  await page.waitForTimeout(1500);
  await sec.screenshot({ path: "tulips-phone.png" });
  console.log("phone cards:", await page.evaluate(() => [...document.querySelectorAll(".feature-card")].map((c) => Math.round(c.getBoundingClientRect().height)).join(" ")),
    "| page overflow:", await page.evaluate(() => document.documentElement.scrollWidth > innerWidth));
  await page.close();
}
await browser.close();
