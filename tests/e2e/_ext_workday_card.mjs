// Fill application on a Workday-shaped application (sign-in, My
// Information, Questions, Review), from the page card and the popup, in
// Half and Full automatic. The site and the API are Playwright routes
// served here (the test copy's API address is .invalid), so nothing reaches
// Workday or oceanofjobs.com, and the Review page's Submit only counts the press.
//   node tests/e2e/_ext_workday_card.mjs
// EXT=<folder> runs it against another copy of the extension (a baseline).
import { chromium } from "playwright";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const PAGE = "https://acme.wd1.myworkdayjobs.com/en-US/External/job/Remote/Software-Engineer_JR1001/apply/applyManually";
const failures = [];
const check = (name, ok, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}: ${name}${ok ? "" : "  -- " + detail}`); if (!ok) failures.push(name); };

const ext = fs.mkdtempSync(path.join(os.tmpdir(), "ooj-ext-wdcard-"));
fs.cpSync(path.resolve(process.env.EXT || "extension"), ext, { recursive: true });
const detect = path.join(ext, "detect.js");
fs.writeFileSync(detect, fs.readFileSync(detect, "utf8").replace("mode: 'closed'", "mode: 'open'"));
const API = "https://ooj-test.invalid/api";
const bg = path.join(ext, "background.js");
fs.writeFileSync(bg, fs.readFileSync(bg, "utf8").replace("const API = 'https://oceanofjobs.com/api';", `const API = '${API}';`));

// One page, its steps drawn in the same applyFlowPage as Workday does. Next
// with a required field empty shows Workday's error and stays. "vanish":
// after Submit the application goes away with no confirmation.
const site = (start, vanish) => `<!doctype html><html><head><title>Software Engineer</title></head><body>
<h1>Software Engineer</h1>
<div data-automation-id="applyFlowPage"><div data-automation-id="progressBar"><span data-automation-id="progressBarActiveStep" id="step"></span></div>
<div id="body"></div></div>
<script>
  window.nexts = 0; window.submits = 0; window.blocked = 0; window.signedInAs = null;
  const steps = {
    signin: ["Sign In", '<div data-automation-id="signInContent"><label for="em">Email Address</label><input id="em" data-automation-id="email" type="email">'
      + '<label for="pw">Password</label><input id="pw" data-automation-id="password" type="password">'
      + '<button data-automation-id="signInSubmitButton" id="signin">Sign In</button></div>'],
    info: ["My Information", '<label for="first">First Name *</label><input id="first" required>'
      + '<label for="last">Last Name *</label><input id="last" required>'
      + '<label for="email">Email Address *</label><input id="email" type="email" required>'
      + '<label for="phone">Phone Number</label><input id="phone" type="tel">'
      + '<label for="cv">Resume/CV</label><input id="cv" type="file">'],
    questions: ["Application Questions", '<fieldset><legend>Will you now or in the future require visa sponsorship? *</legend>'
      + '<label><input type="radio" name="sp" value="yes" required>Yes</label><label><input type="radio" name="sp" value="no">No</label></fieldset>'
      + '<label for="why">Why do you want to work here? *</label><textarea id="why" required></textarea>'],
    review: ["Review", '<h2>Review</h2><p>Check your application before you submit it.</p>'],
  };
  const order = ["info", "questions", "review"];
  let at = ${JSON.stringify(start)};
  function draw() {
    document.getElementById("step").textContent = steps[at][0];
    const last = at === "review";
    document.getElementById("body").innerHTML = steps[at][1] + (at === "signin" ? "" : '<div><button data-automation-id="pageFooterBackButton">Back</button>'
      + '<button data-automation-id="pageFooterNextButton" id="next">' + (last ? "Submit" : "Save and Continue") + '</button></div>');
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.id === "signin") { window.signedInAs = document.getElementById("em").value; at = "info"; draw(); return; }
    if (b.id !== "next") return;
    if (at === "review") {
      window.submits++;
      document.querySelector('[data-automation-id="applyFlowPage"]').remove();
      if (!${vanish}) document.body.insertAdjacentHTML("beforeend", "<h2>Application Submitted</h2><p>Thanks for applying.</p>");
      return;
    }
    const empty = [...document.querySelectorAll("#body [required]")].filter((el) => el.type === "radio"
      ? !document.querySelector('input[name="' + el.name + '"]:checked') : !el.value.trim());
    if (empty.length) {
      window.blocked++;
      empty.forEach((el) => el.setAttribute("aria-invalid", "true"));
      if (!document.querySelector('[data-automation-id="errorMessage"]')) document.getElementById("body").insertAdjacentHTML("afterbegin", '<div data-automation-id="errorMessage" role="alert">Errors found. Fill in the required fields.</div>');
      return;
    }
    window.nexts++;
    at = order[order.indexOf(at) + 1];
    draw();
  });
  draw();
