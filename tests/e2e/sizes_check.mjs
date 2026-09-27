import { chromium } from "playwright";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const TOK = [b64({ alg: "RS256" }), b64({ sub: "x", email: "g@example.com", exp: now + 3600 }), "s"].join(".");
const browser = await chromium.launch();
for (const signed of [false, true]) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(([tok, s]) => { localStorage.setItem("iljobs_geo_asked", "1"); if (s) localStorage.setItem("iljobs_auth_tokens", JSON.stringify({ id_token: tok, access_token: tok, refresh_token: "r" })); }, [TOK, signed]);
  await page.route(/\/app\.js(\?|$)/, (r) => r.fulfill({ path: "../../frontend/app.js", contentType: "application/javascript" }));
  await page.route(/\/style\.css(\?|$)/, (r) => r.fulfill({ path: "../../frontend/style.css", contentType: "text/css" }));
  await page.route((u) => u.pathname.startsWith("/api/me/"), (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"alerts":[],"saved":[],"profile":{}}' }));
  await page.goto("https://oceanofjobs.com/board?country=IL", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".rail-acc.open .rail-option:not(.rail-bone)", { timeout: 30000 }); await page.waitForTimeout(2000);
  console.log(signed ? "signed in" : "signed out", await page.evaluate(() => {
    const f = (sel) => { const e = document.querySelector(sel); if (!e) return "none"; const cs = getComputedStyle(e); return `${cs.fontSize} ${cs.fontWeight} ${cs.fontFamily.split(",")[0]} ${cs.color}`; };
    const opt = document.querySelector(".rail-acc.open .rail-option:not(.rail-bone)"); const count = opt && opt.lastElementChild;
    return { nav: f(".topbar-nav a"), account: f("#topbar-account-btn") , login: f("#auth-trigger"),
             railLabel: opt ? `${getComputedStyle(opt).fontSize} ${opt.innerText.replace(/s+/g, " ").slice(0, 30)}` : "none", countClass: count ? count.className : "?", count: count ? `${getComputedStyle(count).fontSize} ${getComputedStyle(count).color}` : "?" };
  }));
  await page.close();
}
await browser.close();
