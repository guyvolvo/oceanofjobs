const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../lib/match.js');

const profile = {
  contact: { first_name: 'Dana', last_name: 'Levi', email: 'dana@example.com', phone: '+972 54 000 0000', location: 'Tel Aviv, Israel' },
  links: { linkedin: 'https://linkedin.com/in/dana', github: '', website: 'https://dana.dev' },
  work: { authorized_countries: ['IL'], needs_sponsorship: false, notice_period: '30 days', salary: '' },
  eeo: { gender: 'female', race: 'decline', veteran: null, disability: null },
  answers: [
    { question: 'How did you hear about this job?', answer: 'Ocean of Jobs' },
    { question: 'Have you ever worked for Figma before, as an employee or a contractor/consultant?', answer: 'No' },
  ],
};

test('normalise strips punctuation, case and spacing', () => {
  assert.equal(m.normalise('  Are you authorised to work in the U.S.?* '), 'are you authorized to work in the us');
  assert.equal(m.normalise("Don’t   wish to answer"), 'dont wish to answer');
});

test('classify by Greenhouse name, then by label', () => {
  assert.equal(m.classify({ name: 'first_name', label: 'First Name' }), 'first_name');
  assert.equal(m.classify({ name: 'question_1', label: 'LinkedIn Profile' }), 'linkedin');
  assert.equal(m.classify({ name: 'question_2', label: 'Will you now or in the future require company sponsorship to retain or extend your work authorization?' }), 'sponsorship');
  assert.equal(m.classify({ name: 'question_3', label: 'Are you legally authorized to work in the country where the job is located?' }), 'work_auth');
  assert.equal(m.classify({ name: 'question_4', label: 'Other Website' }), 'website');
  assert.equal(m.classify({ name: 'question_5', label: 'Why do you want to join Figma?' }), null);
  assert.equal(m.classify({ name: 'question_6', label: 'Gender:' }), 'gender');
  assert.equal(m.classify({ name: 'country', label: 'Country' }), 'phone_country');
});

test('classify contact fields by label alone, for any form', () => {
  const c = (label, type = 'text') => m.classify({ name: 'ooj-1', label, type });
  assert.equal(c('First name'), 'first_name');
  assert.equal(c('Legal last name'), 'last_name');
  assert.equal(c('Full name'), 'full_name');
  assert.equal(c('Name'), 'full_name');
  assert.equal(c('E-mail address'), 'email');
  assert.equal(c('Mobile phone number'), 'phone');
  assert.equal(c('Current location'), 'location');
  assert.equal(c('Country of residence'), 'country');
  // Anchored: questions that only mention these stay questions.
  assert.equal(c('What name do you go by at work?'), null);
  assert.equal(c('Email address of your referrer'), null);
  assert.equal(c('Volledige naam'), 'full_name');
  assert.equal(c('E-mailadres'), 'email');
  // Language-free hints: the autocomplete token, then the input type.
  assert.equal(m.classify({ name: 'ooj-1', label: 'Imię', type: 'text', autocomplete: 'given-name' }), 'first_name');
  assert.equal(c('Correo', 'email'), 'email');
  assert.equal(c('Numer', 'tel'), 'phone');
  assert.equal(c('Referee email', 'email'), null);
  assert.equal(m.profileValue('full_name', { contact: { first_name: 'Dana', last_name: 'Levi' } }), 'Dana Levi');
  assert.equal(m.profileValue('country', { contact: { location: 'Tel Aviv, Israel' } }), 'Israel');
});

test('only a file input takes the CV', () => {
  assert.equal(m.classify({ name: 'ooj-1', label: 'Resume/CV', type: 'file' }), 'resume');
  assert.equal(m.classify({ name: 'ooj-2', label: 'Cover letter', type: 'file' }), 'cover_letter');
  assert.equal(m.classify({ name: 'ooj-3', label: 'Photo', type: 'file' }), null);
  assert.equal(m.classify({ name: 'ooj-4', label: 'Resume', type: 'textarea' }), null);
});

