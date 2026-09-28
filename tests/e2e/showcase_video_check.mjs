// The homepage showcase video: plays on desktop, never fetched on a
// phone. Also reports the features section's height at common widths.
import { chromium } from "playwright";
const browser = await chromium.launch();
const LOCAL = ["style.css", "showcase_video.js", "hero_nav.js", "img/showcase-gradient-poster.webp"];
async function open(viewport) {
  const page = await browser.newPage({ viewport });
  const media = [];
  page.on("request", (r) => { if (r.url().includes("/media/")) media.push(r.url().split("/").pop()); });
  await page.route(/^https:\/\/oceanofjobs\.com\/(\?.*)?$/, (r) => r.fulfill({ path: "../../frontend/index.html", contentType: "text/html" }));
  for (const f of LOCAL)
    await page.route((u) => u.pathname === `/${f}`, (r) => r.fulfill({ path: `../../frontend/${f}`,
      contentType: f.endsWith("css") ? "text/css" : f.endsWith("webp") ? "image/webp" : "text/javascript" }));
  await page.goto("https://oceanofjobs.com/", { waitUntil: "load" });
  return { page, media };
}
for (const w of [1280, 1440, 1920]) {
  const { page } = await open({ width: w, height: 900 });
  const h = await page.evaluate(() => {
    const r = document.querySelector(".hero-features").getBoundingClientRect();
    return `${Math.round(r.width)} x ${Math.round(r.height)}`;
  });
  console.log(`features section at ${w}px wide: ${h}`);
  await page.close();
}
{
  const { page, media } = await open({ width: 1440, height: 900 });
  await page.locator(".hero-showcase").scrollIntoViewIfNeeded();
  await page.waitForTimeout(6000);
  const st = await page.evaluate(() => { const v = document.querySelector(".showcase-video");
    return { src: v.currentSrc.split("/").pop(), ready: v.readyState, t: v.currentTime.toFixed(2), paused: v.paused }; });
  console.log("desktop video:", JSON.stringify(st), "| fetched:", [...new Set(media)]);
  await page.locator(".hero-showcase").screenshot({ path: "showcase-video-desktop.png" });
  await page.close();
}
{
  const { page, media } = await open({ width: 390, height: 844 });
  await page.locator(".hero-showcase").scrollIntoViewIfNeeded();
  await page.waitForTimeout(2000);
  const { page: _p } = { page };
  console.log("phone video fetched:", media.length ? media : "nothing",
    "| features at 390:", await page.evaluate(() => Math.round(document.querySelector(".hero-features").getBoundingClientRect().height)) + "px tall");
  await page.close();
}
await browser.close();
