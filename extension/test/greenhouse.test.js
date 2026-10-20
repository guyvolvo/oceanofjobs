// No jsdom in this repo, so the fixtures go through the pure half of the
// filler: the Remix JSON every job-boards page ships, plus the planner.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const gh = require('../ats/greenhouse.js');
const m = require('../lib/match.js');

function fixture(name) {
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
  const script = html.match(/<script>(window\.__remixContext[\s\S]*?)<\/script>/);
  return { html, page: script && gh.fromRemix(script[1]) };
}

const profile = {
  contact: { first_name: 'Dana', last_name: 'Levi', email: 'dana@example.com', phone: '+972 54 000 0000', location: 'Tel Aviv, Israel' },
  links: { linkedin: 'https://linkedin.com/in/dana', github: '', website: '' },
  work: { authorized_countries: ['IL'], needs_sponsorship: false, notice_period: '', salary: '' },
  eeo: { gender: 'decline', race: null, veteran: null, disability: null },
  answers: [
    { question: 'Why do you want to join Figma?', answer: 'I use it every day.' },
    { question: 'From where do you intend to work?', answer: 'Tel Aviv' },
    { question: 'Are you authorized to work in the country for which you applied?', answer: 'Yes' },
    { question: 'Have you ever worked for Figma before, as an employee or a contractor/consultant?', answer: 'No' },
  ],
  settings: {},
};

test('matches job pages and the embed link, nothing else', () => {
  assert.ok(gh.matches('https://boards.greenhouse.io/figma/jobs/5426468004'));
  assert.ok(gh.matches('https://job-boards.greenhouse.io/figma/jobs/5426468004?gh_jid=5426468004'));
  assert.ok(gh.matches('https://job-boards.greenhouse.io/embed/job_app?for=airbnb&token=7789554'));
  assert.ok(!gh.matches('https://careers.airbnb.com/positions/7789554?gh_jid=7789554'));
  assert.ok(!gh.matches('https://job-boards.greenhouse.io/figma'));
  assert.ok(!gh.matches('http://boards.greenhouse.io/figma/jobs/1'));
  assert.ok(!gh.matches('not a url'));
  assert.ok(gh.onSite('https://job-boards.greenhouse.io/figma/jobs/5426468004/confirmation'));
});

test('reads every question from the Figma page', () => {
  const { page } = fixture('figma.html');
  const names = page.fields.map((f) => f.name);
  assert.deepEqual(names.slice(0, 6), ['first_name', 'last_name', 'email', 'phone', 'candidate_location', 'resume']);
  assert.ok(names.includes('gender') && names.includes('race') && names.includes('veteran_status'));
  const auth = page.fields.find((f) => f.label.startsWith('Are you authorized'));
  assert.equal(auth.type, 'select');
  assert.equal(auth.required, true);
  assert.deepEqual(auth.options, ['Yes', 'No']);
  assert.equal(page.redirectTo, null);
});

test('Figma plan: all required answered, decline picked for gender', () => {
  const { page } = fixture('figma.html');
  const { fills, missing } = m.planFill(page.fields, profile, {});
  assert.deepEqual(missing, []);
  const by = Object.fromEntries(fills.map((f) => [f.name, f.value]));
  assert.equal(by.first_name, 'Dana');
  assert.equal(by.candidate_location, 'Tel Aviv, Israel');
  assert.equal(by.resume, 'cv');
  assert.equal(by.question_12497118004, 'https://linkedin.com/in/dana');
  assert.equal(by.gender, 'decline');
  const gender = page.fields.find((f) => f.name === 'gender');
  assert.equal(gender.options[m.pickOption(gender.options, by.gender)], 'Decline To Self Identify');
  // race and veteran are optional and unset, so left blank
  assert.ok(!('race' in by) && !('veteran_status' in by));
});

test('Cloudflare plan: consent checkbox and source question need answers', () => {
  const { page } = fixture('cloudflare.html');
  const consent = page.fields.find((f) => f.type === 'multiselect');
  assert.equal(consent.name, 'question_64278784[]');
  assert.deepEqual(consent.options, ['Acknowledge/Confirm']);
  const { fills, missing } = m.planFill(page.fields, profile, {});
  assert.deepEqual(missing.map((f) => f.label), [
    'How did you hear about this job?',
    "Please review and acknowledge Cloudflare's Candidate Privacy Policy (cloudflare.com/candidate-privacy-notice/).",
  ]);
  const sponsor = fills.find((f) => f.key === 'sponsorship');
  assert.equal(sponsor.value, 'No');
  assert.ok(m.pickOption(sponsor.options, sponsor.value) >= 0);
});

test('Airbnb embed: required custom gender question is not guessed', () => {
  const { page } = fixture('airbnb_embed.html');
  const noEeo = { ...profile, eeo: { gender: null, race: null, veteran: null, disability: null } };
  const { missing } = m.planFill(page.fields, noEeo, {});
  const gender = missing.find((f) => f.label === 'Gender:');
  assert.ok(gender);
  assert.equal(m.isEeo(gender), true);
});

test('Anthropic page parses', () => {
  const { page } = fixture('anthropic.html');
  assert.ok(page.fields.length >= 20);
  assert.ok(page.fields.every((f) => f.name && typeof f.label === 'string'));
});

test('outcome decision', () => {
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'confirmation.html'), 'utf8');
  const confirmation = /class="confirmation"/.test(html);
  assert.equal(gh.decide({ path: '/figma/jobs/5426468004/confirmation', confirmation }), 'submitted');
  assert.equal(gh.decide({ path: '/embed/job_app/confirmation', confirmation }), 'submitted');
  assert.equal(gh.decide({ path: '/figma/jobs/5426468004', confirmation: false, captcha: true }).failed, 'captcha');
  assert.match(gh.decide({ path: '/figma/jobs/5426468004', confirmation: false, errors: ['Email'] }).failed, /Email/);
  assert.equal(gh.decide({ path: '/figma/jobs/5426468004', confirmation: false, errors: [] }), null);
});

test('a page without the Remix data is not a form', () => {
  assert.equal(gh.fromRemix('window.__remixContext = {"state":{"loaderData":{}}};'), null);
  assert.equal(gh.fromRemix('garbage'), null);
});
