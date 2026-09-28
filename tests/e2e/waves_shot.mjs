// The homepage showcase: live waves behind the PC frame on desktop, the
// phone scene unchanged below 720px.
import { chromium } from "playwright";
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
async function shoot(viewport, name, times) {
  const page = await browser.newPage({ viewport });
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  await page.route(/^https:\/\/oceanofjobs\.com\/(\?.*)?$/, (r) => r.fulfill({ path: "../../frontend/index.html", contentType: "text/html" }));
  for (const f of ["style.css", "showcase_waves.js", "hero_nav.js", "img/showcase-pc.webp"])
    await page.route((u) => u.pathname === `/${f}`, (r) => r.fulfill({ path: `../../frontend/${f}`, contentType: f.endsWith("css") ? "text/css" : f.endsWith("webp") ? "image/webp" : "text/javascript" }));
  await page.goto("https://oceanofjobs.com/", { waitUntil: "load" });
  const sec = page.locator(".hero-showcase");
  await sec.scrollIntoViewIfNeeded();
  for (const [i, ms] of times.entries()) {
    await page.waitForTimeout(ms);
    await sec.screenshot({ path: `${name}-${i}.png` });
  }
  console.log(name, await page.evaluate(() => { const c = document.querySelector(".showcase-waves"); return c ? `canvas ${c.width}x${c.height} display=${getComputedStyle(c).display}` : "canvas removed"; }));
  await page.close();
}
await shoot({ width: 1440, height: 900 }, "waves-desktop", [1500, 2500]);
await shoot({ width: 390, height: 844 }, "waves-phone", [800]);
await browser.close();
