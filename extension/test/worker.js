// background.js loaded in a vm, with chrome.storage faked and fetch
// answered by the test. Top-level functions are globals of ctx, so a test
// can replace one (ctx.inTab = ...) and the worker calls the replacement.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DIR = path.join(__dirname, '..');

function area(store) {
  const pick = (keys) => Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, store[k]]));
  return {
    get: async (keys) => pick(keys),
    set: async (o) => { Object.assign(store, o); },
    remove: async (keys) => { for (const k of [].concat(keys)) delete store[k]; },
  };
}

function worker(answer) {
  const store = {};
  // Any chrome.* call the worker makes at load (listeners, alarms) is a no-op.
  const noop = new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : noop), apply: () => Promise.resolve() });
  const chrome = new Proxy({
    storage: { local: area(store), session: area({}), onChanged: noop },
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

module.exports = { worker, reply };
