// The homepage logo band: two rows of wordmarks centred under the claim,
// a little wider than it, moving in opposite directions, readable in both
// themes and on a phone.
import { chromium } from "playwright";
import { readdirSync } from "fs";
const browser = await chromium.launch();
const LOCAL = ["style.css", "fonts/Geist-500-latin.woff2", ...readdirSync("../../frontend/img/wordmarks").map((f) => `img/wordmarks/${f}`)];
async function open(viewport, dark) {
  const page = await browser.newPage({ viewport });
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  await page.addInitScript((d) => localStorage.setItem("iljobs_theme", d ? "dark" : "light"), dark);
  await page.route(/^https:\/\/oceanofjobs\.com\/(\?.*)?$/, (r) => r.fulfill({ path: "../../frontend/index.html", contentType: "text/html" }));
  for (const f of LOCAL) await page.route((u) => u.pathname === `/${f}`, (r) => r.fulfill({ path: `../../frontend/${f}` }));
  await page.goto("https://oceanofjobs.com/", { waitUntil: "load" });
  await page.waitForTimeout(2500);
  return page;
}
for (const [name, vp, dark] of [["light", { width: 1440, height: 900 }, false], ["dark", { width: 1440, height: 900 }, true], ["phone", { width: 390, height: 844 }, false]]) {
  const page = await open(vp, dark);
  const info = await page.evaluate(() => {
    const r = document.createRange(); r.selectNodeContents(document.querySelector(".hero-claim"));
    const claim = r.getBoundingClientRect(), band = document.querySelector(".logo-band").getBoundingClientRect();
    const x = (id) => new DOMMatrix(getComputedStyle(document.getElementById(id)).transform).m41;
    return { claimW: Math.round(claim.width), bandW: Math.round(band.width), bandCentre: Math.round(band.left + band.width / 2), pageCentre: Math.round(innerWidth / 2),
             a: x("ticker-logos-a"), b: x("ticker-logos-b"), marks: document.querySelectorAll(".logo-band img").length, overflow: document.documentElement.scrollWidth > innerWidth };
  });
  await page.waitForTimeout(800);
  const moved = await page.evaluate(() => ["ticker-logos-a", "ticker-logos-b"].map((id) => new DOMMatrix(getComputedStyle(document.getElementById(id)).transform).m41));
  console.log(name, `claim ${info.claimW}px, band ${info.bandW}px, centred ${info.bandCentre}/${info.pageCentre}, marks ${info.marks}, rows ${Math.sign(moved[0] - info.a)}/${Math.sign(moved[1] - info.b)}, overflow ${info.overflow}`);
  await page.screenshot({ path: `logo-band-${name}.png`, clip: { x: 0, y: 0, width: vp.width, height: Math.min(vp.height, name === "phone" ? 560 : 520) } });
  await page.close();
}
await browser.close();
