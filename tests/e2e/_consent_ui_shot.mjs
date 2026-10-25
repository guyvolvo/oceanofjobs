// The terms and newsletter boxes in the sign-in window, the banner and
// window that ask existing members to agree, and the pricing waitlist,
// against the local preview (scripts/live_preview.py) with /api/me/* stubbed.
//   node tests/e2e/_consent_ui_shot.mjs <outdir>
import { chromium } from "playwright";
const BASE = process.env.BASE || "http://localhost:8023";
const out = process.argv[2];
const errors = [];
const payload = Buffer.from(JSON.stringify({ email: "dana@example.com", exp: Math.floor(Date.now() / 1000) + 3600, sub: "x" })).toString("base64url");
const TOKENS = JSON.stringify({ id_token: `x.${payload}.x`, access_token: "a", refresh_token: "r" });

async function page(b, { signedIn, consent, scheme = "dark", posts }) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: scheme, deviceScaleFactor: 1.5 });
  await ctx.route("**/api/me/**", (r) => {
    const p = new URL(r.request().url()).pathname;
    if (r.request().method() !== "GET") posts && posts.push(`${r.request().method()} ${p} ${r.request().postData() || ""}`);
    if (p === "/api/me/consent") return r.fulfill({ json: r.request().method() === "POST" ? { ...consent, agreed: true } : consent });
    if (p === "/api/me/waitlist") return r.fulfill({ json: { ...consent, waitlist: [...consent.waitlist, JSON.parse(r.request().postData()).plan] } });
    return r.fulfill({ json: {} });
  });
  await ctx.addInitScript(({ signedIn, tokens, scheme }) => {
    localStorage.setItem("iljobs_theme", scheme);
    localStorage.setItem("ooj_cookie_consent", "declined");
    if (signedIn) localStorage.setItem("iljobs_auth_tokens", tokens);
  }, { signedIn, tokens: TOKENS, scheme });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  return { ctx, p };
}

const b = await chromium.launch();
const base = { agreed: false, version: "2026-10-25", lock_from: "2026-11-02", newsletter: false, waitlist: [] };

// 1. Signed out: the sign-in window with the two boxes, then a click without agreeing.
let { ctx, p } = await page(b, { signedIn: false, consent: base });
await p.goto(BASE + "/", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(1500);
await p.evaluate(() => window.openSignIn());
await p.waitForTimeout(400);
await p.locator(".signin-dialog").screenshot({ path: `${out}/1-signin-boxes.png` });
await p.click("#signin-google");
await p.waitForTimeout(300);
await p.locator(".signin-dialog").screenshot({ path: `${out}/2-signin-terms-required.png` });
await ctx.close();

// 2. An existing member who hasn't agreed, before the lock: the banner, then its window.
({ ctx, p } = await page(b, { signedIn: true, consent: base }));
await p.goto(BASE + "/board", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(2500);
await p.screenshot({ path: `${out}/3-banner.png`, clip: { x: 0, y: 860 - 120, width: 1280, height: 120 } });
await p.click(".consent-banner-go");
await p.waitForTimeout(400);
await p.locator(".signin-dialog").screenshot({ path: `${out}/4-agree-window.png` });
await ctx.close();

// 3. After the lock date: the window opens by itself and can't be closed.
({ ctx, p } = await page(b, { signedIn: true, consent: { ...base, lock_from: "2026-01-01" } }));
await p.goto(BASE + "/", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(2500);
await p.locator(".signin-dialog").screenshot({ path: `${out}/5-agree-window-locked.png` });
await ctx.close();

// 4. Pricing: join Basic's waitlist; Pro already joined.
const posts = [];
({ ctx, p } = await page(b, { signedIn: true, consent: { ...base, agreed: true, waitlist: ["pro"] }, scheme: "light", posts }));
await p.addInitScript(() => localStorage.setItem("ooj_terms_agreed", "2026-10-25"));
await p.goto(BASE + "/pricing", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(2000);
await p.locator(".ptable tfoot").screenshot({ path: `${out}/6-pricing-before.png` });
await p.locator('.ptable [data-waitlist="basic"]').click();
await p.waitForTimeout(600);
await p.locator(".ptable tfoot").screenshot({ path: `${out}/7-pricing-joined.png` });
console.log("posts:", posts.join(" | "));
await ctx.close();
await b.close();
console.log(errors.length ? "errors:\n" + errors.join("\n") : "no page errors");
