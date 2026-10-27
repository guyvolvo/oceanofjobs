// The popup's Fill application on a live Workday job: from the posting
// and from the Create Account step a user lands on by hand. Our API is
// stubbed; on Workday only reads and the sign-in itself go through, so no
// account is made and nothing is sent.
//   node tests/e2e/_ext_workday_fill_live.mjs [job url]
// EMAIL sets the profile's email (default: an address no account has).
// WORKDAY=1 saves WORKDAY_TEST_PASSWORD from .env first; otherwise the
// extension has none and must make one.
import { chromium } from "playwright";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const URL_ = process.argv[2] || "https://intel.wd1.myworkdayjobs.com/en-US/External/job/Israel-Petah-Tikva/DevOps-Engineering-Student_JR0288513";
const EMAIL = process.env.EMAIL || `ooj.nobody.${Date.now()}@example.com`;
const envFile = fs.existsSync(".env") ? fs.readFileSync(".env", "utf8") : "";
const SAVED = process.env.WORKDAY ? (/^WORKDAY_TEST_PASSWORD=(.*)$/m.exec(envFile) || [])[1] : null;
const failures = [];
const check = (name, ok, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}: ${name}${ok ? "" : "  -- " + detail}`); if (!ok) failures.push(name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ext = fs.mkdtempSync(path.join(os.tmpdir(), "ooj-ext-wd-"));
fs.cpSync(path.resolve("extension"), ext, { recursive: true });
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "ooj-ext-wd-profile-")), {
  channel: "chromium", headless: true, viewport: { width: 1280, height: 900 },
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});

const profile = {
  contact: { first_name: "Test", last_name: "Person", email: EMAIL, phone: "+972 50 000 0000", location: "Tel Aviv, Israel" },
  links: {}, work: { authorized_countries: ["IL"] }, eeo: { gender: "decline" }, answers: [], settings: { unknowns: "ai" },
};
const writes = [];
const signIns = [];
await ctx.route("**/*", (r) => {
  const req = r.request();
  const u = new URL(req.url());
  if (u.hostname === "oceanofjobs.com") {
    if (u.pathname === "/api/me/apply/profile") return r.fulfill({ json: { profile, preferences: {} } });
    if (u.pathname === "/api/me/apply/summary") return r.fulfill({ json: { plan: "pro", period: "day", limit: 50, used: 0, remaining: 50 } });
    if (u.pathname === "/api/me/apply/history") return r.fulfill({ json: { applied: [] } });
    if (u.pathname === "/api/me/apply/draft") return r.fulfill({ status: 422, json: { error: "no answer" } });
    return r.fulfill({ status: 204, body: "" });
  }
  if (["GET", "HEAD", "OPTIONS"].includes(req.method())) return r.continue();
  const body = req.postData() || "";
  // Workday's sign-in: a wrong address only gets "wrong email or password".
  if (/\/login$/.test(u.pathname) && !/createAccount|verifyPassword/i.test(body)) {
    signIns.push(body.includes(EMAIL) || body.includes(encodeURIComponent(EMAIL)));
    return r.continue();
  }
  // Workday's page data reads are POSTs under /wday/cxs/ too; anything that
  // makes an account or applies is not let through.
  if (/\/wday\/cxs\//.test(u.pathname) && !/account|apply|submit|application/i.test(u.pathname)) return r.continue();
  writes.push(`${req.method()} ${u.pathname.slice(0, 90)} ${body.includes(EMAIL) ? "(with the email)" : ""}`);
  return r.abort();
});

// What Workday answered the sign-in, the password never printed.
ctx.on("response", async (res) => {
  if (!/\/login$/.test(new URL(res.url()).pathname) || res.request().method() !== "POST") return;
  const body = await res.text().catch(() => "");
  console.log(`  sign-in answered ${res.status()}: ${body.replace(/"password"\s*:\s*"[^"]*"/g, '"password":"***"').slice(0, 300)}`);
});

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
const pdf = "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF";
await sw.evaluate(async ({ data, saved }) => {
  await chrome.storage.local.set({ token: "ooj_test.00000000.x", cv: { name: "CV.pdf", type: "application/pdf", size: data.length, data: btoa(data) } });
  if (saved) await chrome.storage.local.set({ workday: { password: saved } });
  await chrome.alarms.clearAll();
}, { data: pdf, saved: SAVED });
const id = new URL(sw.url()).host;

