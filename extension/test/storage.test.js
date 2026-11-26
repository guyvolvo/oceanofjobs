// syncStorage when "Save my settings to: Account" was chosen somewhere else:
// this browser's CV and secrets go up to its own account first, and never
// to an account whose token some page planted.
const test = require('node:test');
const assert = require('node:assert/strict');
const { worker, reply } = require('./worker.js');

const CV = { name: 'Dana_Levi_CV.pdf', type: 'application/pdf', size: 4, data: 'JVBERg==' };

function account(user) {
  const sent = [];
  const box = { cv: null, workday: null, ai: null };
  const w = worker(async (url, init = {}) => {
    const path = url.replace(/^.*\/api/, '');
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    sent.push({ method, path, body });
    if (path === '/me/storage') return reply(200, { mode: 'account', ready: true, cv: box.cv, workday: !!box.workday, ai: box.ai, user });
    if (path === '/me/cv' && method === 'PUT') {
      box.cv = { name: body.name, type: body.type, size: 4, uploaded_at: '2026-11-26T10:00:00Z', data: body.data };
      return reply(200, { mode: 'account', cv: box.cv });
    }
    if (path === '/me/cv') return box.cv ? reply(200, box.cv) : reply(404);
    if (path === '/me/storage/secrets' && method === 'PUT') { Object.assign(box, body); return reply(200, {}); }
    if (path === '/me/storage/secrets') return reply(200, { workday: box.workday, ai: box.ai });
    return reply(404);
  });
  Object.assign(w.store, { token: 'ooj_t', storageMode: 'local', cv: CV, cvSavedAt: '2026-11-01T00:00:00Z', workday: { password: 'Xk7!mP2#qR9$' } });
  return { ...w, sent, box };
}

test('the first sync after the account was chosen elsewhere uploads the local CV and keeps it', async () => {
  const { ctx, store, sent, box } = account('u1');
  store.storageUser = 'u1';
  await ctx.syncStorage();
  assert.ok(sent.some((r) => r.method === 'PUT' && r.path === '/me/cv' && r.body.data === CV.data));
  assert.equal(box.cv.name, CV.name);
  assert.equal(box.workday, 'Xk7!mP2#qR9$');
  assert.equal(store.cv.data, CV.data);
  assert.equal(store.cvSavedAt, '2026-11-26T10:00:00Z');
  assert.equal(store.workday.password, 'Xk7!mP2#qR9$');
});

test('a token for another account gets none of what this browser saved', async () => {
  const { ctx, store, sent } = account('stranger');
  store.storageUser = 'u1';
  await ctx.syncStorage();
  assert.deepEqual(sent.filter((r) => r.method === 'PUT'), []);
  assert.equal(store.storageMode, 'account');
});
