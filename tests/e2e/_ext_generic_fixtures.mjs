// extension/ats/generic.js on small forms built here, no network: which
// form it picks, the labels it reads, and what fill() does to the page.
// Run from the repo root: node tests/e2e/_ext_generic_fixtures.mjs
import { chromium } from "playwright";
import { createRequire } from "node:module";
import path from "node:path";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const match = require(path.resolve("extension/lib/match.js"));
const browser = await chromium.launch({ channel: "chromium", headless: true });
const page = await browser.newPage();

async function load(html) {
  await page.setContent(html);
  await page.addScriptTag({ path: path.resolve("extension/lib/match.js") });
  await page.addScriptTag({ path: path.resolve("extension/ats/generic.js") });
}

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log("PASS", name); } catch (e) { failed++; console.log("FAIL", name, "\n ", e.message.split("\n").slice(0, 6).join("\n  ")); }
}

const FORM = `
  <header>
    <form role="search"><input name="q" placeholder="Search jobs"><input name="where"><input name="radius"></form>
    <form action="/newsletter/subscribe"><input type="email" placeholder="Email"><input name="n"><input name="m"><textarea></textarea></form>
  </header>
  <main><div id="app">
    <div><label for="fn">First name *</label><input id="fn"></div>
    <div><label>Last name<span>*</span><input name="ln"></label></div>
    <div><span id="em-l">Email address</span><input type="email" aria-labelledby="em-l" required></div>
    <div><input type="tel" aria-label="Phone"></div>
    <div><input placeholder="LinkedIn profile"></div>
    <div><p>Why do you want to work here?</p><div><textarea></textarea></div></div>
    <fieldset><legend>Will you require visa sponsorship?</legend>
      <label><input type="radio" name="sp" value="y" required>Yes</label><label><input type="radio" name="sp" value="n">No</label></fieldset>
    <div><label for="g">Gender</label><select id="g"><option value="">Select...</option><option>Male</option><option>Female</option><option>Decline to self-identify</option></select></div>
    <div><label for="cv">Resume/CV</label><input type="file" id="cv" style="display:none"><div>Drop your CV here</div></div>
    <input name="website_hp" style="position:absolute;left:-9999px" tabindex="-1" aria-hidden="true">
    <label><input type="checkbox" id="consent" required> I agree to the privacy policy</label>
    <input type="hidden" name="token" value="x">
    <p class="err" style="display:none">This field is required</p>
  </div></main>`;

const profile = {
  contact: { first_name: "Test", last_name: "Person", email: "t@example.com", phone: "+972 50 000 0000", location: "Tel Aviv, Israel" },
  links: { linkedin: "https://linkedin.com/in/t", github: "", website: "" },
  work: { authorized_countries: [], needs_sponsorship: true, notice_period: "", salary: "" },
  eeo: { gender: "decline" }, answers: [],
};
const cv = { name: "cv.pdf", type: "application/pdf", data: Buffer.from("%PDF-1.4 test").toString("base64") };

await check("reads the application, not the search or newsletter form", async () => {
  await load(FORM);
  const { fields } = await page.evaluate(() => globalThis.oojAts.generic.read());
  const brief = fields.map((f) => [f.label, f.type, f.required, f.options.join("|")]);
  assert.deepEqual(brief, [
    ["First name", "text", true, ""],
    ["Last name", "text", true, ""],
    ["Email address", "email", true, ""],
    ["Phone", "tel", false, ""],
    ["LinkedIn profile", "text", false, ""],
    ["Why do you want to work here?", "textarea", false, ""],
    ["Will you require visa sponsorship?", "radio", true, "Yes|No"],
    ["Gender", "select", false, "Male|Female|Decline to self-identify"],
    ["Resume/CV", "file", false, ""],
    ["I agree to the privacy policy", "checkbox", true, ""],
  ]);
});

