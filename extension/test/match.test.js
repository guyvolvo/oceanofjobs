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

test('an answer tied to a job fills that job only', () => {
  const saved = [
    { question: 'Why do you want to work here?', answer: "Riskified's fraud work", job_id: 'a1a1a1a1a1a1a1a1' },
    { question: 'How did you hear about us?', answer: 'LinkedIn' },
  ];
  assert.equal(m.findAnswer('Why do you want to work here?', saved, 'a1a1a1a1a1a1a1a1'), "Riskified's fraud work");
  assert.equal(m.findAnswer('Why do you want to work here?', saved, 'b2b2b2b2b2b2b2b2'), undefined);
  assert.equal(m.findAnswer('Why do you want to work here?', saved), undefined);
  assert.equal(m.findAnswer('How did you hear about us?', saved, 'b2b2b2b2b2b2b2b2'), 'LinkedIn');
  const plan = m.planFill([{ label: 'Why do you want to work here?', type: 'textarea', required: true }],
    { answers: saved }, { id: 'b2b2b2b2b2b2b2b2' });
  assert.equal(plan.fills.length, 0);
});

test('no card on sites that are never a job application', () => {
  for (const host of ['github.com', 'gist.github.com', 'gitlab.com', 'stackoverflow.com', 'en.wikipedia.org', 'www.reddit.com'])
    assert.equal(m.notJobSite(host), true, host);
  for (const host of ['job-boards.greenhouse.io', 'jobs.ashbyhq.com', 'careers.github-example.com', 'www.comeet.com', 'notgithub.com'])
    assert.equal(m.notJobSite(host), false, host);
});