</script></body></html>`;

const state = { fill: "half", start: "info", vanish: false, draft: true };
const server = { attempts: {}, gates: [], filled: 0, drafts: 0 };
const AI = "I use your product every day.";
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "ooj-wdcard-")), {
  channel: "chromium", headless: true, viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const stray = [];
await ctx.route("**/*", (r) => {
  const u = r.request().url();
  if (u.startsWith(PAGE)) return r.fulfill({ contentType: "text/html", body: site(state.start, state.vanish) });
  if (!u.startsWith(API + "/")) { stray.push(u); return r.fulfill({ status: 204, body: "" }); }
  const at = u.slice(API.length).replace(/\?.*/, "");
  const body = r.request().postDataJSON?.() ?? null;
  if (at === "/me/apply/profile") {
    return r.fulfill({ json: { profile: { contact: { first_name: "Dana", last_name: "Levi", email: "dana@example.com", phone: "+1 212 555 0100", location: "" },
      links: {}, work: { needs_sponsorship: false }, eeo: {}, answers: [],
      settings: { mode: "queue", fill: state.fill, sources: ["ats_pages"], unknowns: "ai", guardrails: { blocked_companies: [] } } }, preferences: {} } });
  }
  if (at === "/me/apply/summary") return r.fulfill({ json: { plan: "pro", period: "day", remaining: 5, applied_today: 0 } });
  if (at === "/me/apply/history") return r.fulfill({ json: { applied: [] } });
  if (at === "/me/apply/draft") {
    server.drafts++;
    return state.draft ? r.fulfill({ json: { answer: AI, source: "ai", suggested: true } }) : r.fulfill({ status: 422, json: { error: "no answer" } });
  }
  if (at === "/me/apply/filled") { server.filled++; return r.fulfill({ json: { attempt: { state: "filled" } } }); }
  if (at === "/me/apply/attempts") {
    server.attempts[body.attempt_id] = server.attempts[body.attempt_id] || { state: "reserved" };
    return r.fulfill({ json: { attempt: server.attempts[body.attempt_id] } });
  }
  const m = /^\/me\/apply\/attempts\/(\w+)\/(submission-started|settle)$/.exec(at);
  if (m && server.attempts[m[1]]) {
    const a = server.attempts[m[1]];
    if (m[2] === "submission-started") { server.gates.push(body); a.state = "submission_started"; return r.fulfill({ json: { submit: true, attempt: a } }); }
    Object.assign(a, { state: body.outcome, reason: body.reason, questions: body.questions });
    return r.fulfill({ json: { attempt: a } });
  }
  return r.fulfill({ json: {} });
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
await sw.evaluate(async () => {
  await chrome.storage.local.set({ token: "test", authError: false, paused: true, workday: { password: "Aa1!Bb2@Cc3#Dd4$" },
    cv: { name: "cv.pdf", type: "application/pdf", data: "JVBERi0xLjQK" } });
  await chrome.alarms.clearAll();
});

const go = () => document.querySelector("[data-ooj-fill]").shadowRoot.querySelector(".go");
const cardText = (p) => p.evaluate(() => document.querySelector("[data-ooj-fill]").shadowRoot.querySelector(".msg").innerText);
const settled = `(() => { const b = (${go})(); return b.hidden || !/Filling|Submitting/.test(b.textContent); })()`;
const site_ = (p) => p.evaluate(() => ({ nexts: window.nexts, submits: window.submits, blocked: window.blocked, step: document.getElementById("step")?.textContent || "(gone)",
  signedInAs: window.signedInAs, done: /Application Submitted/.test(document.body.innerText) }));
const reset = (set) => { Object.assign(state, { fill: "half", start: "info", vanish: false, draft: true }, set); Object.assign(server, { attempts: {}, gates: [], filled: 0, drafts: 0 }); };
const attempts = () => Object.values(server.attempts);
const aiAt = (g) => (g && g.answers || []).find((x) => x.question === "Why do you want to work here?");

// The card's Fill application, and with press the user's own Submit after it.
async function card(name, set, press = false) {
  reset(set);
  console.log(name);
  const p = await ctx.newPage();
  await p.goto(PAGE, { waitUntil: "domcontentloaded" });
  await p.waitForFunction(() => document.querySelector("[data-ooj-fill]")?.shadowRoot?.querySelector(".go")?.textContent === "Fill application", null, { timeout: 20000 });
  await p.evaluate(`(${go})().click()`);
  await p.waitForFunction(settled, null, { timeout: 120000 });
  const filled = { ...(await site_(p)), msg: await cardText(p) };
  let sent = null;
  if (press) {
    await p.evaluate(`(${go})().click()`);
    await p.waitForFunction(`(${go})().hidden || !/Submitting/.test((${go})().textContent)`, null, { timeout: 60000 });
    sent = { ...(await site_(p)), msg: await cardText(p) };
  }
  await p.waitForTimeout(300);
  console.log(`  after fill: ${JSON.stringify(filled)}${sent ? `\n  after Submit: ${JSON.stringify(sent)}` : ""}\n  attempts: ${JSON.stringify(attempts())}; gates: ${server.gates.length}`);
  await p.screenshot({ path: path.join(os.tmpdir(), `ooj-wdcard-${name.replace(/\W+/g, "-")}.png`) });
  await p.close();
  return { filled, sent };
}

let r = await card("Half automatic: fills every page, stops on Review, the user presses Submit", { fill: "half" }, true);
check("pressed Next twice and reached Review, nothing submitted by the fill", r.filled.nexts === 2 && r.filled.step === "Review" && r.filled.submits === 0 && r.filled.blocked === 0, JSON.stringify(r.filled));
check("the card offers its Submit on Review, and says where the AI answered", /Review your answers, then submit the application here/.test(r.filled.msg)
  && /AI answered 1 question on an earlier page/.test(r.filled.msg) && !/outlined in amber/.test(r.filled.msg), r.filled.msg);
check("the fill reserved nothing (Filled only)", server.filled === 1 && server.gates.length === 1, JSON.stringify({ filled: server.filled }));
check("the user's Submit: gate in card mode, the page 2 AI answer carried as the AI's", server.gates[0]?.mode === "card" && aiAt(server.gates[0])?.answer === AI
  && aiAt(server.gates[0])?.source === "ai", JSON.stringify(server.gates[0]));
check("one Submit press, Workday's confirmation, settled submitted", r.sent.submits === 1 && /Application submitted/.test(r.sent.msg)
  && attempts().length === 1 && attempts()[0].state === "submitted", JSON.stringify({ sent: r.sent, a: attempts() }));

r = await card("Full automatic: fills every page and submits once through the gate", { fill: "full" });
check("walked to Review and submitted once", r.filled.nexts === 2 && r.filled.submits === 1 && /Application submitted/.test(r.filled.msg), JSON.stringify(r.filled));
check("gate in auto mode, ACK before the click, the AI answer carried", server.gates.length === 1 && server.gates[0].mode === "auto" && aiAt(server.gates[0])?.source === "ai",
  JSON.stringify(server.gates));
check("settled submitted", attempts().length === 1 && attempts()[0].state === "submitted", JSON.stringify(attempts()));

r = await card("Full automatic: a required question with no answer stops on its page", { fill: "full", draft: false });
check("stopped on Application Questions, never pressed Next past it", r.filled.nexts === 1 && r.filled.step === "Application Questions" && r.filled.blocked === 0 && r.filled.submits === 0,
  JSON.stringify(r.filled));
check("no gate, and the card says a field needs an answer", server.gates.length === 0 && /Some fields need your answer/.test(r.filled.msg), r.filled.msg);
check("in Needs attention with the question, released", attempts().length === 1 && attempts()[0].state === "needs_input"
  && JSON.stringify(attempts()[0].questions) === JSON.stringify(["Why do you want to work here?"]), JSON.stringify(attempts()));

r = await card("Half automatic: a required question with no answer stops on its page", { fill: "half", draft: false });
check("stopped on Application Questions, the field marked for the user", r.filled.nexts === 1 && r.filled.step === "Application Questions" && r.filled.blocked === 0
  && /1 needs your attention/.test(r.filled.msg), JSON.stringify(r.filled));
check("Half automatic reserves nothing", attempts().length === 0 && server.gates.length === 0, JSON.stringify(attempts()));

r = await card("Full automatic: the application goes away with no confirmation", { fill: "full", vanish: true });
check("one press, Submission unconfirmed, never Submitted", r.filled.submits === 1 && !/Application submitted/.test(r.filled.msg)
  && attempts().length === 1 && attempts()[0].state === "unconfirmed", JSON.stringify({ f: r.filled, a: attempts() }));

// The popup's Fill application from Workday's sign-in step, in Full automatic.
reset({ fill: "full", start: "signin" });
console.log("Popup, Full automatic, from the sign-in step");
const p = await ctx.newPage();
await p.goto(PAGE, { waitUntil: "domcontentloaded" });
const tabId = await sw.evaluate(async () => (await chrome.tabs.query({})).find((t) => (t.url || "").includes("myworkdayjobs.com")).id);
const out = await sw.evaluate((id) => fillTab(id), tabId);
const st = await site_(p);
console.log(`  result: ${JSON.stringify({ ...out, statements: undefined })}\n  site: ${JSON.stringify(st)}`);
check("signed in with the profile's email, then walked to Review", st.signedInAs === "dana@example.com" && st.nexts === 2, JSON.stringify(st));
check("submitted once after the gate, confirmed by Workday", st.submits === 1 && out.sent && out.sent.submitted && server.gates.length === 1
  && attempts()[0]?.state === "submitted", JSON.stringify({ sent: out.sent, a: attempts() }));
await p.close();

// A background run on the same pages: the walk the card now shares.
reset({ fill: "full", start: "info" });
console.log("Background run (applyTo) on the same application");
await sw.evaluate(() => {
  // A tab the extension opens loads its first address before Playwright's
  // routes cover it, so it opens blank and then goes to the job.
  const create = chrome.tabs.create.bind(chrome.tabs);
  chrome.tabs.create = async ({ url, ...rest }) => {
    const tab = await create({ ...rest, url: "about:blank" });
    await new Promise((r) => setTimeout(r, 1500));
    return chrome.tabs.update(tab.id, { url });
  };
});
const ran = await sw.evaluate(async (url) => {
  const a = await account();
  return applyTo({ id: "00000000000000w1", url, ats: "workday", title: "Software Engineer", company_domain: "acme.com" },
    { profile: a.profile, preferences: {}, settings: a.profile.settings, cv: (await chrome.storage.local.get("cv")).cv, serverAi: true });
}, PAGE);
console.log(`  run: ${ran}; attempts: ${JSON.stringify(attempts())}; gate answers: ${JSON.stringify(server.gates[0]?.answers || [])}`);
check("the run walks to Review and is settled submitted after one gate", ran === "submitted" && server.gates.length === 1 && server.gates[0].mode === "auto"
  && attempts().length === 1 && attempts()[0].state === "submitted", JSON.stringify({ ran, a: attempts() }));

console.log("requests answered locally instead of the network:", [...new Set(stray.map((u) => new URL(u).host))].join(", ") || "none");
await ctx.close();
console.log(failures.length ? `\n${failures.length} failed` : "\nall passed");
process.exit(failures.length ? 1 : 0);
