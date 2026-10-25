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

// A box that only says "Yes" under the question it answers (Comeet's
// privacy policy, NaturalInt, 2026-10-25): the label is the question.
await check("a lone Yes box takes the question above it", async () => {
  await load(`<form><label>Full name <input name="a"></label><label>Email <input type="email" name="b"></label>
    <label>Phone <input type="tel" name="c"></label><label>Resume <input type="file" name="cv"></label>
    <div class="q"><h4>I hereby agree and consent to NI's Privacy Policy *</h4><div>Required</div>
      <label><input type="checkbox" id="pp" required> Yes</label></div>
    <div class="q"><label><input type="checkbox" id="news"> Yes</label></div>
    <button type="submit">Submit</button></form>`);
  const got = await page.evaluate(() => globalThis.oojAts.generic.read());
  assert.ok(got.fields, JSON.stringify(got));
  const pp = got.fields.find((f) => f.type === "checkbox" && f.required);
  assert.ok(pp && /privacy policy/i.test(pp.label) && /Yes$/.test(pp.label), JSON.stringify(got.fields));
  assert.equal(match.mustAnswer(pp), "Yes");
});

// Comeet's questionnaire as its AngularJS app renders it (Fetcherr,
// 2026-10-20): the input is zero wide and transparent, its label[for]
// draws the circle and says "Yes", the question is the fieldset's legend
// and the radio's name, the value is "[object Object]". A change event is
// what the app's model listens to. Screening questions are often optional.
const comeetQuestion = (id, type, title, options, required = "") => `
  <li class="question"><fieldset class="fieldset">
    <div class="question-header"><legend class="question-title" id="">${title} </legend></div>
    <div><ul class="options">${options.map((o, i) => `
      <li class="clear clearAfter styled-form-component">
        <input class="checkbox focusHighlight ng-empty" type="${type}" id="${id}_${i}" name="${title}" value="[object Object]" ${required}>
        <label class="checkboxLabel ellipsis" for="${id}_${i}"><span class="fa-stack checkbox"><i class="fa fa-circle"></i><i class="fa fa-check ng-hide"></i></span><div class="option-title">${o}</div></label>
      </li>`).join("")}
    </ul></div>
  </fieldset></li>`;
const COMEET = `<style>.styled-form-component input { opacity: 0; width: 0; height: 0; margin: 0; } .ng-hide { display: none; }</style>
  <form name="applyForm" novalidate>
    <label for="fn">First name *</label><input id="fn" name="firstName" required>
    <label for="ln">Last name *</label><input id="ln" name="lastName" required>
    <label for="em">Email *</label><input id="em" name="email" type="email" required>
    <label for="cv">Resume *</label><input id="cv" name="cv" type="file" style="display:none">
    <ul class="questions">
      ${comeetQuestion("q1", "radio", "This position requires working from the Israel Netanya office- hybrid mode Can you meet this requirement?", ["Yes", "No"])}
      ${comeetQuestion("q2", "radio", "Do you have direct, hands-on experience architecting and deploying production environments on Azure?", ["Yes", "No"], "required")}
      ${comeetQuestion("q3", "checkbox", "Which clouds have you run production on?", ["Azure", "AWS", "GCP"], "required")}
    </ul>
    <label class="consent"><input type="checkbox" id="consent" name="consent" required> I agree to the processing of my data under the privacy policy</label>
    <label class="consent"><input type="checkbox" id="news" name="news"> Send me news about future jobs</label>
    <button type="submit">Submit Application</button>
  </form>
  <script>
    for (const el of document.querySelectorAll(".styled-form-component input")) el.addEventListener("change", () => {
      for (const m of document.getElementsByName(el.name)) {
        m.classList.toggle("ng-not-empty", m.checked);
        m.nextElementSibling.querySelector(".fa-check").classList.toggle("ng-hide", !m.checked);
      }
    });
  </script>`;

// What /me/apply/draft answers in the live tests: yes to a yes/no question, else the first option.
const draft = (f) => f.options.find((o) => /^yes$/i.test(o)) || f.options[0] || "Test answer";

