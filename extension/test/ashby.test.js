// Ashby's form definition, as its GraphQL answers for two live postings,
// through the pure half of the filler and the planner.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ashby = require('../ats/ashby.js');
const m = require('../lib/match.js');

const form = (name) => ashby.fromGraphql(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));

const profile = {
  contact: { first_name: 'Dana', last_name: 'Levi', email: 'dana@example.com', phone: '+972 54 000 0000', location: 'Tel Aviv, Israel' },
  links: { linkedin: 'https://linkedin.com/in/dana', github: '', website: '' },
  work: { authorized_countries: ['IE'], needs_sponsorship: false, notice_period: '30 days', salary: '' },
  eeo: {},
  answers: [
    { question: 'When can you start a new role?', answer: '2026-12-01' },
    { question: 'Are you able to work from our Dublin office three days per week?', answer: 'Yes' },
  ],
  settings: {},
};

test('matches posting and form links on jobs.ashbyhq.com only', () => {
  const id = 'be538c90-d409-4c02-b09e-c40627a0d06d';
  assert.ok(ashby.matches(`https://jobs.ashbyhq.com/wayve/${id}`));
  assert.ok(ashby.matches(`https://jobs.ashbyhq.com/checkout.com/${id}/application`));
  assert.ok(ashby.matches(`https://jobs.ashbyhq.com/wayve/${id}?utm_source=x`));
  assert.ok(!ashby.matches('https://jobs.ashbyhq.com/wayve'));
  assert.ok(!ashby.matches(`https://jobs.ashbyhq.com/wayve/${id}/other`));
  assert.ok(!ashby.matches(`http://jobs.ashbyhq.com/wayve/${id}`));
  assert.ok(!ashby.matches(`https://careers.wayve.ai/wayve/${id}`));
  assert.ok(!ashby.matches('not a url'));
  assert.ok(ashby.onSite(`https://jobs.ashbyhq.com/wayve/${id}/application`));
  assert.ok(!ashby.onSite('https://job-boards.greenhouse.io/figma/jobs/1'));
});

test('formUrl points at the application route, once', () => {
  const id = 'be538c90-d409-4c02-b09e-c40627a0d06d';
  assert.equal(ashby.formUrl(`https://jobs.ashbyhq.com/wayve/${id}`), `https://jobs.ashbyhq.com/wayve/${id}/application`);
  assert.equal(ashby.formUrl(`https://jobs.ashbyhq.com/wayve/${id}/application`), `https://jobs.ashbyhq.com/wayve/${id}/application`);
  assert.equal(ashby.formUrl(`https://jobs.ashbyhq.com/wayve/${id}/?src=ooj`), `https://jobs.ashbyhq.com/wayve/${id}/application?src=ooj`);
});

test('reads every field with its type and options', () => {
  const page = form('ashby_snowflake.json');
  assert.equal(page.fields.length, 16);
  const by = (start) => page.fields.find((f) => f.label.startsWith(start));
  assert.equal(by('Full Name').name, '_systemfield_name');
  assert.equal(by('Phone Number').type, 'phone');
  assert.equal(by('Location').type, 'location');
  assert.equal(by('Resume').type, 'file');
  assert.deepEqual(by('Will you require company sponsorship').options, ['Yes', 'No']);
  assert.equal(by('A “U.S. person”').type, 'select');
  assert.equal(by('A “U.S. person”').options.length, 3);
  assert.equal(by('Snowflake will process').type, 'multiselect');
  assert.equal(form('ashby_openai.json').fields.find((f) => f.label.startsWith('When can')).type, 'date');
  assert.equal(ashby.fromGraphql('{"data":{"jobPosting":null}}'), null);
  assert.equal(ashby.fromGraphql('not json'), null);
});

test('OpenAI plan: standard fields from the profile, saved answers by label', () => {
  const { fills, missing } = m.planFill(form('ashby_openai.json').fields, profile, { country: 'IE' });
  const by = (start) => (fills.find((f) => f.label.startsWith(start)) || {}).value;
  assert.equal(by('Legal Name'), 'Dana Levi');
  assert.equal(by('Email'), 'dana@example.com');
  assert.equal(by('Phone Number'), '+972 54 000 0000');
  assert.equal(by('Where are you currently located?'), 'Tel Aviv, Israel');
  assert.equal(by('Resume'), 'cv');
  assert.equal(by('When can you start a new role?'), '2026-12-01');
  assert.equal(by('Are you authorized to work'), 'Yes');
  assert.equal(by('Will you now or in the future require sponsorship'), 'No');
  // The certification checkbox is never ticked without a saved answer.
  assert.equal(missing.length, 1);
  assert.equal(missing[0].type, 'multiselect');
  assert.match(missing[0].label, /^I hereby certify/);
});

test('number and date fields take only numbers and dates', () => {
  const fields = [
    { name: 'a', label: 'Notice period (months)', required: true, type: 'number', options: [] },
    { name: 'b', label: 'Expected salary', required: true, type: 'number', options: [] },
    { name: 'c', label: 'Start date', required: true, type: 'date', options: [] },
  ];
  const p = { ...profile, work: { notice_period: '30 days', salary: '90,000' }, answers: [] };
  const { fills, missing } = m.planFill(fields, p, {});
  assert.deepEqual(fills.map((f) => [f.name, f.value]), [['b', '90,000']]);
  assert.deepEqual(missing.map((f) => f.name), ['a', 'c']);
});

test('classify knows Ashby name parts and typed phones', () => {
  assert.equal(m.classify({ name: 'x', label: 'Legal First Name' }), 'first_name');
  assert.equal(m.classify({ name: 'x', label: 'Legal Surname' }), 'last_name');
  assert.equal(m.classify({ name: 'x', label: 'Móvil', type: 'phone' }), 'phone');
  assert.equal(m.classify({ name: 'x', label: 'Cover Letter', type: 'file' }), 'cover_letter');
  assert.equal(m.classify({ name: '_systemfield_location', label: 'Where are you based?' }), 'location');
});

test('outcome: success, failure text, captcha, field errors', () => {
  assert.equal(ashby.decide({ success: true }), 'submitted');
  assert.deepEqual(ashby.decide({ failure: "We couldn't submit your application" }), { failed: "We couldn't submit your application" });
  assert.deepEqual(ashby.decide({ captcha: true, failure: 'x' }), { failed: 'captcha' });
  assert.deepEqual(ashby.decide({ errors: ['Email is required'] }), { failed: 'form errors: Email is required' });
  assert.equal(ashby.decide({ errors: [] }), null);
});
