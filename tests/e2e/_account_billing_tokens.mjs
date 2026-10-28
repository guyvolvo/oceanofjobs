// /account: the Billing tab shows the plan from GET /me/billing, and a
// token's Edit saves its name and permissions with PATCH /me/tokens/<id>.
// Local account build (apply/dist) over the live page, signed in with a
// made-up token; every /api/me call is answered here.
//   (cd apply && npx vite build) && node tests/e2e/_account_billing_tokens.mjs <screenshot dir>
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const OUT = process.argv[2] || ".";
const DIST = path.resolve("apply/dist");
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const idToken = `${b64({ alg: "none" })}.${b64({ sub: "u1", email: "a@b.c", exp: Math.floor(Date.now() / 1000) + 3600 })}.x`;
const tokens = [
  { id: "aaaaaaaa", name: "Chrome extension", hint: "QOIM", created_at: "2026-10-28T08:00:00Z", scope: "extension" },
  { id: "bbbbbbbb", name: "claude", hint: "Vz9n", created_at: "2026-10-20T08:00:00Z", expires_at: "2027-01-18T08:00:00Z", scope: "mcp",
    permissions: { saved: "write", queue: "write", alerts: "write", preferences: "write" } },
];
const patches = [];
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
await p.addInitScript((t) => localStorage.setItem("iljobs_auth_tokens", JSON.stringify({ id_token: t, access_token: t, refresh_token: "r" })), idToken);
await p.route("https://oceanofjobs.com/**", (r) => {
  const u = new URL(r.request().url());
  const m = r.request().method();
  if (u.pathname.startsWith("/api/")) {
    if (u.pathname.startsWith("/api/me/tokens/") && m === "PATCH") {
      const body = JSON.parse(r.request().postData());
      patches.push({ id: u.pathname.split("/").pop(), ...body });
      const t = tokens.find((x) => x.id === u.pathname.split("/").pop());
      Object.assign(t, body);
      return r.fulfill({ json: t });
    }
    const json = u.pathname === "/api/me/billing" ? { paid: { plan: "pro", status: "trialing", period_end: "2026-11-04T10:00:00Z" }, license: null, customer: true }
      : u.pathname === "/api/me/tokens" ? { tokens } : u.pathname === "/api/me/alerts" ? { alerts: [] }
      : u.pathname === "/api/me/saved" ? { saved: [] } : u.pathname === "/api/me/profile" ? { profile: {} } : {};
    return r.fulfill({ json });
  }
  const local = u.pathname === "/account" ? "account.html" : u.pathname.replace(/^\/apply\//, "");
  const file = path.join(DIST, local);
  if (fs.existsSync(file) && fs.statSync(file).isFile()) return r.fulfill({ path: file });
  return r.continue();
});

await p.goto("https://oceanofjobs.com/account#billing", { waitUntil: "load" });
await p.waitForSelector("text=Free trial", { timeout: 15000 });
const billing = await p.locator("main").innerText();
console.log("billing tab:", billing.replace(/\s+/g, " ").slice(0, 300));
await p.screenshot({ path: `${OUT}/billing-tab.png`, fullPage: false });

await p.goto("https://oceanofjobs.com/account#settings", { waitUntil: "load" });
await p.waitForSelector("text=Personal access tokens", { timeout: 15000 });
console.log("billing row gone from Settings:", !(await p.locator("text=Manage billing").count()));
await p.locator("tr", { hasText: "claude" }).getByRole("button", { name: "Edit" }).click();
const dlg = p.getByRole("dialog");
await dlg.getByLabel("Token name").fill("Claude Code laptop");
await dlg.getByText("Read all").first().click(); // with Read all already on, this turns reading off everywhere
await p.screenshot({ path: `${OUT}/token-edit.png` });
console.log("nothing-allowed warning:", await dlg.getByText("Give the token at least one permission").count() > 0);
await dlg.getByText("Read all").first().click(); // back on: read everything, write nothing
await dlg.getByRole("button", { name: "Save" }).click();
await p.waitForTimeout(800);
console.log("PATCH sent:", JSON.stringify(patches));
console.log("row renamed:", await p.locator("text=Claude Code laptop").count() > 0);
await p.locator("text=Personal access tokens").scrollIntoViewIfNeeded();
await p.screenshot({ path: `${OUT}/token-rows.png` });
await p.locator("tr", { hasText: "Chrome extension" }).getByRole("button", { name: "Edit" }).click();
console.log("extension token offers no permissions:", (await p.getByRole("dialog").getByText("Read all").count()) === 0);
await b.close();