test('pickOption handles yes/no, decline and partial labels', () => {
  assert.equal(m.pickOption(['Yes', 'No'], 'No'), 1);
  assert.equal(m.pickOption(['Yes, I am authorized', 'No, I am not'], 'Yes'), 0);
  assert.equal(m.pickOption(['Male', 'Female', 'Decline To Self Identify'], 'decline'), 2);
  assert.equal(m.pickOption(['Male', 'Female', "I don't wish to answer"], 'decline'), 2);
  assert.equal(m.pickOption(['Male', 'Female'], 'female'), 1);
  assert.equal(m.pickOption(['Asian', 'Black or African American'], 'black'), 1);
  assert.equal(m.pickOption(['Israel +972', 'Italy +39'], 'Israel'), 0);
  assert.equal(m.pickOption(['Canada +1', 'United States +1'], 'United States'), 1);
  assert.equal(m.pickOption(['Yes', 'No'], 'Maybe'), -1);
  // Live Greenhouse veteran options: a loose match must not pick the wrong one.
  const veteran = ['I am not a protected veteran', 'I identify as one or more of the classifications of a protected veteran', "I don't wish to answer"];
  assert.equal(m.pickOption(veteran, 'protected veteran'), -1);
  assert.equal(m.pickOption(veteran, 'I am not a protected veteran'), 0);
  assert.equal(m.pickOption(veteran, 'decline'), 2);
});

test('findAnswer matches normalised wording, not a different company', () => {
  assert.equal(m.findAnswer('How did you hear about this job', profile.answers), 'Ocean of Jobs');
  assert.equal(m.findAnswer('Have you ever worked for Figma before, as an employee or a contractor / consultant?', profile.answers), 'No');
  assert.equal(m.findAnswer('Have you ever worked for Airbnb before, as an employee or a contractor/consultant?', profile.answers), undefined);
  const saved = [{ question: 'Are you authorized to work in the U.S.?', answer: 'Yes' }];
  assert.equal(m.findAnswer('Are you legally authorized to work in the United States?', saved), 'Yes');
  assert.equal(m.findAnswer('Are you authorized to work in Canada?', saved), undefined);
  assert.equal(m.findAnswer('Anything else?', [{ question: 'Anything else?', answer: '  ' }]), undefined);
});

test('work authorization follows the job country', () => {
  assert.equal(m.profileValue('work_auth', profile, { country: 'IL' }), 'Yes');
  assert.equal(m.profileValue('work_auth', profile, { country: 'US' }), 'No');
  assert.equal(m.profileValue('work_auth', profile, { country: 'IL,US' }), undefined);
  assert.equal(m.profileValue('work_auth', profile, {}), undefined);
});

test('EEO values only when set, hispanic follows race', () => {
  assert.equal(m.profileValue('gender', profile), 'female');
  assert.equal(m.profileValue('veteran', profile), undefined);
  assert.equal(m.profileValue('hispanic', profile), 'decline');
  assert.equal(m.profileValue('hispanic', { eeo: { race: 'White' } }), 'No');
  assert.equal(m.profileValue('hispanic', { eeo: { race: null } }), undefined);
});

test('planFill fills what it knows and lists required unknowns', () => {
  const fields = [
    { name: 'first_name', label: 'First Name', required: true, type: 'text', options: [] },
    { name: 'resume', label: 'Resume/CV', required: true, type: 'file', options: [] },
    { name: 'question_1', label: 'Why us?', required: true, type: 'textarea', options: [] },
    { name: 'question_2', label: 'Pronouns', required: false, type: 'select', options: ['She/her', 'He/him'] },
    { name: 'question_3', label: 'Do you require visa sponsorship?', required: true, type: 'select', options: ['Yes', 'No'] },
    { name: 'gender', label: 'Gender', required: false, type: 'select', options: ['Male', 'Female', 'Decline To Self Identify'] },
    { name: 'veteran_status', label: 'Veteran Status', required: false, type: 'select', options: ['I am a veteran', 'I am not a veteran'] },
  ];
  const { fills, missing } = m.planFill(fields, profile, {});
  const by = Object.fromEntries(fills.map((f) => [f.name, f.value]));
  assert.deepEqual(by, { first_name: 'Dana', resume: 'cv', question_3: 'No', gender: 'female' });
  assert.deepEqual(missing.map((f) => f.label), ['Why us?']);
});

test('a saved answer that fits no option counts as missing', () => {
  const fields = [{ name: 'q', label: 'How did you hear about this job?', required: true, type: 'select', options: ['LinkedIn', 'Referral'] }];
  assert.equal(m.planFill(fields, profile, {}).missing.length, 1);
});