await check("fills text, radio, select and file; leaves the consent box alone", async () => {
  await load(FORM);
  const { fields } = await page.evaluate(() => globalThis.oojAts.generic.read());
  const plan = match.planFill(fields, profile, {});
  assert.deepEqual(plan.missing.map((f) => f.label), ["I agree to the privacy policy"]);
  await page.evaluate(() => {
    window.__events = [];
    for (const el of document.querySelectorAll("#app input, #app select, #app textarea")) {
      for (const t of ["input", "change"]) el.addEventListener(t, () => window.__events.push(t + ":" + (el.id || el.name || el.type)));
    }
  });
  const res = await page.evaluate(([fills, cv]) => globalThis.oojAts.generic.fill(fills, cv), [plan.fills, cv]);
  assert.deepEqual(res.errors, []);
  const got = await page.evaluate(() => ({
    fn: document.getElementById("fn").value, ln: document.querySelector('[name="ln"]').value,
    email: document.querySelector('[type="email"][aria-labelledby]').value, phone: document.querySelector('[type="tel"]').value,
    li: document.querySelector('[placeholder="LinkedIn profile"]').value, sp: document.querySelector('[name="sp"]:checked')?.value,
    g: document.getElementById("g").value, cv: document.getElementById("cv").files[0]?.name,
    consent: document.getElementById("consent").checked, hp: document.querySelector('[name="website_hp"]').value, events: window.__events,
  }));
  assert.equal(got.fn, "Test");
  assert.equal(got.ln, "Person");
  assert.equal(got.email, "t@example.com");
  assert.equal(got.phone, "+972 50 000 0000");
  assert.equal(got.li, "https://linkedin.com/in/t");
  assert.equal(got.sp, "y");
  assert.equal(got.g, "Decline to self-identify");
  assert.equal(got.cv, "cv.pdf");
  assert.equal(got.consent, false);
  assert.equal(got.hp, "");
  // Frameworks listen for these, not for the value property.
  assert.ok(got.events.includes("input:fn") && got.events.includes("change:fn") && got.events.includes("change:cv"));
});

await check("a lone checkbox is ticked only for a yes", async () => {
  await load(FORM);
  const { fields } = await page.evaluate(() => globalThis.oojAts.generic.read());
  const box = fields.find((f) => f.type === "checkbox");
  await page.evaluate((f) => globalThis.oojAts.generic.fill([{ ...f, value: "No" }], null), box);
  assert.equal(await page.isChecked("#consent"), false);
  await page.evaluate((f) => globalThis.oojAts.generic.fill([{ ...f, value: "Yes" }], null), box);
  assert.equal(await page.isChecked("#consent"), true);
});

await check("a custom dropdown: options read on open, then picked", async () => {
  await load(`<form><label for="a">Full name</label><input id="a"><label for="b">Email</label><input id="b" type="email">
    <label for="c">Phone</label><input id="c" type="tel">
    <span id="dl">Do you need a visa?</span>
    <input id="dd" role="combobox" readonly aria-labelledby="dl" aria-controls="lb">
    <ul id="lb" role="listbox" hidden><li role="option">Yes</li><li role="option">No</li></ul></form>
    <script>
      dd.addEventListener("mousedown", () => { lb.hidden = false; });
      dd.addEventListener("keydown", (e) => { if (e.key === "Escape") lb.hidden = true; });
      lb.addEventListener("mousedown", (e) => { dd.value = e.target.textContent; lb.hidden = true; });
    </script>`);
  const { fields } = await page.evaluate(() => globalThis.oojAts.generic.read());
  const dd = fields.find((f) => f.type === "combobox");
  assert.deepEqual([dd.label, dd.options], ["Do you need a visa?", ["Yes", "No"]]);
  assert.equal(await page.isHidden("#lb"), true);
  const res = await page.evaluate((f) => globalThis.oojAts.generic.fill([{ ...f, value: "No" }], null), dd);
  assert.deepEqual(res.errors, []);
  assert.equal(await page.inputValue("#dd"), "No");
});

await check("an Apply button that reveals the form is clicked, then the form read", async () => {
  await load(`<h1>Engineer</h1><button id="go" onclick="document.getElementById('f').hidden=false">Apply now</button>
    <form id="f" hidden><label>Full name <input name="a"></label><label>Email <input type="email" name="b"></label>
    <label>Phone <input type="tel" name="c"></label><button type="submit">Submit</button></form>`);
  const { fields } = await page.evaluate(() => globalThis.oojAts.generic.read());
  assert.deepEqual(fields.map((f) => f.label), ["Full name", "Email", "Phone"]);
});

await check("an Apply link to another page is handed back to follow", async () => {
  await load(`<h1>Engineer</h1><p>About the job</p><a href="/jobs/1/apply">Apply for this job</a>`);
  const res = await page.evaluate(() => globalThis.oojAts.generic.read());
  assert.match(res.openUrl, /\/jobs\/1\/apply$/);
});

await check("a form's own Apply submit button is never pressed", async () => {
  await load(`<form onsubmit="window.__sent = true; return false"><input name="code" placeholder="Promo code"><button type="submit">Apply</button></form>`);
  const res = await page.evaluate(() => globalThis.oojAts.generic.read());
  assert.equal(res.error, "No application form on this page.");
  assert.equal(await page.evaluate(() => window.__sent || false), false);
});

await browser.close();
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
