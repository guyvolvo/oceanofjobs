// /apply#settings: the setup guide opens for a new account, walks through
// the steps for "full automation" on Pro with a resume, and saves Full
// automatic and Auto-apply mode on Finish. Local build (apply/dist) over
// the live page; every /api call is answered here.
//   (cd apply && npx vite build) && node tests/e2e/_apply_onboarding.mjs <screenshot dir>
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const OUT = process.argv[2] || ".";
const DIST = path.resolve("apply/dist");
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const idToken = `${b64({ alg: "none" })}.${b64({ sub: "u1", email: "a@b.c", exp: Math.floor(Date.now() / 1000) + 3600 })}.x`;
const profile = { contact: { first_name: "A", last_name: "B", email: "a@b.c", phone: "", location: "" }, links: { linkedin: "", github: "", website: "" },
  work: { authorized_countries: [], needs_sponsorship: null, notice_period: "", salary: "" }, eeo: {}, answers: [],
  settings: { mode: "queue", fill: "half", sources: ["board", "matches"], unknowns: "ai", consent: true,
    guardrails: { min_match: null, daily_limit: null, blocked_companies: [], one_per_company_days: null } } };
const sent = [];
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));
await p.addInitScript((t) => localStorage.setItem("iljobs_auth_tokens", JSON.stringify({ id_token: t, access_token: t, refresh_token: "r" })), idToken);
await p.route("https://oceanofjobs.com/**", (r) => {
  const u = new URL(r.request().url());
  const m = r.request().method();
  if (u.pathname.startsWith("/api/")) {
    if (m !== "GET") sent.push([m, u.pathname, r.request().postData() ? JSON.parse(r.request().postData()) : null]);
    if (u.pathname === "/api/me/apply/profile") return r.fulfill({ json: m === "PUT" ? { profile: JSON.parse(r.request().postData()).profile } : { profile, onboarded: sent.length > 0 } });
    if (u.pathname === "/api/me/apply/agent") return r.fulfill({ json: { agent: { resume: { name: "cv.pdf", chars: 900, truncated: false, uploaded_at: "2026-10-28" }, editable: true,
      version: 1, style: {}, topics: [], facts: [], never_claim: [] } } });
    if (u.pathname === "/api/me/apply/summary") return r.fulfill({ json: { plan: "pro", period: "day", limit: 50, remaining: 50, used: 0, in_progress: 0,
      applied_today: 0, filled_today: 0, unconfirmed: 0, needs_input: 0, queued: 0, disputes_left: 3, ai: { used: 0, limit: 3000 } } });
    if (u.pathname === "/api/me/apply/onboarded") return r.fulfill({ status: 204, body: "" });
    return r.fulfill({ json: { queue: [], needs: [], applied: [] } });
  }
  const local = u.pathname === "/apply" ? "index.html" : u.pathname.replace(/^\/apply\//, "");
  const file = path.join(DIST, local);
  if (fs.existsSync(file) && fs.statSync(file).isFile()) return r.fulfill({ path: file });
  return r.continue();
});

await p.goto("https://oceanofjobs.com/apply#settings", { waitUntil: "load" });
const dlg = p.getByRole("dialog");
await dlg.getByText("Set up auto apply").waitFor({ timeout: 15000 });
await p.screenshot({ path: `${OUT}/setup-1.png` });
await dlg.getByRole("button", { name: "Next" }).click();
await dlg.getByText("I prefer full automation", { exact: false }).click();
await p.waitForTimeout(200);
await p.screenshot({ path: `${OUT}/setup-2.png` });
const steps = [];
await dlg.getByRole("button", { name: "Next" }).click();
for (let i = 0; i < 4; i++) {
  const title = (await dlg.locator(".oj-card-title").first().innerText()).trim();
  steps.push(title);
  if (title === "Connect the extension") await dlg.getByRole("button", { name: "Later" }).click();
  else if (title === "Turn on Auto-apply mode?") await dlg.getByRole("button", { name: "Turn on" }).click();
  else if (title === "You're set") { await p.screenshot({ path: `${OUT}/setup-3.png` }); console.log("summary:", (await dlg.locator(".oj-setup-list").innerText()).replace(/\n/g, " | ")); await dlg.getByRole("button", { name: "Finish" }).click(); break; }
}
await p.waitForTimeout(800);
console.log("steps:", steps.join(" -> "));
const put = sent.find(([m, u]) => m === "PUT" && u.endsWith("/profile"));
console.log("saved settings:", put ? JSON.stringify({ fill: put[2].profile.settings.fill, unknowns: put[2].profile.settings.unknowns, mode: put[2].profile.settings.mode }) : "none");
console.log("recorded:", JSON.stringify(sent.find(([, u]) => u.endsWith("/onboarded"))?.[2]));
await p.waitForTimeout(1500);
console.log("guide closed:", !(await p.getByText("You're set").isVisible().catch(() => false)), "errors:", errs.length ? errs : "none");
await p.screenshot({ path: `${OUT}/setup-4.png` });
await b.close();
