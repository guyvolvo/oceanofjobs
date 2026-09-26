// The board's top bar at desktop, light and dark, signed out and signed
// in, working copy CSS over the live site. node tests/e2e/topbar_size_shot.mjs
import { chromium } from "playwright";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const TOK = [b64({ alg: "RS256" }), b64({ sub: "x", email: "guy@example.com", exp: now + 3600 }), "s"].join(".");
const browser = await chromium.launch();
for (const [name, theme, signed] of [["light-out", "light", false], ["dark-in", "dark", true]]) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 300 } });
  await page.addInitScript(([t, tok, s]) => {
    localStorage.setItem("iljobs_theme", t); localStorage.setItem("iljobs_geo_asked", "1");
    if (s) localStorage.setItem("iljobs_auth_tokens", JSON.stringify({ id_token: tok, access_token: tok, refresh_token: "r" }));
  }, [theme, TOK, signed]);
  await page.route(/\/style\.css(\?|$)/, (r) => r.fulfill({ path: "../../frontend/style.css", contentType: "text/css" }));
  await page.route((u) => u.pathname.startsWith("/api/me/"), (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"alerts":[],"saved":[],"profile":{}}' }));
  await page.goto("https://oceanofjobs.com/board", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const m = await page.evaluate(() => {
    const h = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().height) : "-"; };
    const knob = document.querySelector(".theme-knob").getBoundingClientRect(), sw = document.querySelector(".theme-toggle").getBoundingClientRect();
    const ico = (s) => { const r = document.querySelector(s).getBoundingClientRect(); return Math.round(r.left + r.width / 2 - sw.left); };
    return { bar: h(".topbar .container"), search: h(".topbar-search"), select: h(".topbar-sorts select"), mark: h(".topbar-mark img"),
             knobCenter: Math.round(knob.left + knob.width / 2 - sw.left), moon: ico(".theme-ico-moon"), sun: ico(".theme-ico-sun") };
  });
  console.log(name, JSON.stringify(m));
  await page.screenshot({ path: `topbar-size-${name}.png`, clip: { x: 0, y: 0, width: 1600, height: 110 } });
  await page.close();
}
await browser.close();