await check("Comeet radios: read with the legend, options and nothing checked", async () => {
  await load(COMEET);
  const { fields } = await page.evaluate(() => globalThis.oojAts.generic.read());
  const brief = fields.filter((f) => ["radio", "checkbox"].includes(f.type)).map((f) => [f.label, f.type, f.required, f.options.join("|"), !!f.checked]);
  assert.deepEqual(brief, [
    ["This position requires working from the Israel Netanya office- hybrid mode Can you meet this requirement?", "radio", false, "Yes|No", false],
    ["Do you have direct, hands-on experience architecting and deploying production environments on Azure?", "radio", true, "Yes|No", false],
    ["Which clouds have you run production on?", "checkbox", true, "Azure|AWS|GCP", false],
    ["I agree to the processing of my data under the privacy policy", "checkbox", true, "", false],
    ["Send me news about future jobs", "checkbox", false, "", false],
  ]);
});

await check("Comeet radios: optional and required yes/no ticked, checkbox group ticked, consent boxes left alone", async () => {
  await load(COMEET);
  const { fields } = await page.evaluate(() => globalThis.oojAts.generic.read());
  const plan = match.planFill(fields, profile, {});
  // planWithSuggestions in background.js, with the stubbed AI.
  const asked = match.suggestable(fields, plan);
  assert.deepEqual(asked.map((f) => f.label.slice(0, 30)), ["Do you have direct, hands-on e", "Which clouds have you run prod", "This position requires working"]);
  const fills = [...plan.fills, ...asked.map((f) => ({ ...f, value: draft(f) }))];
  const res = await page.evaluate(([fills, cv]) => globalThis.oojAts.generic.fill(fills, cv), [fills, cv]);
  assert.deepEqual(res.errors, []);
  const got = await page.evaluate(() => ({
    picked: [...document.querySelectorAll(".styled-form-component input:checked")].map((el) => `${el.id}:${el.nextElementSibling.textContent.trim()}`),
    model: [...document.querySelectorAll(".styled-form-component input.ng-not-empty")].length,
    ticks: [...document.querySelectorAll(".fa-check:not(.ng-hide)")].length,
    consent: document.getElementById("consent").checked, news: document.getElementById("news").checked,
    fn: document.getElementById("fn").value, cv: document.getElementById("cv").files[0]?.name,
  }));
  assert.deepEqual(got.picked, ["q1_0:Yes", "q2_0:Yes", "q3_0:Azure"]);
  assert.equal(got.model, 3);
  assert.equal(got.ticks, 3);
  assert.equal(got.consent, false);
  assert.equal(got.news, false);
  assert.equal(got.fn, "Test");
  assert.equal(got.cv, "cv.pdf");
});

await check("Comeet radios: a question already answered is not suggested again", async () => {
  await load(COMEET);
  await page.click('label[for="q1_1"]');
  const { fields } = await page.evaluate(() => globalThis.oojAts.generic.read());
  const q1 = fields.find((f) => f.label.startsWith("This position"));
  assert.equal(q1.checked, true);
  assert.ok(!match.suggestable(fields, match.planFill(fields, profile, {})).includes(q1));
});

