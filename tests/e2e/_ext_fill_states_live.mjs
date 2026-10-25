// Acceptance pass for 1.8.91's fill button on live application forms.
// Each job is driven through the popup itself: open it (the page check),
// Fill application, close and reopen it, then Review answers. Our API
// is stubbed, every write that would leave the browser is aborted and
// logged, and nothing ever submits a form.
// Run from the repo root: node tests/e2e/_ext_fill_states_live.mjs [url ...]
import { chromium } from "playwright";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const failures = [];
const check = (name, ok, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}: ${name}${ok ? "" : "  -- " + detail}`); if (!ok) failures.push(name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function liveJobs() {
  const out = [];
  for (const ats of ["greenhouse", "ashby", "workable", "lever"]) {
    try {
      const { jobs = [] } = await (await fetch(`https://oceanofjobs.com/api/jobs?ats=${ats}&limit=5&count=skip`, { signal: AbortSignal.timeout(30000) })).json();
      if (jobs[0]) out.push({ ats, url: jobs[0].url });
    } catch (e) { console.log(`no ${ats} job: ${e.message}`); }
    await sleep(800);
  }
  return out;
}
const jobs = process.argv.length > 2 ? process.argv.slice(2).map((url) => ({ ats: "arg", url })) : await liveJobs();

const ext = fs.mkdtempSync(path.join(os.tmpdir(), "ooj-ext-live-"));
fs.cpSync(path.resolve("extension"), ext, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"));
manifest.host_permissions.push("<all_urls>");
fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(manifest));
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "ooj-ext-live-profile-")), {
  channel: "chromium", headless: true, viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
await ctx.addInitScript(() => {
  const none = { register: () => Promise.reject(new Error("blocked")), getRegistrations: async () => [], getRegistration: async () => undefined,
    ready: new Promise(() => {}), controller: null, addEventListener() {}, removeEventListener() {} };
  try { Object.defineProperty(Navigator.prototype, "serviceWorker", { get: () => none, configurable: true }); } catch { /* gone */ }
});

const profile = {
  contact: { first_name: "Test", last_name: "Person", email: "test.person@example.com", phone: "+972 50 000 0000", location: "Tel Aviv, Israel" },
  links: { linkedin: "https://www.linkedin.com/in/test-person" }, work: { authorized_countries: ["IL"], needs_sponsorship: true },
  eeo: { gender: "decline", race: "decline", veteran: "decline", disability: "decline" }, answers: [],
  settings: { mode: "queue", sources: ["board"], unknowns: "ai", guardrails: {} },
};
let writes = [];
await ctx.route("**/*", (r) => {
  const req = r.request();
  const u = new URL(req.url());
  if (u.hostname === "oceanofjobs.com") {
    if (u.pathname === "/api/me/apply/profile") return r.fulfill({ json: { profile, preferences: { skills: ["Python"] } } });
    if (u.pathname === "/api/me/apply/usage" || u.pathname === "/api/me/apply/summary") return r.fulfill({ json: { plan: "pro", period: "day", limit: 50, used: 0, remaining: 50 } });
    if (u.pathname === "/api/me/apply/history") return r.fulfill({ json: { applied: [] } });
    // The AI answers every other question and declines the rest, so a form
    // has both suggested answers and required fields left for the user.
    if (u.pathname === "/api/me/apply/draft") {
      const body = req.postDataJSON();
      const n = (globalThis.__drafts = (globalThis.__drafts || 0) + 1);
      return n % 2 ? r.fulfill({ json: { answer: body.options && body.options.length ? body.options[0] : "Test answer" } })
        : r.fulfill({ status: 422, json: { error: "your profile doesn't answer this question" } });
    }
    return r.fulfill({ status: 204, body: "" });
  }
  if (req.method() === "POST" && /\.s3[.-]([a-z0-9-]+\.)?amazonaws\.com$/.test(u.hostname)) {
    writes.push(`stubbed S3 ${u.hostname}`);
    const key = /name="key"\r\n\r\n([^\r]*)/.exec((req.postDataBuffer() || "").toString("latin1"));
    return r.fulfill({ status: 201, contentType: "application/xml", body: `<PostResponse><Key>${key && key[1]}</Key></PostResponse>` });
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method())) {
    // Reads that happen to be POSTs, which the pages need to load: Ashby's
    // GraphQL queries (not its submit mutation), Cloudflare's and hCaptcha's
    // own checks. Everything else is aborted and logged.
    const body = (req.postData() || "").slice(0, 400);
    const read = (u.pathname === "/api/non-user-graphql" && !/Submit|Mutation/i.test(body))
      || u.pathname.startsWith("/cdn-cgi/challenge-platform") || /hcaptcha\.com$/.test(u.hostname);
    if (read) return r.continue();
    writes.push(`${req.method()} ${u.hostname}${u.pathname}`.slice(0, 120));
    return r.abort();
  }
  return r.continue();
});

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
const pdf = "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF";
await sw.evaluate(async (data) => {
  await chrome.storage.local.set({ token: "ooj_test.00000000.x", cv: { name: "Test_Person_CV.pdf", type: "application/pdf", size: data.length, data: btoa(data) } });
  await chrome.alarms.clearAll();
}, pdf);
const id = new URL(sw.url()).host;

