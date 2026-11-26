// Credit reports in the service worker: what the outbox keeps, storage
// writes that race, the job a tab shows, the server's AI falling back to
// the own key, and API timeouts. fetch is answered by the test.
const test = require('node:test');
const assert = require('node:assert/strict');
const { worker, reply } = require('./worker.js');

test('a settle answered by a one-off 401 or a Cloudflare 403 page stays in the outbox', async () => {
  for (const status of [401, 403]) {
    const { ctx, store } = worker(async () => reply(status, null));
    store.token = 'ooj_x';
    await ctx.settle('att-000001', 'submitted');
    assert.equal(store.outbox.length, 1, `HTTP ${status}`);
  }
});

test("a settle the server refuses with its own code leaves the outbox", async () => {
  const { ctx, store } = worker(async () => reply(409, { code: 'conflict', error: 'no', retryable: false }));
  store.token = 'ooj_x';
  await ctx.settle('att-000001', 'submitted');
  assert.equal(store.outbox.length, 0);
});

test('a reservation the server refuses is still a refusal', async () => {
  const { ctx, store } = worker(async () => reply(409, { code: 'job_taken', error: 'taken' }));
  store.token = 'ooj_x';
  const r = await ctx.reserve({ id: '0123456789abcdef', url: 'https://acme.example/job/1' });
  assert.equal(r.taken, true);
  assert.equal(Object.keys(store.inflight).length, 0);
});

test('two settles at once both reach the outbox and both leave inflight', async () => {
  const { ctx, store } = worker(async () => reply(503));
  store.token = 'ooj_x';
  await Promise.all([ctx.track('att-a', 'started'), ctx.track('att-b', 'started')]);
  assert.deepEqual(Object.keys(store.inflight).sort(), ['att-a', 'att-b']);
  await Promise.all([ctx.settle('att-a', 'submitted'), ctx.settle('att-b', 'failed', 'form errors')]);
  assert.deepEqual([...store.outbox].map((i) => i.path).sort(), ['/me/apply/attempts/att-a/settle', '/me/apply/attempts/att-b/settle']);
  assert.deepEqual(Object.keys(store.inflight), []);
});

test("Apply to next's job id follows the job's pages, not every page on its host", async () => {
  const { ctx } = worker(async () => reply(200, {}));
  ctx.pageCompany = async () => '';
  ctx.pageJobId = async () => 'cccccccccccccccc'; // the page-address hash
  const job = 'https://acme.wd1.myworkdayjobs.com/careers/job/Remote/Engineer_R1';
  await ctx.chrome.storage.session.set({ 'tabjob:7': { id: 'aaaaaaaaaaaaaaaa', url: job } });
  const form = await ctx.jobForTab(7, job + '/apply/autofillWithResume');
  assert.equal(form.id, 'aaaaaaaaaaaaaaaa');
  assert.equal(form.board, true);
  const other = await ctx.jobForTab(7, 'https://acme.wd1.myworkdayjobs.com/careers/job/Remote/Designer_R2/apply');
  assert.notEqual(other.id, 'aaaaaaaaaaaaaaaa');
  assert.equal(other.board, false);
  await ctx.chrome.storage.session.set({ 'tabjob:8': { id: 'bbbbbbbbbbbbbbbb', url: 'https://boards.greenhouse.io/embed/job_app?for=acme&token=1' } });
  assert.notEqual((await ctx.jobForTab(8, 'https://boards.greenhouse.io/embed/job_app?for=acme&token=2')).id, 'bbbbbbbbbbbbbbbb');
});

// A worker whose /me/apply/draft answers status, with the own key stubbed.
function drafting(status) {
  const { ctx, store } = worker(async (url) => reply(url.endsWith('/me/apply/draft') ? status : 200, {}));
  store.token = 'ooj_x';
  const own = [];
  ctx.draftAnswer = async (field) => { own.push(field.label); return 'My own answer'; };
  const c = { profile: {}, preferences: {}, settings: { fill: 'half' }, ai: { key: 'k' }, serverAi: true };
  return { ctx, own, c };
}

test('a server AI error other than used-up leaves the question unanswered, own key unused', async () => {
  for (const status of [503, 500, 403]) {
    const { ctx, own, c } = drafting(status);
    assert.equal(await ctx.answerUnknown({ label: 'Why us?', type: 'text' }, { id: 'j1' }, c), undefined);
    assert.equal(await ctx.suggestAnswer({ label: 'Why us?', type: 'text' }, { id: 'j1' }, c), undefined);
    assert.equal(c.serverAi, true);
    assert.deepEqual(own, []);
  }
});

test("the plan's AI answers used up (402) moves to the own key", async () => {
  const { ctx, own, c } = drafting(402);
  assert.equal(await ctx.answerUnknown({ label: 'Why us?', type: 'text' }, { id: 'j1' }, c), 'My own answer');
  assert.equal(c.serverAi, false);
  assert.deepEqual(own, ['Why us?']);
});

test('"Use my key first": the server is asked without its model, then the own key answers', async () => {
  const bodies = [];
  const { ctx, store } = worker(async (url, init) => {
    if (!url.endsWith('/me/apply/draft')) return reply(200, {});
    const body = JSON.parse(init.body);
    bodies.push(body);
    // A saved answer still comes from the server; anything else is left to the key.
    return reply(200, body.question === 'Notice period?' ? { answer: '30 days', source: 'saved' } : { answer: null, source: 'own_key' });
  });
  store.token = 'ooj_x';
  const own = [];
  ctx.draftAnswer = async (field) => { own.push(field.label); return 'My own answer'; };
  const c = { profile: {}, preferences: {}, settings: { fill: 'half' }, ai: { key: 'k', first: true }, serverAi: true };
  assert.equal(await ctx.answerUnknown({ label: 'Why us?', type: 'text' }, { id: 'j1' }, c), 'My own answer');
  assert.equal(c.wroteIt, true);
  assert.equal(await ctx.suggestAnswer({ label: 'Why us?', type: 'text' }, { id: 'j1' }, c), 'My own answer');
  assert.equal(await ctx.answerUnknown({ label: 'Notice period?', type: 'text' }, { id: 'j1' }, c), '30 days');
  assert.deepEqual(own, ['Why us?', 'Why us?']);
  assert.ok(bodies.every((b) => b.own_key === true));
  assert.equal(c.serverAi, true, 'the server stays in use for the free answers');
  // Full automatic never uses the own key, so it asks the server's model.
  bodies.length = 0;
  const full = { ...c, settings: { fill: 'full' } };
  await ctx.answerUnknown({ label: 'Why us?', type: 'text' }, { id: 'j1' }, full);
  assert.equal(bodies[0].own_key, undefined);
  assert.deepEqual(own, ['Why us?', 'Why us?']);
});

test('an API call that hangs times out with no status, so attempt calls count it as transient', async () => {
  const hang = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason)));
  const { ctx, store } = worker(hang);
  store.token = 'ooj_x';
  const e = await ctx.api('/me/apply/summary', { timeout: 20 }).catch((x) => x);
  assert.equal(e.name, 'TimeoutError');
  assert.equal(e.status, undefined);
  const realApi = ctx.api;
  ctx.api = (path, o) => realApi(path, { ...o, timeout: 20 });
  assert.equal((await ctx.attemptCall('/me/apply/attempts', {}, 1)).transient, true);
});
