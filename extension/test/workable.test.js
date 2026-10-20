// The pure half of the Workable filler: links, the form spec Workable's
// apply page fetches (saved under fixtures/ as pageData() returns it), and
// the planner over it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const wk = require('../ats/workable.js');
const m = require('../lib/match.js');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

const profile = {
  contact: { first_name: 'Dana', last_name: 'Levi', email: 'dana@example.com', phone: '+44 7400 123456', location: 'London, United Kingdom' },
  links: { linkedin: '', github: '', website: '' },
  work: { authorized_countries: ['GB'], needs_sponsorship: false, notice_period: '30 days', salary: '50000' },
  eeo: {}, answers: [], settings: {},
};

test('matches our posting links and the form page, nothing else', () => {
  assert.ok(wk.matches('https://apply.workable.com/j/73B00FBE37'));
  assert.ok(wk.matches('https://apply.workable.com/biffa/j/73B00FBE37/'));
  assert.ok(wk.matches('https://apply.workable.com/biffa/j/73B00FBE37/apply/'));
  assert.ok(!wk.matches('https://apply.workable.com/biffa/'));
  assert.ok(!wk.matches('http://apply.workable.com/j/73B00FBE37'));
  assert.ok(!wk.matches('https://biffa.workable.com/j/73B00FBE37'));
  assert.ok(!wk.matches('not a url'));
  assert.ok(wk.onSite('https://apply.workable.com/biffa/j/73B00FBE37/apply/'));
});

test('formUrl opens the form, not the posting', () => {
  assert.equal(wk.formUrl('https://apply.workable.com/j/73B00FBE37'), 'https://apply.workable.com/j/73B00FBE37/apply/');
  assert.equal(wk.formUrl('https://apply.workable.com/biffa/j/73B00FBE37/'), 'https://apply.workable.com/biffa/j/73B00FBE37/apply/');
  assert.equal(wk.formUrl('https://apply.workable.com/biffa/j/73B00FBE37/apply'), 'https://apply.workable.com/biffa/j/73B00FBE37/apply/');
});

test('reads every Biffa question, consent label from the page', () => {
  const page = wk.fromSpec(fixture('workable_biffa.json'));
  const by = Object.fromEntries(page.fields.map((f) => [f.name, f]));
  assert.deepEqual(page.fields.slice(0, 6).map((f) => f.name), ['firstname', 'lastname', 'email', 'headline', 'phone', 'address']);
  assert.equal(by.phone.kind, 'phone');
  assert.equal(by.CA_38690.type, 'select');
  assert.deepEqual(by.CA_55753.options, ['Yes, I am currently a Cadet', 'No, but I have previously been a Cadet', 'No, I have never been a Cadet']);
  assert.deepEqual(by.QA_12658542.options, ['Yes', 'No']);
  assert.equal(by.QA_12658544.type, 'textarea');
  assert.match(by.gdpr.label, /^I have read, understand and accept/);
  assert.equal(page.redirectTo, null);
});

test('Biffa plan: contact from the profile, the rest from saved answers', () => {
  const page = wk.fromSpec(fixture('workable_biffa.json'));
  let plan = m.planFill(page.fields, profile, {});
  assert.deepEqual(plan.missing.map((f) => f.name), ['CA_38690', 'CA_55753', 'QA_12658542', 'QA_12658544', 'gdpr']);
  const by = Object.fromEntries(plan.fills.map((f) => [f.name, f.value]));
  assert.equal(by.firstname, 'Dana');
  assert.equal(by.lastname, 'Levi');
  assert.equal(by.address, 'London, United Kingdom');
  assert.equal(by.phone, '+44 7400 123456');
  assert.equal(by.resume, 'cv');
  assert.equal(by.QA_12658543, '50000');
  assert.equal(by.headline, undefined);

  const answers = plan.missing.map((f) => ({ question: f.label, answer: f.options.length ? f.options[f.options.length - 1] : 'Because.' }));
  plan = m.planFill(page.fields, { ...profile, answers }, {});
  assert.deepEqual(plan.missing, []);
  assert.equal(plan.fills.find((f) => f.name === 'gdpr').value, 'No');
});

test('Crossmark: a date, a checkbox list, and the optional cover letter left alone', () => {
  const page = wk.fromSpec(fixture('workable_crossmark.json'));
  const kinds = Object.fromEntries(page.fields.map((f) => [f.name, f.kind]));
  assert.equal(kinds.CA_33876, 'date');
  assert.equal(page.fields.find((f) => f.name === 'QA_12658069').type, 'multiselect');
  const plan = m.planFill(page.fields, profile, {});
  assert.ok(!plan.fills.some((f) => f.name === 'cover_letter') && !plan.missing.some((f) => f.name === 'cover_letter'));
  assert.ok(plan.missing.some((f) => f.name === 'CA_33876'));
});

test('optional files and sections are left out, required ones are missing', () => {
  const spec = JSON.stringify({ labels: {}, form: [{ fields: [
    { id: 'resume', label: 'Resume', required: true, type: 'file' },
    { id: 'avatar', label: 'Photo', required: false, type: 'file' },
    { id: 'education', label: 'Education', required: false, type: 'group', fields: [] },
    { id: 'experience', label: 'Experience', required: true, type: 'group', fields: [] },
    { id: 'CA_1', label: 'Portfolio', required: true, type: 'file' },
    { id: 'CA_2', label: 'Notice period', required: true, type: 'dropdown', options: [{ name: '1', value: ' 1 month' }, { name: '2', value: ' 3 months' }] },
  ] }] });
  const page = wk.fromSpec(spec);
  assert.deepEqual(page.fields.map((f) => f.name), ['resume', 'experience', 'CA_1', 'CA_2']);
  assert.deepEqual(page.fields[3].options, ['1 month', '3 months']);
  const plan = m.planFill(page.fields, { ...profile, links: { website: 'https://dana.example.com' }, answers: [{ question: 'Notice period', answer: '1 month' }] }, {});
  assert.deepEqual(plan.fills.map((f) => [f.name, f.value]), [['resume', 'cv'], ['CA_2', '1 month']]);
  assert.deepEqual(plan.missing.map((f) => f.name), ['experience', 'CA_1']);
});

test('a broken spec reads as no form', () => {
  assert.equal(wk.fromSpec('not json'), null);
  assert.equal(wk.fromSpec('{"form": 1}'), null);
});

test('outcome: thank-you panel, captcha, field errors, a flash message', () => {
  assert.equal(wk.decide({ success: true, errors: [] }), 'submitted');
  assert.deepEqual(wk.decide({ success: false, captcha: true, errors: [] }), { failed: 'captcha' });
  assert.deepEqual(wk.decide({ errors: ['Phone: The phone number is invalid.'], alert: '' }), { failed: 'form errors: Phone: The phone number is invalid.' });
  assert.deepEqual(wk.decide({ errors: [], alert: 'Something went wrong.' }), { failed: 'Something went wrong.' });
  assert.equal(wk.decide({ errors: [], alert: '' }), null);
});