// Every visible field's value in every frame, to prove the page check changed nothing.
const SUBMIT = /\/applications?\b|\/apply\b|submit/i;
const sent = () => writes.filter((w) => !w.startsWith("stubbed") && SUBMIT.test(w.split(" ")[1] || ""));
const values = (page) => Promise.all(page.frames().map((f) => f.evaluate(() =>
  [...document.querySelectorAll("input, select, textarea")].map((e) => (e.type === "checkbox" || e.type === "radio" ? e.checked : e.value)).join("|")).catch(() => "")))
  .then((v) => v.join("#"));

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

for (const job of jobs) {
  console.log(`\n${job.ats}: ${job.url}`);
  writes = [];
  const page = await ctx.newPage();
  try {
    await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(3000);
    const tabId = await sw.evaluate(async () => (await chrome.tabs.query({})).filter((t) => (t.url || "").startsWith("http")).sort((a, b) => b.id - a.id)[0].id);
    const before = await values(page);
    let popup = await popupFor(tabId);
    const offered = await popup.textContent("#fill");
    check("opening the popup checks the page and offers a fill", offered === "Fill application", offered);
    check("the page check changed no field", (await values(page)) === before);
    check("the page check sent no application", !sent().length, sent().join(", "));
    if (writes.length) console.log(`  blocked during the check (the site's own traffic): ${writes.join(", ").slice(0, 200)}`);

    await popup.click("#fill");
    await popup.waitForFunction(() => !["Filling application…", "Fill application"].includes(document.getElementById("fill").textContent), null, { timeout: 90000 })
      .catch(() => {});
    let label = await popup.textContent("#fill");
    const note = await popup.textContent("#fill-result");
    if (/opened\. Click "Fill application" again/.test(note)) {
      // Ashby and Workable: the first click opens the form at its own address.
      await sleep(3000);
      await popup.close();
      popup = await popupFor(tabId);
      await popup.click("#fill");
      await popup.waitForFunction(() => !["Filling application…", "Fill application"].includes(document.getElementById("fill").textContent), null, { timeout: 90000 }).catch(() => {});
      label = await popup.textContent("#fill");
    }
    console.log(`  fill: ${(await popup.textContent("#fill-result")).slice(0, 160)}`);
    check("after the fill: Review answers or Ready to review", ["Review answers", "Ready to review"].includes(label), label);

    await popup.close();
    popup = await popupFor(tabId);
    check("reopening the popup keeps the review", (await popup.textContent("#fill")) === label, await popup.textContent("#fill"));

    if (label === "Review answers") {
      const seen = [];
      for (let i = 0; i < 4; i++) {
        await popup.click("#fill");
        await sleep(700);
        const msg = await popup.textContent("#fill-result");
        const focused = await Promise.all(page.frames().map((f) => f.evaluate(() => {
          const a = document.activeElement;
          return a && a !== document.body && a.closest("[data-ooj-review]") ? a.closest("[data-ooj-review]").dataset.oojReview : null;
        }).catch(() => null))).then((v) => v.find(Boolean));
        seen.push(`${msg.split(".")[0]} -> focus in ${focused || "nothing marked"}`);
        if (/Nothing left/.test(msg)) break;
      }
      seen.forEach((s) => console.log(`  review: ${s}`));
      const kinds = seen.map((s) => (/Required/.test(s) ? "required" : /AI/.test(s) ? "ai" : "other"));
      const firstAi = kinds.indexOf("ai"), lastReq = kinds.lastIndexOf("required");
      check("required fields come before AI answers", firstAi === -1 || lastReq === -1 || lastReq < firstAi, kinds.join(","));
      check("each step focuses the field it names", seen.every((s) => !/Required|AI/.test(s) || !/nothing marked/.test(s)), seen.join(" | "));
    }
    check("nothing was submitted", !sent().length, sent().join(", "));
    await popup.close();
  } catch (e) {
    check("ran without error", false, e.message.split("\n")[0]);
  }
  await page.close();
}

console.log("\nunsupported pages");
for (const url of ["https://chromewebstore.google.com/category/extensions", "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf"]) {
  const page = await ctx.newPage();
  await page.goto(url, { timeout: 30000 }).catch(() => {});
  await sleep(1500);
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({})).filter((t) => !(t.url || "").startsWith("chrome-extension")).sort((a, b) => b.id - a.id)[0].id);
  const popup = await popupFor(tabId);
  const label = await popup.textContent("#fill");
  check(`${new URL(url).hostname}: This site isn't supported, disabled`, label === "This site isn't supported" && (await popup.isDisabled("#fill")), label);
  await popup.close();
  await page.close();
}

await ctx.close();
console.log(failures.length ? `\n${failures.length} failed` : "\nall passed");
process.exit(failures.length ? 1 : 0);
