// The card's and popup's Submit (submitHere) in the service worker, with
// the page side stubbed: inTab answers as the fillers would, and the
// credit calls are replaced. Nothing is pressed and nothing leaves the machine.
const test = require('node:test');
const assert = require('node:assert/strict');
const { worker, reply } = require('./worker.js');

// A worker whose credit calls succeed and whose settle() is recorded.
function card(inTab) {
  const { ctx } = worker(async () => reply(200, {}));
  const settled = [];
  const calls = [];
  ctx.jobForTab = async () => ({ id: '0123456789abcdef', board: false });
  ctx.reserve = async () => ({ attemptId: 'att-000001' });
  ctx.cardGate = async () => ({ ok: true });
  ctx.settle = async (id, outcome, why) => { settled.push([outcome, why]); };
  ctx.inTab = async (tabId, ats, method, args = []) => { calls.push([ats, method, args]); return inTab(ats, method, args); };
  return { ctx, settled, calls };
}

const sender = { tab: { id: 7 }, frameId: 0 };
// The worker's objects come from the vm's realm: compare them as plain data.
const plain = (x) => JSON.parse(JSON.stringify(x));

test('a form that only went away after the card pressed Submit is unconfirmed, not submitted', async () => {
  // generic.outcome on a form that vanished with no word from the site:
  // 'submitted' when asked loosely, unconfirmed when strict.
  const { ctx, settled } = card((ats, method, args) => ({
    submitInfo: { text: 'Submit', selector: 'button' },
    submit: { url: 'https://acme.example/apply' },
    outcome: args[2] === true ? { failed: 'unconfirmed: the form closed without a confirmation' } : 'submitted',
  })[method]);
  const out = await ctx.submitHere({ url: 'https://acme.example/apply', frameId: 0 }, sender);
  assert.deepEqual(plain(out), { unknown: true });
  assert.deepEqual(settled.map((s) => s[0]), ['unconfirmed']);
});

test('the site saying thanks still counts as submitted', async () => {
  const { ctx, settled } = card((ats, method) => ({ submitInfo: { text: 'Submit' }, submit: {}, outcome: 'submitted' })[method]);
  assert.deepEqual(plain(await ctx.submitHere({ url: 'https://acme.example/apply', frameId: 0 }, sender)), { submitted: true });
  assert.deepEqual(settled.map((s) => s[0]), ['submitted']);
});

// Fill application from the popup, past the fill (assist stubbed) to Full automatic's Submit.
async function popupFill(url, answers) {
  const w = card((ats, method) => answers[ats + '.' + method]);
  w.ctx.chrome.tabs = { get: async () => ({ id: 7, url, title: 'Engineer', status: 'complete' }) };
  await w.ctx.chrome.storage.local.set({ token: 'ooj_x', cv: { name: 'cv.pdf' } });
  w.ctx.workdayFirst = async () => null;
  w.ctx.readForm = async () => ({ fields: [] });
  w.ctx.assist = async () => ({ filled: 3, auto: true });
  const out = plain(await w.ctx.fillTab(7));
  return { ...w, out, pressed: w.calls.filter(([, m]) => m === 'submit').map(([a]) => a) };
}

test('Full automatic from the popup presses the dedicated Submit on Greenhouse, as runs do', async () => {
  const { out, pressed, settled } = await popupFill('https://job-boards.greenhouse.io/acme/jobs/1', {
    'generic.submitInfo': { text: 'Submit' }, 'generic.submit': {}, 'generic.outcome': 'submitted',
    'greenhouse.submit': true, 'greenhouse.outcome': 'submitted',
  });
  assert.deepEqual(out.sent, { submitted: true });
  assert.deepEqual(pressed, ['greenhouse']);
  assert.deepEqual(settled.map((s) => s[0]), ['submitted']);
});

test('Greenhouse finding no button to press settles as failed, nothing sent', async () => {
  const { out, settled } = await popupFill('https://job-boards.greenhouse.io/acme/jobs/1', { 'greenhouse.submit': false });
  assert.ok(out.sent.failed);
  assert.deepEqual(settled.map((s) => s[0]), ['failed']);
});

test('a site with no dedicated filler still gets the generic Submit', async () => {
  const { out, pressed } = await popupFill('https://careers.acme.example/apply', {
    'generic.submitInfo': { text: 'Submit' }, 'generic.submit': {}, 'generic.outcome': 'submitted',
  });
  assert.deepEqual(out.sent, { submitted: true });
  assert.deepEqual(pressed, ['generic']);
});