test('a page is about a job by its words, not by a name that contains one', () => {
  assert.equal(m.notJobSite('dash.cloudflare.com'), true);
  for (const text of ['https://acme.com/careers/123', 'https://acme.com/jobs/5', 'https://x.com/embed/job_app?for=acme', 'Apply for Backend Engineer',
    'Senior Engineer | Acme Careers', 'https://acme.com/en/position/77', 'דרושים מפתחים', 'Upload your CV'])
    assert.equal(m.jobish(text), true, text);
  for (const text of ['https://dash.cloudflare.com/abc/oceanofjobs.com/analytics Workers | Cloudflare', 'https://x.com/iljobs-api/logs Logs',
    'https://example.com/settings Account settings'])
    assert.equal(m.jobish(text), false, text);
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

// Regression, bug 2 (2026-10-21): a job skipped for a question the profile
// can't answer is now on record (the server keeps unclaimed skips), so an
// automatic run doesn't pick it, and run the AI on it, every 15 minutes.
test('a job skipped for a missing answer is not picked again automatically', () => {
  const skipped = [{ job_id: 'n1', status: 'skipped', reason: 'Needs your answer: Why us?', at: new Date(NOW).toISOString() }];
  const ctx = { history: skipped, guardrails: {}, now: NOW, retrySkipped: false, minMatch: null };
  assert.deepEqual(m.pickJobs([{ id: 'n1', company_domain: 'acme.com' }, { id: 'n2', company_domain: 'beta.com' }], ctx).map((j) => j.id), ['n2']);
  // Answering re-queues it, and a queued job may retry.
  assert.equal(m.screenJob({ id: 'n1', company_domain: 'acme.com' }, { ...ctx, retrySkipped: true }), null);
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

test('demographic questions are recognised however they are worded, so AI never answers them', () => {
  for (const label of ['I identify my gender as', 'What is your ethnicity?', 'Race', 'Gender', 'Are you a veteran?',
    'Do you have a disability?', 'What is your sexual orientation?', 'Your pronouns', 'Do you identify as transgender?']) {
    assert.equal(m.isEeo({ label, type: 'select' }), true, label);
  }
  for (const label of ['First name', 'Why do you want to work here?', 'Years of Python experience']) {
    assert.equal(m.isEeo({ label, type: 'text' }), false, label);
  }
});

test('pickFrame takes the frame with the strongest form, else none', () => {
  const r = (frameId, score) => ({ frameId, result: { score } });
  assert.equal(m.pickFrame([r(0, 0), r(7, 12), r(9, 4)]).frameId, 7);
  assert.equal(m.pickFrame([r(0, 6), r(3, 6)]).frameId, 0);
  assert.equal(m.pickFrame([r(0, 0), { frameId: 2, result: null }, { frameId: 4 }]), null);
  assert.equal(m.pickFrame(undefined), null);
});

test('Hebrew contact labels (Experis) map to profile fields', () => {
  const cases = [['שם פרטי', 'first_name'], ['שם משפחה', 'last_name'], ['מייל', 'email'], ['דוא"ל', 'email'],
    ['נייד', 'phone'], ['טלפון', 'phone'], ['לינקדאין', 'linkedin']];
  for (const [label, key] of cases) assert.equal(m.classify({ label, type: 'text' }), key, label);
  assert.equal(m.classify({ label: 'העלאת קורות חיים', type: 'file' }), 'resume');
  assert.equal(m.classify({ label: 'קו"ח', type: 'file' }), 'resume');
});

test('suggestable: optional Yes/No radio questions get an AI suggestion, consent boxes never do', () => {
  const yesNo = ['Yes', 'No'];
  const fields = [
    { name: 'a', label: 'Email', type: 'email', required: true, options: [] },
    { name: 'b', label: 'This position requires working from the Netanya office. Can you meet this requirement?', type: 'radio', required: false, options: yesNo, checked: false },
    { name: 'c', label: 'Do you have hands-on experience deploying production environments on Azure?', type: 'radio', required: true, options: yesNo, checked: false },
    { name: 'd', label: 'Upload with', type: 'radio', required: false, options: ['CV', 'LinkedIn'], checked: true },
    { name: 'e', label: 'Do you agree to the privacy policy?', type: 'radio', required: false, options: yesNo, checked: false },
    { name: 'f', label: 'I agree to the privacy policy', type: 'checkbox', required: true, options: [] },
    { name: 'g', label: 'Consent', type: 'checkbox', required: true, options: ['I accept the terms', 'Send me news'] },
    { name: 'h', label: 'Which clouds have you used?', type: 'checkbox', required: true, options: ['AWS', 'Azure'] },
    { name: 'i', label: 'Gender', type: 'radio', required: false, options: ['Male', 'Female'], checked: false },
    { name: 'j', label: 'Website', type: 'text', required: false, options: [] },
    { name: 'k', label: 'Cover letter', type: 'file', required: true, options: [] },
    { name: 'l', label: 'אני מאשר/ת קבלת הצעות עבודה', type: 'checkbox', required: true, options: ['כן', 'לא'] },
    { name: 'm', label: 'Send with', type: 'radio', required: false, options: ['LinkedIn profile'], checked: false },
    { name: 'n', label: 'If you picked Trauma above, how many hours of experience do you have?', type: 'radio', required: false, options: ['More than 20 hours', 'Under 5 hours'], checked: false },
    { name: 'o', label: 'Do you identify as LGBTQIA+?', type: 'radio', required: false, options: ['Yes', 'No', 'Prefer not to answer'], checked: false },
    { name: 'p', label: 'האם תוכל/י לעבוד ממשרדי החברה בנתניה?', type: 'radio', required: false, options: ['כן', 'לא'], checked: false },
  ];
  const plan = m.planFill(fields, { ...profile, eeo: {} }, {});
  assert.deepEqual(m.suggestable(fields, plan).map((f) => f.name).sort(), ['b', 'c', 'h', 'p']);
});

test('plural picks the word for a count', () => {
  assert.equal(m.plural(1, 'field'), 'field');
  assert.equal(m.plural(0, 'field'), 'fields');
  assert.equal(m.plural(3, 'needs', 'need'), 'need');
});

test('reasonText: internal reasons as the user reads them', () => {
  assert.equal(m.reasonText('captcha'), 'The site asked for a CAPTCHA.');
  assert.equal(m.reasonText('needs answer: Why us?; Salary?'), 'Needs your answer: Why us?; Salary?');
  assert.equal(m.reasonText('form errors: Email, Phone'), 'The form needs your attention: Email, Phone');
  assert.equal(m.reasonText('Ashby will not take this application: closed'), "Ashby couldn't submit this application: closed");
  assert.equal(m.reasonText('Country: no options to pick from'), 'Country: The list had no options to choose from.');
  assert.equal(m.reasonText('Country: no option matches "Israel"'), 'Country: None of the options match "Israel".');
  assert.equal(m.reasonText('Visa: not on the page'), "Visa: This field isn't on the page.");
  assert.equal(m.reasonText('blocked company'), 'This company is on your Never apply to list.');
  assert.equal(m.reasonText('tab closed'), 'The tab was closed before the site confirmed the application.');
  assert.equal(m.reasonText('could not fill Phone: no phone box on the page; CV: no file input'),
    "Couldn't fill in Phone: Couldn't find the phone number field.; CV: Couldn't find the file upload field.");
  assert.equal(m.reasonText('no confirmation after submitting'), "The form was sent, but the site didn't confirm it. Look for a confirmation email.");
  assert.equal(m.reasonText('unsupported site'), "Can't apply automatically on this site. Open the job to fill it in yourself.");
  // Already user-facing, or with no wording of its own: unchanged.
  assert.equal(m.reasonText('below your minimum match'), 'below your minimum match');
  assert.equal(m.reasonText("Couldn't find the application form."), "Couldn't find the application form.");
  assert.equal(m.reasonText(''), '');
  assert.equal(m.reasonText(undefined), '');
});

test('filledText counts in the singular and plural and leaves out zeros', () => {
  assert.equal(m.filledText({ filled: 1, suggested: 0, missing: [], errors: [] }), 'Filled in 1 field.');
  assert.equal(m.filledText({ filled: 3, suggested: 1, missing: ['a'], errors: ['x', 'y'] }),
    "Filled in 3 fields. Suggested 1 answer with AI (outlined in amber). 1 needs your input. 2 couldn't be filled.");
  assert.equal(m.filledText({ filled: 5, suggested: 2, missing: ['a', 'b'], errors: [] }),
    'Filled in 5 fields. Suggested 2 answers with AI (outlined in amber). 2 need your input.');
});

test('mustAnswer: every required box is ticked, a required agreement is a yes', () => {
  const box = (label, extra = {}) => m.mustAnswer({ type: 'checkbox', options: [], required: true, label, ...extra });
  for (const label of [
    'I agree to the Privacy Policy',
    'I certify that the information I provided is true and complete',
    'I understand that AI-based tools may be used to assist in screening job applications',
    'I would like to join the talent pool and hear about future opportunities',
  ]) assert.equal(box(label), 'Yes', label);
  assert.equal(box('Terms', { options: ['I agree'] }), 'I agree', 'a group of one');
  assert.equal(box('Allow us to process your personal information.', { required: false }), undefined, 'optional');
  assert.equal(box('Which offices could you work from?', { options: ['London', 'Berlin'] }), undefined, 'a real question');
  const yn = (label) => m.mustAnswer({ type: 'radio', options: ['Yes', 'No'], required: true, label });
  assert.equal(yn('Do you agree to our privacy policy?'), 'Yes');
  assert.equal(yn('Do you consent to receive marketing emails?'), 'No');
  assert.equal(yn('Do you require visa sponsorship?'), undefined, 'answered from the profile or by the AI');
  assert.equal(m.mustAnswer({ type: 'radio', options: ['Yes', 'No'], required: true, label: 'Do you identify as a veteran? I agree to self-identify' }), undefined, 'EEO');
});

test('contact labels in the languages SmartRecruiters and Breezy forms come in', () => {
  const want = {
    Prénom: 'first_name', Nom: 'last_name', 'Nom de famille': 'last_name', 'E-mail': 'email', 'Confirmez votre e-mail': 'email', Ville: 'location',
    'Numéro de téléphone': 'phone', Pays: 'country', 'Nombre completo': 'full_name', 'Correo electrónico': 'email', Ciudad: 'location',
    'Número de teléfono': 'phone', Cognome: 'last_name', 'Nome e cognome': 'full_name', Wohnort: 'location', Nazwisko: 'last_name',
  };
  for (const [label, key] of Object.entries(want)) assert.equal(m.classify({ label, type: 'text', name: '' }), key, label);
  assert.equal(m.classify({ label: 'Nom du poste actuel', type: 'text', name: '' }), null, 'a longer question is left alone');
});