// An Experis job page (2026-10-20): the orange "שליחת קו"ח" button at the
// top and bottom opens a modal form whose only labels are placeholders, a
// CV or LinkedIn switch, a hidden file input and consent boxes, behind an
// invisible reCAPTCHA.
const EXPERIS_CONSENT = "*המידע אודותיי כפוף למדיניות הפרטיות. אני מאשר/ת הכללת קו”ח שלי במאגר המועמדים";
const EXPERIS = `<meta charset="utf-8"><title>איש/אשת תמיכה בכיר/ה - Experis</title><h1>איש/אשת תמיכה בכיר/ה</h1>
  <button class="bg-orange open-cv">שליחת קו"ח <svg width="10" height="10"></svg></button><p>על התפקיד</p>
  <button class="bg-orange open-cv">שליחת קו"ח</button>
  <div id="portal"></div><div class="grecaptcha-badge"></div>
  <script>
    for (const b of document.querySelectorAll(".open-cv")) b.addEventListener("click", () => { portal.innerHTML = \`
      <div role="dialog"><p>הגשת מועמדות למשרה:</p><form id="send-cv-form-CV" novalidate>
        <div><input id="text" name="firstName" type="text" placeholder="שם פרטי"></div>
        <div><input id="text" name="lastName" type="text" placeholder="שם משפחה"></div>
        <div><input id="email" name="email" type="text" placeholder="מייל"></div>
        <div><input id="text" name="phone" type="text" placeholder="נייד"></div>
        <div><div class="cv"><label><input type="radio" name="cv" id="send-cv-with-cv" style="appearance:none" checked>העלאת קורות חיים</label></div>
          <div class="linkedin"><label><input type="radio" name="linkedin" id="send-cv-linkedin" style="appearance:none">פרופיל לינקדאין</label></div></div>
        <div><label><input type="file" placeholder="העלאת קורות חיים " id="cv" name="file" style="display:none"><p>העלאת קורות חיים </p></label></div>
        <div><label><input type="checkbox" id="c1" name="c1" style="display:none"><div><p>${EXPERIS_CONSENT}</p></div></label></div>
        <div><label><input type="checkbox" id="c2" name="c2" style="display:none"><div><p>אני מאשר/ת קבלת הצעות עבודה במסרון ובמייל מהקבוצה</p></div></label></div>
        <button type="submit">שליחה</button>
      </form></div>\`; });
  </script>`;

