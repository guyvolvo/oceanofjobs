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
