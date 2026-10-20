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
