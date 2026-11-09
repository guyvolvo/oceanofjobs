// The pure parts of the generic submit: which button text sends a form,
// and which page text says it was sent. The DOM half is covered by
// tests/e2e/_ext_generic_fixtures.mjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const g = require('../ats/generic.js');

test('final submit wording, in several languages', () => {
  for (const t of ['Submit', 'Submit application', 'SUBMIT YOUR APPLICATION', 'Apply', 'Apply now', 'Apply for this job', 'Send', 'Send application',
    'Submit →', 'Bewerbung absenden', 'Jetzt bewerben', 'Absenden', 'Verstuur sollicitatie', 'Solliciteer', 'Envoyer ma candidature', 'Postuler',
    'Enviar solicitud', 'Enviar', 'Postularme', 'שלח מועמדות', 'הגשת מועמדות', 'שליחה']) {
    assert.equal(g.buttonKind(t), 'final', t);
  }
});

test('step buttons lead to more questions', () => {
  for (const t of ['Next', 'Next step', 'Continue', 'Continue to questions', 'Weiter', 'Suivant', 'Siguiente', 'Volgende', 'הבא', 'המשך']) {
    assert.equal(g.buttonKind(t), 'step', t);
  }
});

test('anything else is neither', () => {
  for (const t of ['Apply with LinkedIn', 'Apply with Indeed', 'Save draft', 'Upload', 'Accept all cookies', 'Back', 'Submit later', 'Send me similar jobs', '']) {
    assert.equal(g.buttonKind(t), 'other', t);
  }
});

test('confirmation text is counted, so a posting that already says thanks does not confirm', () => {
  assert.equal(g.sentCount('Thank you for applying! We\'ll be in touch.'), 2);
  assert.equal(g.sentCount('Your application has been received.'), 1);
  assert.equal(g.sentCount('Application submitted successfully'), 1);
  assert.equal(g.sentCount('Thank you for your interest in Acme. About the role...'), 1);
  assert.equal(g.sentCount('Vielen Dank für Ihre Bewerbung'), 1);
  assert.equal(g.sentCount('Merci pour votre candidature'), 1);
  assert.equal(g.sentCount('Gracias por tu postulación'), 1);
  assert.equal(g.sentCount('Bedankt voor je sollicitatie'), 1);
  assert.equal(g.sentCount('מועמדותך נשלחה בהצלחה'), 1);
  assert.equal(g.sentCount('Submit your application below. We review every application.'), 0);
});

test('a form of only contact, address and card fields is no application', () => {
  const f = (label, type = 'text', autocomplete = null, tag = 'INPUT') => ({ label, type, autocomplete, tag });
  // Dodo's checkout: the card the extension showed on it.
  assert.ok(g.contactOnly([f('Full Name', 'text', 'name'), f('Email', 'email', 'email'), f('Phone (optional)', 'tel'),
    f('Country', 'select-one', 'country'), f('Address Line', 'text', 'address-line1'), f('Purchasing as a business', 'checkbox')]));
  assert.ok(g.contactOnly([f('First name'), f('Last name'), f('Email address'), f('Company'), f('ZIP code'), f('Card number', 'text', 'cc-number')]));
  assert.ok(g.contactOnly([f('Name'), f('Work email', 'email'), f('Phone number', 'tel'), f('I agree to the terms', 'checkbox')]));
  // Applications ask something else, or take a CV.
  assert.ok(!g.contactOnly([f('First name'), f('Last name'), f('Email', 'email'), f('LinkedIn profile')]));
  assert.ok(!g.contactOnly([f('Name'), f('Email', 'email'), f('Resume/CV', 'file')]));
  assert.ok(!g.contactOnly([f('Name'), f('Email', 'email'), f('Why do you want to work here?', 'textarea', null, 'TEXTAREA')]));
  assert.ok(!g.contactOnly([f('Full name'), f('Email', 'email'), f('Years of experience', 'number')]));
  assert.ok(!g.contactOnly([f('Do you need sponsorship?', 'checkbox')]), 'tick boxes alone are not a contact form either');
});

// weigh(): whether a form is a job application, from the words around it.
// Labels as the pages had them. application: may be sent. unrelated: never read or filled.
const isApp = (o, name) => { const w = g.weigh(o); assert.ok(w.application && !w.unrelated, `${name}: ${JSON.stringify(w)}`); };
const isNot = (o, name) => { const w = g.weigh(o); assert.ok(!w.application && w.unrelated, `${name}: ${JSON.stringify(w)}`); };

