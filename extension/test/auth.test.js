// background.js's connection state: when a 401 marks the token as expired,
// and when a working token clears that mark again. The service worker runs
// in a vm with chrome.storage.local and fetch faked; nothing leaves the
// machine.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DIR = path.join(__dirname, '..');

function worker(answer) {
  const store = {};
  const pick = (keys) => Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, store[k]]));
  // Any chrome.* call the worker makes at load (listeners, alarms) is a no-op.
  const noop = new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : noop), apply: () => Promise.resolve() });
  const chrome = new Proxy({
    storage: {
      local: {
        get: async (keys) => pick(keys),
        set: async (o) => { Object.assign(store, o); },
        remove: async (keys) => { for (const k of [].concat(keys)) delete store[k]; },
      },
      session: noop,
      onChanged: noop,
    },
  }, { get: (t, k) => (k in t ? t[k] : noop) });
  const ctx = {
    chrome, console, URL, URLSearchParams, setTimeout, clearTimeout, crypto: globalThis.crypto, Intl,
    fetch: (url, init) => answer(url, init, store),
  };
  ctx.globalThis = ctx;
  ctx.importScripts = (...files) => { for (const f of files) vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), ctx, { filename: f }); };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(DIR, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
  return { ctx, store };
}

const reply = (status, body = {}) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

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
