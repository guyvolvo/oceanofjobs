// The pure parts of ats/workday.js: which pages are a posting, and which
// words mean the application went in or an account needs confirming.
// The walk through a live site is tests/e2e/_workday_enter.mjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const w = require('../ats/workday.js');
const g = require('../ats/generic.js');

test('a posting on any company Workday site, and the steps of its application', () => {
  for (const u of [
    'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Senior-Engineer_JR2019101',
    'https://evergreenix.wd1.myworkdayjobs.com/external-careers2/job/USA_Remote/AI-Enterprise-Architect_JR500924',
    'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US%2C-CA%2C-Santa-Clara/Senior-Engineer_JR2019101/apply/applyManually',
    'https://wd3.myworkdaysite.com/recruiting/acme/External/job/London/Analyst_R-12345',
  ]) assert.ok(w.matches(u), u);
  for (const u of ['https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite', 'https://boards.greenhouse.io/acme/jobs/1', 'https://myworkdayjobs.com.evil.test/job/x/y_1']) {
    assert.ok(!w.matches(u), u);
  }
});

test('Workday confirmation wording', () => {
  for (const t of ['Application Submitted', 'Your application has been successfully submitted.', 'Congratulations! Thanks for applying.']) assert.ok(w.DONE.test(t), t);
  assert.ok(!w.DONE.test('Review your application, then submit it.'));
});

test('a new account that needs its email confirmed first', () => {
  for (const t of ['Please verify your email address', 'We sent you an email. Check your inbox to verify your account.', 'A verification email was sent']) assert.ok(w.VERIFY.test(t), t);
  assert.ok(!w.VERIFY.test('Sign in with email'));
});

test("Workday's Save and Continue is a step, its Submit the final button", () => {
  assert.equal(g.buttonKind('Save and Continue'), 'step');
  assert.equal(g.buttonKind('Submit'), 'final');
});
