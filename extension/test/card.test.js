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
