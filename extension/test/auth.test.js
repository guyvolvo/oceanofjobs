// background.js's connection state: when a 401 marks the token as expired,
// and when a working token clears that mark again. The service worker runs
// in a vm with chrome.storage.local and fetch faked; nothing leaves the
// machine.
const test = require('node:test');
const assert = require('node:assert/strict');
const { worker, reply } = require('./worker.js');

test('a 401 for a token that a reconnect already replaced leaves the new token connected', async () => {
  let release;
  const { ctx, store } = worker(() => new Promise((r) => { release = () => r(reply(401)); }));
  store.token = 'ooj_old';
  const call = ctx.api('/me/apply/summary').catch((e) => e);
  await new Promise((r) => setImmediate(r));
  // The website hands over a new token (connect.js) while the old one's call is out.
  Object.assign(store, { token: 'ooj_new', authError: false });
  release();
  assert.equal((await call).status, 401);
  assert.equal(store.authError, false);
});

test('a 401 for the stored token still marks it expired', async () => {
  const { ctx, store } = worker(async () => reply(401));
  store.token = 'ooj_revoked';
  await ctx.api('/me/apply/summary').catch(() => {});
  assert.equal(store.authError, true);
});

test('a later answer that accepts the token clears the expired mark', async () => {
  const { ctx, store } = worker(async () => reply(200, { mode: 'local' }));
  Object.assign(store, { token: 'ooj_live', authError: true });
  await ctx.api('/me/storage');
  assert.equal(store.authError, false);
});

test('the popup checks a token marked expired again instead of trusting the mark', async () => {
  const { ctx, store } = worker(async (url) => reply(200, url.includes('/needs') ? { needs: [] } : { plan: 'free', applied_today: 0, remaining: 5 }));
  Object.assign(store, { token: 'ooj_live', authError: true });
  const out = await ctx.status();
  assert.equal(out.connected, true);
  assert.equal(out.authError, false);
  assert.equal(store.authError, false);
});

test('a server error is not an expired connection', async () => {
  const { ctx, store } = worker(async () => reply(503));
  store.token = 'ooj_live';
  const out = await ctx.status();
  assert.equal(out.connected, true);
  assert.notEqual(store.authError, true);
});