test('isEeo keeps demographic questions away from AI', () => {
  assert.equal(m.isEeo({ name: 'question_9', label: 'Gender:' }), true);
  assert.equal(m.isEeo({ name: 'question_9', label: 'Why us?' }), false);
});

const NOW = Date.parse('2026-10-20T12:00:00');
const history = [
  { job_id: 'a1', company: 'figma.com', status: 'submitted', at: new Date(NOW - 3600e3).toISOString() },
  { job_id: 'a2', company: 'stripe.com', status: 'submitted', at: new Date(NOW - 3 * 864e5).toISOString() },
  { job_id: 'a3', company: 'airbnb.com', status: 'skipped', at: new Date(NOW - 3600e3).toISOString() },
];

test('appliedToday counts submitted ones from today only', () => {
  assert.equal(m.appliedToday(history, NOW), 1);
});

test('budget respects plan, per-run cap and daily limit', () => {
  assert.equal(m.budget({ remaining: 10 }, history, {}, NOW, 3), 3);
  assert.equal(m.budget({ remaining: 1 }, history, {}, NOW, 3), 1);
  assert.equal(m.budget({ remaining: 10 }, history, { daily_limit: 2 }, NOW, 3), 1);
  assert.equal(m.budget({ remaining: 10 }, history, { daily_limit: 1 }, NOW, 3), 0);
  assert.equal(m.budget({ remaining: 0 }, history, {}, NOW, 3), 0);
});

test('screenJob applies the guardrails', () => {
  const g = { blocked_companies: ['meta.com'], one_per_company_days: 7 };
  const ctx = { history, guardrails: g, now: NOW, minMatch: 2 };
  assert.equal(m.screenJob({ id: 'a1', company_domain: 'figma.com', match_score: 5 }, ctx), 'already applied');
  assert.equal(m.screenJob({ id: 'a3', company_domain: 'airbnb.com', match_score: 5 }, ctx), 'already tried');
  assert.equal(m.screenJob({ id: 'a3', company_domain: 'airbnb.com', match_score: 5 }, { ...ctx, retrySkipped: true }), null);
  assert.equal(m.screenJob({ id: 'b1', company_domain: 'careers.meta.com', match_score: 5 }, ctx), 'blocked company');
  assert.equal(m.screenJob({ id: 'b2', company_domain: 'stripe.com', match_score: 5 }, ctx), 'applied to this company recently');
  assert.equal(m.screenJob({ id: 'b2', company_domain: 'stripe.com', match_score: 5 }, { ...ctx, guardrails: { one_per_company_days: 2 } }), null);
  assert.equal(m.screenJob({ id: 'b3', company_domain: 'wix.com', match_score: 1 }, ctx), 'below your minimum match');
  assert.equal(m.screenJob({ id: 'b3', company_domain: 'wix.com', match_score: 2 }, ctx), null);
});

test('pickJobs keeps one per company when limited', () => {
  const jobs = [
    { id: 'c1', company_domain: 'wix.com' },
    { id: 'c2', company_domain: 'wix.com' },
    { id: 'c3', company_domain: 'monday.com' },
  ];
  assert.deepEqual(m.pickJobs(jobs, { history: [], guardrails: { one_per_company_days: 30 }, now: NOW }).map((j) => j.id), ['c1', 'c3']);
  assert.equal(m.pickJobs(jobs, { history: [], guardrails: {}, now: NOW }).length, 3);
});

test('withQueued puts queued jobs before picked ones, without repeats', () => {
  const queued = [{ id: 'q1', company_domain: 'wix.com' }];
  const picked = [{ id: 'q1', company_domain: 'wix.com' }, { id: 'c2', company_domain: 'wix.com' }, { id: 'c3', company_domain: 'monday.com' }];
  assert.deepEqual(m.withQueued(queued, picked, {}).map((j) => j.id), ['q1', 'c2', 'c3']);
  assert.deepEqual(m.withQueued(queued, picked, { one_per_company_days: 30 }).map((j) => j.id), ['q1', 'c3']);
  assert.deepEqual(m.withQueued([], picked, {}).map((j) => j.id), ['q1', 'c2', 'c3']);
});