async function popupFor(tabId) {
  const p = await ctx.newPage();
  await p.addInitScript((tab) => {
    const real = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (q) => (q && q.active ? [await chrome.tabs.get(tab)] : real(q));
  }, tabId);
  await p.goto(`chrome-extension://${id}/popup.html`);
  await p.waitForFunction(() => document.getElementById("fill").textContent !== "Checking this page…", null, { timeout: 30000 });
  return p;
}
const tabOf = () => sw.evaluate(async () => (await chrome.tabs.query({})).filter((t) => (t.url || "").startsWith("http")).sort((a, b) => b.id - a.id)[0].id);
const wd = (page, id) => page.locator(`[data-automation-id="${id}"]`).first();

async function fill(page, label) {
  const tabId = await tabOf();
  const popup = await popupFor(tabId);
  const offered = await popup.textContent("#fill");
  check(`${label}: the popup offers Fill application`, offered === "Fill application", offered);
  if (offered !== "Fill application") return popup.close();
  await popup.click("#fill");
  await popup.waitForFunction(() => document.getElementById("fill").textContent !== "Filling application…", null, { timeout: 150000 }).catch(() => {});
  const note = await popup.textContent("#fill-result");
  console.log(`  result: ${await popup.textContent("#fill")} | ${note}`);
  await popup.close();
  return note;
}

console.log(`${URL_}\nemail: ${EMAIL.replace(/^[^@]+/, "***")}, Workday password ${SAVED ? "saved" : "not saved"}`);

// 1. From the posting.
let page = await ctx.newPage();
await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 60000 });
await sleep(4000);
const note1 = await fill(page, "posting");
const made = await sw.evaluate(async () => ((await chrome.storage.local.get("workday")).workday || {}).password || "");
check("a Workday password is saved", /[a-z]/.test(made) && /[A-Z]/.test(made) && /\d/.test(made) && /[^A-Za-z0-9]/.test(made) && made.length >= 8);
if (!SAVED) check("one was made, since none was saved", made.length === 16);
check("the sign-in went out with the profile's email", signIns.includes(true), JSON.stringify(signIns));
check("not 'No application found'", !/No application found/.test(note1 || ""), note1);
console.log(`  at: ${page.url()}`);
console.log(`  blocked: ${writes.join(" | ").slice(0, 400) || "nothing"}`);
await page.screenshot({ path: path.join(os.tmpdir(), "ooj-wd-posting.png") });
await page.close();

// 2. From the Create Account step, as the user had it.
writes.length = 0;
page = await ctx.newPage();
await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 60000 });
await wd(page, "adventureButton").click({ timeout: 30000 });
await wd(page, "applyManually").click({ timeout: 15000 }).catch(() => {});
await page.waitForSelector('[data-automation-id="signInContent"], [data-automation-id="createAccountSubmitButton"]', { timeout: 20000 });
await sleep(1500);
const note2 = await fill(page, "Create Account step");
check("not 'No application found' on the account step", !/No application found/.test(note2 || ""), note2);
console.log(`  at: ${page.url()}`);
console.log(`  blocked: ${writes.join(" | ").slice(0, 400) || "nothing"}`);
await page.screenshot({ path: path.join(os.tmpdir(), "ooj-wd-account.png") });
await page.close();

await ctx.close();
console.log(failures.length ? `\n${failures.length} failed` : "\nall passed");
process.exit(failures.length ? 1 : 0);
