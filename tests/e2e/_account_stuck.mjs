// /account#alerts left open past the 15 s watchdog: the alerts that loaded
// stay on screen instead of "This is taking longer than it should".
// Serves the local account build (apply/dist) over the live page, signed
// in with a made-up token; every /api/me call is answered here.
//   (cd apply && npx vite build) && node tests/e2e/_account_stuck.mjs
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const DIST = path.resolve("apply/dist");
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const idToken = `${b64({ alg: "none" })}.${b64({ sub: "u1", email: "a@b.c", exp: Math.floor(Date.now() / 1000) + 3600 })}.x`;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
await p.addInitScript((t) => localStorage.setItem("iljobs_auth_tokens", JSON.stringify({ id_token: t, access_token: t, refresh_token: "r" })), idToken);
await p.route("https://oceanofjobs.com/**", (r) => {
  const u = new URL(r.request().url());
  if (u.pathname.startsWith("/api/")) {
    const json = u.pathname === "/api/me/alerts" ? { alerts: [] } : u.pathname === "/api/me/saved" ? { saved: [] }
      : u.pathname === "/api/me/profile" ? { profile: {} } : {};
    return r.fulfill({ json });
  }
  const local = u.pathname === "/account" ? "account.html" : u.pathname.replace(/^\/apply\//, "");
  const file = path.join(DIST, local);
  if (fs.existsSync(file) && fs.statSync(file).isFile()) return r.fulfill({ path: file });
  return r.continue();
});
await p.goto("https://oceanofjobs.com/account#alerts", { waitUntil: "load" });
await p.waitForTimeout(3000);
const before = await p.locator("body").innerText();
await p.waitForTimeout(15000);
const after = await p.locator("body").innerText();
const stuck = /taking longer than it should/.test(after);
console.log("at 3s, alerts loaded:", /No alerts yet/.test(before), "| at 18s, stuck message:", stuck, "| still listed:", /No alerts yet/.test(after));
await b.close();
process.exit(stuck ? 1 : 0);