test('weigh: application forms, English and Hebrew', () => {
  isApp({ labels: ['First Name', 'Last Name', 'Email', 'Phone', 'LinkedIn Profile', 'Website'], files: ['Resume/CV resume'], button: 'Submit application' }, 'Greenhouse');
  isApp({ labels: ['Full name', 'Email', 'Phone', 'Current company', 'LinkedIn URL', 'GitHub URL', 'Additional information'], files: ['Resume/CV resume'], button: 'Submit application' }, 'Lever');
  isApp({ labels: ['First name', 'Last name', 'Email', 'Phone', 'Portfolio', 'Personal note'], files: ['Resume resume', 'Cover letter coverLetter'], button: 'SUBMIT APPLICATION', ats: true }, 'Comeet frame');
  isApp({ labels: ['Name', 'Email', 'What are your salary expectations?', 'What is your notice period?'], button: 'Send' }, 'no CV, two questions');
  isApp({ labels: ['Name', 'Email', 'Will you now or in the future require visa sponsorship?', 'Gender', 'Veteran status'], files: ['Attach file'], text: 'Upload your CV' }, 'a file near CV words');
  isApp({ labels: ['שם פרטי', 'שם משפחה', 'מייל', 'נייד'], files: ['העלאת קורות חיים file cv'], button: 'שליחה' }, 'Experis');
  isApp({ labels: ['שם מלא', 'טלפון', 'קישור לפרופיל לינקדאין', 'ציפיות שכר'], button: 'הגשת מועמדות' }, 'Hebrew, no CV');
  isApp({ labels: ['Vorname', 'Nachname', 'E-Mail', 'Gehaltsvorstellung', 'Frühester Eintrittstermin'], files: ['Lebenslauf'], button: 'Bewerbung absenden' }, 'German');
  // An application that also offers news about jobs is still one.
  isApp({ labels: ['First name', 'Email', 'Send me news about future jobs'], files: ['Resume'], context: 'Apply for this job' }, 'Comeet with a news box');
  // An ATS's own page with nothing against it: Workday's My Information step.
  isApp({ labels: ['Country', 'First Name', 'Phone Number'], button: 'Save and Continue', ats: true }, 'Workday step');
  isApp({ labels: [], pinned: true }, "Workday's pinned Review page");
});

test('weigh: mailing list, contact, demo, event, download, search, login, comment', () => {
  isNot({ labels: ['First Name *', 'Last Name *', 'Work Email *', 'Country *', 'I have read and accept the Privacy Policy | Personal emails will not be accepted', 'What is 6 + 8?'],
    context: 'Keep in touch \n Please fill in the form if you would like to be added to our mailing list to receive Surecomp updates!', button: 'Submit', attrs: 'form1' }, 'Surecomp');
  isNot({ labels: ['First name', 'Last name', 'Email', 'What is 6 + 8?'], button: 'Submit' }, 'a math check alone');
  isNot({ labels: ['First name', 'Last name', 'Business email', 'Company name', 'Job title', 'Company size', 'Phone number'], context: 'Request a demo', button: 'Get a demo' }, 'demo');
  isNot({ labels: ['Name', 'Email', 'Subject', 'Message'], context: 'Contact us', button: 'Send message' }, 'contact');
  isNot({ labels: ['First name', 'Last name', 'Email', 'Company'], context: 'Register for the webinar', button: 'Register now' }, 'webinar');
  isNot({ labels: ['Name', 'Work email', 'Company'], context: 'Download the 2026 trade finance whitepaper', button: 'Download' }, 'download');
  isNot({ labels: ['Name', 'Email', 'Company', 'Message'], context: 'Talk to sales', button: 'Get a quote' }, 'sales');
  isNot({ labels: ['Keywords', 'Location', 'Radius'], button: 'Search jobs' }, 'search');
  isNot({ labels: ['Email', 'Remember me'], button: 'Sign in' }, 'login');
  isNot({ labels: ['Name', 'Email', 'Website', 'Comment'], context: 'Leave a Reply', button: 'Post Comment', attrs: 'commentform' }, 'comment');
  isNot({ labels: ['Email', 'Location'], context: 'Get job alerts for roles like this', button: 'Create alert' }, 'job alert');
  isNot({ labels: ['Email', 'First name', 'Last name'], context: 'Stay updated', button: 'Subscribe', text: 'This site is protected by reCAPTCHA and the Google Privacy Policy and Terms of Service apply.' }, 'newsletter under a reCAPTCHA notice');
  isNot({ labels: ['שם מלא', 'אימייל'], context: 'הרשמה לניוזלטר', button: 'הרשמה' }, 'Hebrew newsletter');
  isNot({ labels: ['שם', 'טלפון', 'אימייל', 'הודעה'], context: 'צרו קשר', button: 'שליחה' }, 'Hebrew contact');
  isNot({ labels: ['שם', 'חברה', 'טלפון'], context: 'תיאום הדגמה', button: 'שלחו' }, 'Hebrew demo');
  // An ATS vendor's own marketing form is no application either.
  isNot({ labels: ['Name', 'Work email', 'Company size'], context: 'Request a demo of Comeet', ats: true }, 'ATS vendor demo');
});

test('weigh: a form with nothing either way can be filled but not sent', () => {
  for (const [name, o] of [
    ['name, email, phone', { labels: ['Full name', 'Email', 'Phone'], button: 'Submit' }],
    ['one application question', { labels: ['Name', 'Email', 'LinkedIn profile'], button: 'Submit' }],
    ['an apply heading over a subscribe box', { labels: ['Full name', 'Email', 'Phone', 'Subscribe to job alerts'], context: 'Apply for this job' }],
    ['a Hebrew apply form with no CV', { labels: ['שם מלא', 'טלפון'], context: 'הגשת מועמדות למשרה' }],
  ]) {
    const w = g.weigh(o);
    assert.ok(!w.application && !w.unrelated, `${name}: ${JSON.stringify(w)}`);
  }
});

test('weigh: a score for the logs, highest for the application', () => {
  const app = g.weigh({ labels: ['Email', 'LinkedIn'], files: ['Resume'], button: 'Submit application' });
  const mail = g.weigh({ labels: ['Email', 'What is 6 + 8?'], context: 'Keep in touch', button: 'Submit' });
  assert.ok(app.score > 0 && mail.score < 0, JSON.stringify({ app, mail }));
  assert.deepEqual(g.weigh(), { application: false, unrelated: false, score: 0, cv: false, questions: 0, apply: false, ats: false, off: 0 });
});
