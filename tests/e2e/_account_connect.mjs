// /account/connect: an app asks to use the account; Allow posts the chosen
// permissions and goes back to the app with the code, Cancel goes back with
// access_denied, and an unknown host is flagged. Local build over the live
// page, signed in with a made-up token; every /api call is answered here.
//   (cd apply && npx vite build) && node tests/e2e/_account_connect.mjs <screenshot dir>
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const OUT = process.argv[2] || ".";
const DIST = path.resolve("apply/dist");
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const idToken = `${b64({ alg: "none" })}.${b64({ sub: "u1", email: "a@b.c", exp: Math.floor(Date.now() / 1000) + 3600 })}.x`;
const CB = "https://claude.ai/api/mcp/auth_callback";
const query = (redirect) => new URLSearchParams({ client_id: "cid", redirect_uri: redirect, response_type: "code", code_challenge: "c".repeat(43),
  code_challenge_method: "S256", state: "st", resource: "https://oceanofjobs.com/mcp" });
let posted = null;
const fail = [];
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"}: ${name}`); if (!cond) fail.push(name); };

const b = await chromium.launch();
async function page(width) {
  const p = await b.newPage({ viewport: { width, height: 900 } });
  await p.addInitScript((t) => { localStorage.setItem("iljobs_auth_tokens", JSON.stringify({ id_token: t, access_token: t, refresh_token: "r" })); localStorage.setItem("ooj_cookie_consent", "no"); }, idToken);
  await p.route("https://claude.ai/**", (r) => r.fulfill({ body: "<p>back at the app</p>", contentType: "text/html" }));
  await p.route("https://agent.example/**", (r) => r.fulfill({ body: "<p>back at the app</p>", contentType: "text/html" }));
  await p.route("https://oceanofjobs.com/**", (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/api/oauth/client") {
      const host = new URL(u.searchParams.get("redirect_uri")).hostname;
      return u.searchParams.get("client_id") === "bad" ? r.fulfill({ status: 400, json: { error: "invalid_client" } })
        : r.fulfill({ json: { name: host === "claude.ai" ? "Claude" : "Helper", host, known: host === "claude.ai" } });
    }
    if (u.pathname === "/api/me/oauth/authorize") {
      posted = JSON.parse(r.request().postData());
      return r.fulfill({ json: { redirect: `${posted.redirect_uri}?code=thecode&iss=https%3A%2F%2Foceanofjobs.com&state=${posted.state}` } });
    }
    if (u.pathname.startsWith("/api/")) return r.fulfill({ json: {} });
    const local = u.pathname.startsWith("/account") ? "account.html" : u.pathname.replace(/^\/apply\//, "");
    const file = path.join(DIST, local);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return r.fulfill({ path: file });
    return r.continue();
  });
  return p;
}

const p = await page(1280);
await p.goto(`https://oceanofjobs.com/account/connect?${query(CB)}`, { waitUntil: "load" });
await p.waitForSelector("text=wants to use your Ocean of Jobs account", { timeout: 15000 });
ok("names the app", await p.getByText("Claude wants to use your Ocean of Jobs account").count() === 1);
ok("no warning for claude.ai", await p.getByText("Allow it only if").count() === 0);
await p.screenshot({ path: `${OUT}/connect.png`, fullPage: true });
await p.getByRole("button", { name: "Allow" }).click();
await p.waitForURL((u) => u.hostname === "claude.ai", { timeout: 10000 });
ok("allow goes back to the app with the code and state", p.url().startsWith(CB + "?code=thecode") && p.url().includes("state=st"));
ok("allow posted the request and the default permissions", posted && posted.client_id === "cid" && posted.code_challenge_method === "S256"
  && posted.permissions.saved === "write" && posted.permissions.queue === "read");

const q = await page(390);
await q.goto(`https://oceanofjobs.com/account/connect?${query("https://agent.example/cb")}`, { waitUntil: "load" });
await q.waitForSelector("text=wants to use your Ocean of Jobs account", { timeout: 15000 });
ok("an unknown host is flagged", await q.getByText("This sends access to agent.example").count() === 1);
await q.screenshot({ path: `${OUT}/connect-unknown-phone.png`, fullPage: true });
await q.getByRole("button", { name: "Cancel" }).click();
await q.waitForURL((u) => u.hostname === "agent.example", { timeout: 10000 });
ok("cancel goes back with access_denied", q.url().includes("error=access_denied") && q.url().includes("state=st") && q.url().includes("iss="));

const r = await page(1280);
await r.goto(`https://oceanofjobs.com/account/connect?${new URLSearchParams({ client_id: "bad", redirect_uri: CB })}`, { waitUntil: "load" });
await r.waitForSelector("text=isn't valid", { timeout: 15000 });
ok("a bad link says so", true);
await b.close();
process.exit(fail.length ? 1 : 0);