await check("Experis: the Hebrew apply button opens the modal, placeholders name the fields, consent left alone, no Submit", async () => {
  await load(EXPERIS);
  const { fields } = await page.evaluate(() => globalThis.oojAts.generic.read());
  const plan = match.planFill(fields, profile, {});
  assert.deepEqual(plan.fills.map((f) => [f.label, f.key]), [
    ["שם פרטי", "first_name"], ["שם משפחה", "last_name"], ["מייל", "email"], ["נייד", "phone"], ["העלאת קורות חיים", "resume"]]);
  assert.deepEqual(match.suggestable(fields, plan), []);
  const res = await page.evaluate(([fills, cv]) => globalThis.oojAts.generic.fill(fills, cv), [plan.fills, cv]);
  assert.deepEqual(res.errors, []);
  const got = await page.evaluate(() => ({
    values: [...document.querySelectorAll("#send-cv-form-CV input[type=text]")].map((el) => el.value),
    cv: document.getElementById("cv").files[0]?.name, withCv: document.getElementById("send-cv-with-cv").checked,
    linkedin: document.getElementById("send-cv-linkedin").checked,
    consent: [...document.querySelectorAll("#send-cv-form-CV input[type=checkbox]")].map((el) => el.checked),
  }));
  assert.deepEqual(got, { values: ["Test", "Person", "t@example.com", "+972 50 000 0000"], cv: "cv.pdf", withCv: true, linkedin: false, consent: [false, false] });
  assert.deepEqual(await page.evaluate(() => globalThis.oojAts.generic.submitInfo()), { botCheck: true });
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

await check("formHere: an application form counts, a comment form does not", async () => {
  await load(FORM);
  assert.deepEqual(await page.evaluate(() => globalThis.oojAts.generic.formHere()), { score: 16, file: true });
  await load(`<form id="commentform" action="/wp-comments-post.php"><input name="author"><input type="email" name="email"><input name="url"><textarea name="comment"></textarea></form>`);
  assert.deepEqual(await page.evaluate(() => globalThis.oojAts.generic.formHere()), { score: 0 });
  await load(`<input placeholder="Search"><button>Go</button>`);
  assert.deepEqual(await page.evaluate(() => globalThis.oojAts.generic.formHere()), { score: 0 });
});

// The submit button submitButton() picks, as "text|tag", or null.
const FIELDS = `<label>Full name <input name="a"></label><label>Email <input type="email" name="b"></label><label>Phone <input type="tel" name="c"></label>`;
const picked = () => page.evaluate(() => {
  const b = globalThis.oojAts.generic.submitButton();
  return b && `${(b.textContent || b.value).trim()}|${b.tagName.toLowerCase()}`;
});
const BUTTONS = [
  ["a classic form's submit button", `<form>${FIELDS}<button type="submit">Submit</button></form>`, "Submit|button"],
  ["a div form's single Apply button", `<div id="app"><div>${FIELDS}</div><div><button class="btn">Apply</button></div></div>`, "Apply|button"],
  ["a form with only Next", `<form>${FIELDS}<button type="submit">Next</button></form>`, null],
  ["Submit application over Save draft", `<form>${FIELDS}<button type="submit">Save draft</button><button type="submit">Submit application</button></form>`, "Submit application|button"],
  ["the real Submit, not Apply with LinkedIn", `<form>${FIELDS}<button type="button">Apply with LinkedIn</button><input type="submit" value="Submit"></form>`, "Submit|input"],
  ["two submit buttons of equal weight", `<form>${FIELDS}<button type="submit">Send</button><button type="submit">Submit</button></form>`, null],
  ["a cookie banner's Accept outside the form", `<div class="cookie-banner"><button>Accept</button><button>Reject</button></div><form>${FIELDS}<button>Submit</button></form>`, "Submit|button"],
  ["a form with no button and a cookie Accept", `<div class="cookies"><button>Accept all</button></div><form>${FIELDS}</form>`, null],
  ["a German form", `<form>${FIELDS}<button type="button">Zurück</button><button type="submit">Bewerbung absenden</button></form>`, "Bewerbung absenden|button"],
  ["a Hebrew step button", `<form>${FIELDS}<button type="submit">הבא</button></form>`, null],
  ["a form behind a CAPTCHA", `<form>${FIELDS}<iframe src="https://www.google.com/recaptcha/api2/anchor?k=x" style="width:304px;height:78px"></iframe><button>Submit</button></form>`, null],
];
for (const [name, html, want] of BUTTONS) {
  await check(`submitButton: ${name}`, async () => {
    await load(html);
    await page.evaluate(() => globalThis.oojAts.generic.read());
    assert.equal(await picked(), want);
  });
}

// Pages at a real address, so the URL can change.
async function serve(html, at = "https://fixture.test/jobs/1") {
  await page.unroute("https://fixture.test/**");
  await page.route("https://fixture.test/**", (r) => r.fulfill({ contentType: "text/html", body: html }));
  await page.goto(at);
  await page.addScriptTag({ path: path.resolve("extension/lib/match.js") });
  await page.addScriptTag({ path: path.resolve("extension/ats/generic.js") });
}
const sendAndWatch = (ms) => page.evaluate(async (ms) => {
  const g = globalThis.oojAts.generic;
  await g.read();
  const before = g.submit();
  const started = Date.now();
  const out = await g.outcome(before, ms);
  return { out, took: Date.now() - started };
}, ms);
const OUTCOMES = [
  ["a thank-you message replaces the form", `<p>Thank you for your interest in Acme.</p><form id="f" onsubmit="event.preventDefault(); setTimeout(() => f.outerHTML = '<h2>Thank you for applying!</h2>', 300)">${FIELDS}<button>Submit</button></form>`, "submitted"],
  ["the address moves to /thank-you", `<form onsubmit="event.preventDefault(); history.pushState({}, '', '/jobs/1/thank-you')">${FIELDS}<button>Submit</button></form>`, "submitted"],
  ["a required field the browser holds back", `<form>${FIELDS}<label>Why us? <textarea required></textarea></label><button>Submit</button></form>`, { failed: "form errors: Why us?" }],
  ["a field the site marks invalid", `<form novalidate onsubmit="event.preventDefault(); const e = document.querySelector('[type=email]'); e.value = ''; e.setAttribute('aria-invalid', 'true')">${FIELDS}<button>Submit</button></form>`, { failed: "form errors: Email" }],
  ["error text and nothing sent", `<form novalidate onsubmit="event.preventDefault(); document.getElementById('err').hidden = false">${FIELDS}<p id="err" class="form-error" hidden>Something went wrong, please try again</p><button>Submit</button></form>`, { failed: "form errors: Something went wrong, please try again" }],
  ["an error already showing before the click", `<form novalidate onsubmit="event.preventDefault()">${FIELDS}<p class="field-error">Unable to fetch address suggestions</p><button>Submit</button></form>`, null],
  ["a required field with a JavaScript submit button", `<form>${FIELDS}<label>Why us? <textarea required></textarea></label><button type="button">Submit application</button></form>`, null],
  ["a form that hides while sending and comes back", `<form id="f" onsubmit="event.preventDefault(); f.hidden = true; setTimeout(() => f.hidden = false, 1000)">${FIELDS}<button>Submit</button></form>`, null],
  ["nothing happens", `<form onsubmit="event.preventDefault()">${FIELDS}<button>Submit</button></form>`, null],
];
for (const [name, html, want] of OUTCOMES) {
  await check(`outcome: ${name}`, async () => {
    await serve(html);
    const { out, took } = await sendAndWatch(2500);
    assert.deepEqual(out, want);
    if (want === null) assert.ok(took >= 2500 && took < 4000, `waited ${took} ms`);
  });
}

// An automatic run's strict check: only the site's own word counts.
const strictWatch = (ms) => page.evaluate(async (ms) => {
  const g = globalThis.oojAts.generic;
  await g.read();
  return g.outcome(g.submit(), ms, true);
}, ms);
await check("strict outcome: a form that only goes away is unconfirmed", async () => {
  await serve(`<form id="f" onsubmit="event.preventDefault(); setTimeout(() => f.remove(), 300)">${FIELDS}<button>Submit</button></form>`);
  assert.deepEqual(await strictWatch(12000), { failed: "unconfirmed: the form closed without a confirmation" });
});
await check("strict outcome: a thank-you message still counts", async () => {
  await serve(`<form id="f" onsubmit="event.preventDefault(); f.outerHTML = '<h2>Thank you for applying!</h2>'">${FIELDS}<button>Submit</button></form>`);
  assert.equal(await strictWatch(5000), "submitted");
});

// A wizard: page one has Next, page two the button that sends.
const WIZARD = `<form id="f" onsubmit="event.preventDefault()">
  <div id="p1">${FIELDS}<button type="button" onclick="p1.remove(); p2.hidden = false">Save and Continue</button></div>
  <div id="p2" hidden><label>Why us? <textarea name="why"></textarea></label><label>Years of experience <input name="y"></label>
    <label>Notice period <input name="n"></label><button>Submit</button></div></form>`;
await check("wizard: no submit on page one, Next moves to page two, which has Submit", async () => {
  await serve(WIZARD);
  const r = await page.evaluate(async () => {
    const g = globalThis.oojAts.generic;
    const one = await g.read();
    const first = g.submitInfo();
    const before = g.next();
    const moved = await g.nextOutcome(before, 3000);
    const two = await g.read();
    return { one: one.fields.map((f) => f.label), first, moved, two: two.fields.map((f) => f.label), last: g.submitInfo() };
  });
  assert.deepEqual(r.one, ["Full name", "Email", "Phone"]);
  assert.equal(r.first, null);
  assert.equal(r.moved, "moved");
  assert.deepEqual(r.two, ["Why us?", "Years of experience", "Notice period"]);
  assert.equal(r.last.text, "Submit");
});
await check("wizard: Next refused by the form is a failure, not a move", async () => {
  await serve(`<form id="f" novalidate onsubmit="event.preventDefault()">${FIELDS}
    <button type="button" onclick="document.querySelector('[type=email]').setAttribute('aria-invalid', 'true')">Next</button></form>`);
  const r = await page.evaluate(async () => {
    const g = globalThis.oojAts.generic;
    await g.read();
    return g.nextOutcome(g.next(), 3000);
  });
  assert.deepEqual(r, { failed: "form errors: Email" });
});

await check("wall: a password field on show is a sign-in wall", async () => {
  await serve(`<form><label>Email <input type="email"></label><label>Password <input type="password"></label><button>Sign in</button></form>`);
  assert.deepEqual(await page.evaluate(() => globalThis.oojAts.generic.wall()), { signIn: true, captcha: false });
  await serve(`<form>${FIELDS}<button>Submit</button></form>`);
  assert.deepEqual(await page.evaluate(() => globalThis.oojAts.generic.wall()), { signIn: false, captcha: false });
});

await check("a bot trap is never read, so never filled", async () => {
  await serve(`<form>${FIELDS}<label>Leave empty <input data-automation-id="beecatcher" name="x"></label><button>Submit</button></form>`);
  const labels = await page.evaluate(async () => (await globalThis.oojAts.generic.read()).fields.map((f) => f.label));
  assert.deepEqual(labels, ["Full name", "Email", "Phone"]);
});

await check("a button dropdown (Workday's) is read with its options and picked", async () => {
  await serve(`<form>${FIELDS}<div><label id="src-l">How did you hear about us?</label>
    <button type="button" aria-haspopup="listbox" aria-labelledby="src-l" aria-controls="src" onclick="src.hidden = false">Select One</button>
    <ul id="src" role="listbox" hidden><li role="option" onclick="this.parentElement.previousElementSibling.textContent = this.textContent; this.parentElement.hidden = true">LinkedIn</li>
      <li role="option" onclick="this.parentElement.previousElementSibling.textContent = this.textContent; this.parentElement.hidden = true">Referral</li></ul></div>
    <button>Submit</button></form>`);
  const r = await page.evaluate(async () => {
    const g = globalThis.oojAts.generic;
    const { fields } = await g.read();
    const f = fields.find((x) => x.label === "How did you hear about us?");
    const res = await g.fill([{ ...f, value: "Referral" }], null);
    return { type: f.type, options: f.options, errors: res.errors, shows: document.querySelector('[aria-haspopup]').textContent };
  });
  assert.deepEqual(r, { type: "combobox", options: ["LinkedIn", "Referral"], errors: [], shows: "Referral" });
});

await check("a pinned form area wins over a bigger form elsewhere", async () => {
  await serve(`<form id="other">${FIELDS}<label>A <input name="a1"></label><label>B <input name="b1"></label><textarea></textarea></form>
    <div data-ooj-root><label>Given name <input name="g"></label><label>Email <input type="email" name="e"></label><label>Phone <input type="tel" name="t"></label></div>`);
  const labels = await page.evaluate(async () => (await globalThis.oojAts.generic.read()).fields.map((f) => f.label));
  assert.deepEqual(labels, ["Given name", "Email", "Phone"]);
});

await check("web components: fields inside open shadow roots are read, labelled and filled", async () => {
  await serve(`<script>
    customElements.define("x-input", class extends HTMLElement {
      connectedCallback() { const r = this.attachShadow({ mode: "open" });
        r.innerHTML = '<label for="i">' + this.getAttribute("label") + ' *</label><input id="i" type="' + (this.getAttribute("type") || "text") + '">'; } });
    customElements.define("x-button", class extends HTMLElement {
      connectedCallback() { this.attachShadow({ mode: "open" }).innerHTML = '<button type="button">' + this.getAttribute("label") + '</button>'; } });
  </script><div id="app"><x-input label="First name"></x-input><x-input label="Last name"></x-input>
    <x-input label="Email" type="email"></x-input><x-input label="Phone number" type="tel"></x-input><x-button label="Submit"></x-button></div>`);
  const r = await page.evaluate(async () => {
    const g = globalThis.oojAts.generic;
    const { fields } = await g.read();
    await g.fill(fields.filter((f) => f.label === "Email").map((f) => ({ ...f, value: "t@example.com" })), null);
    const email = document.querySelectorAll("x-input")[2].shadowRoot.querySelector("input").value;
    return { labels: fields.map((f) => f.label), required: fields.every((f) => f.required), email, submit: g.submitInfo() && g.submitInfo().text };
  });
  assert.deepEqual(r, { labels: ["First name", "Last name", "Email", "Phone number"], required: true, email: "t@example.com", submit: "Submit" }, JSON.stringify(r));
});

await check("SmartRecruiters' localised I'm interested link leads to the form", async () => {
  await load(`<h1>Manager</h1><a class="button js-oneclick" data-sr-track="apply" href="https://jobs.smartrecruiters.com/oneclick-ui/company/X/publication/1">Je suis intéressé(e)</a>`);
  assert.equal((await page.evaluate(() => globalThis.oojAts.generic.read())).openUrl, "https://jobs.smartrecruiters.com/oneclick-ui/company/X/publication/1");
});

await check("a searchable dropdown's short list is read; a city search box is not", async () => {
  const combo = (id, label, opts) => `<div><label for="${id}">${label} *</label>
    <input id="${id}" role="combobox" aria-controls="${id}-l" aria-autocomplete="list" onmousedown="document.getElementById('${id}-l').hidden = false">
    <ul id="${id}-l" role="listbox" hidden>${opts.map((o) => `<li role="option">${o}</li>`).join("")}</ul></div>`;
  await serve(`<form>${FIELDS}${combo("rtw", "What is your right-to-work status?", ["British citizen", "Settled status", "Valid visa"])}
    ${combo("city", "City", ["London", "Leeds", "Bristol"])}<button>Submit</button></form>`);
  const r = await page.evaluate(async () => Object.fromEntries((await globalThis.oojAts.generic.read()).fields.map((f) => [f.label, f.options])));
  assert.deepEqual(r["What is your right-to-work status?"], ["British citizen", "Settled status", "Valid visa"]);
  assert.deepEqual(r.City, []);
});

// detect.js on a posting page, with chrome.runtime stubbed: the button
// shows before the form exists, and not on a list of jobs.
async function detectOn(html, at) {
  await serve(html, at);
  await page.evaluate(() => Object.defineProperty(window, "chrome", { value: { runtime: { sendMessage: async () => null, onMessage: { addListener() {} } } } }));
  await page.addScriptTag({ path: path.resolve("extension/detect.js") });
  await page.waitForTimeout(1500);
  return page.evaluate(() => !!document.querySelector("[data-ooj-fill]"));
}
await check("posting page with one Apply button (top and bottom): button shown", async () => {
  assert.equal(await detectOn(`<title>Backend Engineer</title><button>Apply for this job</button><h1>Backend Engineer</h1><p>About the role.</p><button>Apply for this job</button>`, "https://fixture.test/jobs/backend-engineer"), true);
});
await check("posting page whose Apply link leads to the form: button shown", async () => {
  assert.equal(await detectOn(`<title>Acme - Backend Engineer</title><h1>Backend Engineer</h1><a href="/careers/acme/123/apply">Apply for this job</a><p>About.</p><a href="/careers/acme/123/apply">Apply for this job</a>`, "https://fixture.test/careers/acme/123"), true);
});
await check("Experis posting with its Hebrew apply button: button shown", async () => {
  assert.equal(await detectOn(EXPERIS, "https://fixture.test/job/244421"), true);
});
await check("jobs list with an Apply link per job: no button", async () => {
  const rows = [1, 2, 3, 4, 5].map((i) => `<li>Engineer ${i} <a href="/jobs/${i}/apply">Apply</a></li>`).join("");
  assert.equal(await detectOn(`<title>Careers at Acme</title><h1>Open positions</h1><ul>${rows}</ul>`, "https://fixture.test/careers"), false);
});
await check("page with only Apply with LinkedIn: no button", async () => {
  assert.equal(await detectOn(`<title>Backend Engineer</title><h1>Backend Engineer</h1><button>Apply with LinkedIn</button>`, "https://fixture.test/jobs/backend-engineer"), false);
});
await check("an article that is not about a job: no button", async () => {
  assert.equal(await detectOn(`<title>How to bake bread</title><h1>Bread</h1><button>Apply</button>`, "https://fixture.test/blog/bread"), false);
});

await browser.close();
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
