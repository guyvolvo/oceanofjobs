// Extension 1.9 against a stateful stand-in for /api/me/apply/attempts:
// the release blockers of the attempts migration. Local pages only; the
// form's own POST is counted and answered here, never sent anywhere.
// Run from the repo root: node tests/e2e/_ext_attempts_flow.mjs
import { chromium } from "playwright";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const failures = [];
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}: ${name}${ok ? "" : "  -- " + detail}`); if (!ok) failures.push(name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ext = fs.mkdtempSync(path.join(os.tmpdir(), "ooj-ext-attempts-"));
fs.cpSync(path.resolve("extension"), ext, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"));
manifest.host_permissions.push("<all_urls>");
fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(manifest));
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "ooj-ext-attempts-profile-")), {
  channel: "chromium", headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});

// The careers site: a form whose submit POST is counted. How it answers is
// set per scenario: a thank-you page, the site's own errors, or nothing.
let siteMode = "thanks";
let sitePosts = 0;
const FORM = `<!doctype html><html><head><title>Engineer at Example</title></head><body><h1>Engineer</h1>
<form id="f" method="post" action="/apply/submit">
<label for="first_name">First name</label><input id="first_name" name="first_name" required>
<label for="last_name">Last name</label><input id="last_name" name="last_name" required>
<label for="email">Email</label><input id="email" name="email" type="email" required>
<label for="phone">Phone</label><input id="phone" name="phone" type="tel">
<label for="resume">Resume/CV</label><input id="resume" name="resume" type="file">
<button type="submit">Submit application</button></form></body></html>`;

// The API stand-in: attempts with the contract's states, and failure
// switches per operation.
const server = { attempts: {}, calls: [], fail: {}, filled: [] };
const respond = (r, status, body) => r.fulfill({ status, contentType: "application/json", body: body == null ? "" : JSON.stringify(body) });
const profile = { contact: { first_name: "Test", last_name: "Person", email: "test@example.com", phone: "+972500000000" }, links: {}, work: {}, eeo: {}, answers: [],
  settings: { mode: "queue", sources: ["board", "ats_pages"], unknowns: "skip", guardrails: {} } };

await ctx.route("**/*", async (r) => {
  const req = r.request();
  const u = new URL(req.url());
  if (u.hostname === "careers.example.test") {
    if (req.method() === "POST") {
      sitePosts++;
      if (siteMode === "hang") return; // never answers: no confirmation
      if (siteMode === "errors") return r.fulfill({ contentType: "text/html", body: FORM.replace("<form", '<p class="error" role="alert">Email is required</p><form') });
      return r.fulfill({ contentType: "text/html", body: "<!doctype html><html><body><h1>Thank you for applying!</h1><p>We have received your application.</p></body></html>" });
    }
    // "errors": the page checks the form itself, as most do, and shows its
    // error without sending anything.
    const check = siteMode === "errors" ? `<script>document.getElementById("f").addEventListener("submit", (e) => { e.preventDefault();
      const em = document.getElementById("email"); em.setAttribute("aria-invalid", "true");
      const p = document.createElement("span"); p.className = "error"; p.textContent = "Email is required"; em.after(p); });</script>` : "";
    return r.fulfill({ contentType: "text/html", body: FORM.replace("</body>", check + "</body>") });
  }
  if (u.hostname !== "oceanofjobs.com") return r.continue();
  const p = u.pathname.replace("/api/me/apply/", "");
  const body = req.postDataJSON ? (() => { try { return req.postDataJSON(); } catch { return null; } })() : null;
  server.calls.push(`${req.method()} ${p}`);
  const op = p.split("/").pop();
  if (server.fail[op] && server.fail[op] > 0) { server.fail[op]--; return r.abort(); }
  if (server.fail[op + ":lost"] && server.fail[op + ":lost"] > 0) {
    // Lost response: the server acts, the reply never arrives.
    server.fail[op + ":lost"]--;
    await apiAct(p, body);
    return r.abort();
  }
  if (p === "profile") return respond(r, 200, { profile, preferences: {} });
  if (p === "summary") return respond(r, 200, { plan: "pro", period: "day", limit: 50, used: 0, in_progress: 0, remaining: 50, applied_today: 0,
    unconfirmed: 0, needs_input: 0, queued: 0, disputes_left: 5, ai: { used: 0, limit: 3000 }, tz: "UTC" });
  if (p === "history") return respond(r, 200, { applied: [] });
  if (p === "needs") return respond(r, 200, { needs: [] });
  if (p === "queue") return respond(r, 200, { queue: [] });
  const out = await apiAct(p, body);
  return respond(r, out[0], out[1]);
});

async function apiAct(p, body) {
  if (p === "attempts") {
    const a = server.attempts[body.attempt_id];
    if (a) return [200, { attempt: a }];
    server.attempts[body.attempt_id] = { attempt_id: body.attempt_id, job_id: body.job_id, state: "reserved" };
    return [200, { attempt: server.attempts[body.attempt_id] }];
  }
  if (p === "filled") { server.filled.push(body.attempt_id); return [200, { attempt: { state: "filled" } }]; }
  const [, id, action] = p.split("/");
  const a = server.attempts[id];
  if (!a) return [404, { code: "not_found", error: "no such attempt", retryable: false }];
  if (action === "submission-started") {
    if (server.expireNext) { server.expireNext = false; a.state = "abandoned"; return [410, { code: "expired", error: "the reservation expired; don't submit", retryable: false }]; }
    if (a.state === "submission_started") return [200, { attempt: a, submit: true }];
    if (a.state !== "reserved") return [409, { code: "not_eligible", error: "not eligible", retryable: false }];
    a.state = "submission_started";
    return [200, { attempt: a, submit: true }];
  }
  if (action === "settle") {
    if (a.state === body.outcome) return [200, { attempt: a }];
    if (["submitted", "unconfirmed", "failed", "needs_input", "skipped", "abandoned"].includes(a.state) && !(a.state === "unconfirmed" && body.outcome === "submitted")) {
      return [409, { code: "conflict", error: "already settled", retryable: false }];
    }
    a.state = body.outcome;
    a.settles = (a.settles || 0) + 1;
    return [200, { attempt: a }];
  }
  return [404, { code: "not_found" }];
}

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
await sw.evaluate(async () => {
  await chrome.storage.local.set({ token: "ooj_test.00000000.x", cv: { name: "cv.pdf", type: "application/pdf", size: 4, data: btoa("%PDF") } });
  await chrome.alarms.clearAll();
});

const page = await ctx.newPage();
const fresh = async () => { await page.goto("https://careers.example.test/apply"); await sleep(400); };
const tabId = async () => sw.evaluate(async () => (await chrome.tabs.query({})).find((t) => (t.url || "").startsWith("https://careers.example.test")).id);
const submitHere = async () => sw.evaluate((id) => submitHere({ url: "https://careers.example.test/apply", title: "Engineer", company: "careers.example.test", frameId: 0 },
  { tab: { id }, frameId: 0 }), await tabId());
// Filled by the extension, as the card does before Submit (the button is
// found through the fill's own markers).
const fill = async () => sw.evaluate((id) => fillTab(id), await tabId());
const only = () => Object.values(server.attempts);
const reset = async () => { server.attempts = {}; server.calls = []; server.fail = {}; server.filled = []; sitePosts = 0;
  await sw.evaluate(() => chrome.storage.local.set({ outbox: [], inflight: {} })); };

// 1. Happy path: reserve, gate, click, confirmation, settle submitted.
siteMode = "thanks"; await reset(); await fresh(); await fill();
let r = await submitHere();
check("a confirmed submission: reserve, gate, one click, settled submitted", r && r.submitted && sitePosts === 1
  && only().length === 1 && only()[0].state === "submitted", JSON.stringify({ r, sitePosts, a: only() }));

// 2. A lost reservation response is recovered with the same attempt id.
await reset(); await fresh(); await fill(); server.fail["attempts:lost"] = 1;
r = await submitHere();
check("a lost reservation response: retried with the same attempt id, one attempt", only().length === 1
  && server.calls.filter((c) => c === "POST attempts").length === 2 && r.submitted, JSON.stringify({ calls: server.calls, a: only() }));

// 3. No click without the gate: refused (410) or unreachable.
await reset(); await fresh(); await fill(); server.expireNext = true;
r = await submitHere();
check("an expired reservation at the gate: no click", sitePosts === 0 && r.error, JSON.stringify({ r, sitePosts }));
await reset(); await fresh(); await fill(); server.fail["submission-started"] = 5;
r = await submitHere();
await sleep(300);
const out = await sw.evaluate(() => chrome.storage.local.get("outbox"));
check("the gate unreachable: no click", sitePosts === 0 && r.error, JSON.stringify({ r, sitePosts }));
check("and the reservation is released through the outbox", (only()[0] && only()[0].state === "failed") || out.outbox.some((i) => i.path.endsWith("/settle")),
  JSON.stringify({ a: only(), outbox: out.outbox }));

// 4. A timeout right after the gate: one click, settled unconfirmed, never a second click.
siteMode = "hang"; await reset(); await fresh(); await fill();
r = await submitHere();
await sleep(500);
check("no confirmation after the click: Submission unconfirmed, one click only", r && r.unknown && sitePosts === 1
  && only()[0].state === "unconfirmed", JSON.stringify({ r, sitePosts, a: only() }));
await sw.evaluate(() => run());
check("and nothing retries it", sitePosts === 1);

// 5. The site's own errors: nothing sent, the credit released.
siteMode = "errors"; await reset(); await fresh(); await fill();
r = await submitHere();
check("the site's own validation errors: failed and released, nothing sent", only()[0] && only()[0].state === "failed" && sitePosts === 0,
  JSON.stringify({ r, a: only() }));

// 6. Reports survive the server being down and are delivered later.
siteMode = "thanks"; await reset(); await fresh(); await fill(); server.fail.settle = 50;
r = await submitHere();
let st = await sw.evaluate(() => chrome.storage.local.get(["outbox"]));
check("the settle report waits in the outbox while the server is down", st.outbox.length === 1 && only()[0].state === "submission_started",
  JSON.stringify({ outbox: st.outbox, a: only() }));
server.fail.settle = 0;
await sw.evaluate(() => flushOutbox());
st = await sw.evaluate(() => chrome.storage.local.get(["outbox"]));
check("and is delivered once it's back, then removed", st.outbox.length === 0 && only()[0].state === "submitted", JSON.stringify({ outbox: st.outbox, a: only() }));
await sw.evaluate(() => flushOutbox());
check("delivering again changes nothing", only()[0].settles === 1, JSON.stringify(only()));

// 7. A crash after the gate: reported as unconfirmed on the next start, never submitted.
await reset();
server.attempts.crashed01 = { attempt_id: "crashed01", job_id: "0000000000000001", state: "submission_started" };
server.attempts.crashed02 = { attempt_id: "crashed02", job_id: "0000000000000002", state: "reserved" };
await sw.evaluate(() => chrome.storage.local.set({ inflight: { crashed01: { phase: "started" }, crashed02: { phase: "reserved" } } }));
await sw.evaluate(() => recoverInflight());
check("a crash after the gate: Submission unconfirmed", server.attempts.crashed01.state === "unconfirmed", JSON.stringify(server.attempts.crashed01));
check("a crash before it: released", server.attempts.crashed02.state === "failed", JSON.stringify(server.attempts.crashed02));
check("and nothing is left in flight", Object.keys((await sw.evaluate(() => chrome.storage.local.get("inflight"))).inflight).length === 0);

// 8. A fill from the popup is a Filled entry: no reservation, no click.
await reset(); await fresh();
await sw.evaluate((id) => fillTab(id), await tabId());
await sleep(300);
check("a popup fill records Filled, reserves nothing and sends nothing", server.filled.length === 1 && only().length === 0 && sitePosts === 0,
  JSON.stringify({ filled: server.filled, a: only(), sitePosts }));

// 9. The old routes aren't used for new attempts.
const old = server.calls.filter((c) => /claim|result|usage/.test(c));
check("no new attempt used claim, result or usage", old.length === 0, old.join(", "));

await ctx.close();
console.log(failures.length ? `\n${failures.length} failed` : "\nall passed");
process.exit(failures.length ? 1 : 0);
