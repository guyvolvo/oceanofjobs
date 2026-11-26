// A resume at a share link: lib/cvlink.js's download addresses, and
// background.js fetching, checking and keeping the file. fetch is
// answered by the test; nothing leaves the machine.
const test = require('node:test');
const assert = require('node:assert/strict');
const { worker, reply } = require('./worker.js');

const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
const DOCX = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.alloc(26), Buffer.from('word/document.xml')]);

// A download response: body bytes and headers.
const file = (body, headers = {}, status = 200) => {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return { status, ok: status >= 200 && status < 300, url: h['x-url'] || '', headers: { get: (k) => h[k.toLowerCase()] ?? null },
    arrayBuffer: async () => Uint8Array.from(body).buffer, json: async () => ({}) };
};

const link = worker(async () => reply(200)).ctx.oojCvLink;

test('Drive share links become direct downloads, with the redirect host to allow', () => {
  const want = 'https://drive.google.com/uc?export=download&id=1AbC_d-9';
  assert.equal(link.direct('https://drive.google.com/file/d/1AbC_d-9/view?usp=sharing'), want);
  assert.equal(link.direct('https://drive.google.com/open?id=1AbC_d-9'), want);
  assert.deepEqual([...link.origins('https://drive.google.com/file/d/1AbC_d-9/view')], ['https://drive.google.com/*', 'https://drive.usercontent.google.com/*']);
});

test('a Google Doc is exported as a PDF', () => {
  assert.equal(link.direct('https://docs.google.com/document/d/9xYz-1/edit?usp=sharing'), 'https://docs.google.com/document/d/9xYz-1/export?format=pdf');
  assert.ok(link.origins('https://docs.google.com/document/d/9xYz-1/edit').includes('https://*.googleusercontent.com/*'));
});

test('Dropbox dl=0 becomes dl=1 and keeps the rest of the link', () => {
  assert.equal(link.direct('https://www.dropbox.com/scl/fi/abc/CV.pdf?rlkey=k1&dl=0'), 'https://www.dropbox.com/scl/fi/abc/CV.pdf?rlkey=k1&dl=1');
  assert.equal(link.direct('https://dropbox.com/s/abc/CV.pdf'), 'https://dropbox.com/s/abc/CV.pdf?dl=1');
  assert.deepEqual([...link.origins('https://www.dropbox.com/s/abc/CV.pdf?dl=0')], ['https://www.dropbox.com/*', 'https://*.dropboxusercontent.com/*']);
});

test('any other https link is used as given; anything else is refused', () => {
  assert.equal(link.direct(' https://example.com/me/cv.pdf '), 'https://example.com/me/cv.pdf');
  assert.deepEqual([...link.origins('https://example.com/me/cv.pdf')], ['https://example.com/*']);
  assert.equal(link.direct('http://example.com/cv.pdf'), null);
  assert.equal(link.direct('not a link'), null);
  assert.deepEqual([...link.origins('http://example.com/cv.pdf')], []);
});

test('a PDF is accepted, named from Content-Disposition', async () => {
  let asked;
  const { ctx } = worker(async (url, init) => { asked = { url, init }; return file(PDF, { 'content-type': 'application/octet-stream', 'content-disposition': "attachment; filename=\"cv.pdf\"; filename*=UTF-8''Dana%20Levi%20CV.pdf" }); });
  const cv = await ctx.fetchCvLink('https://drive.google.com/file/d/abc/view');
  assert.equal(asked.url, 'https://drive.google.com/uc?export=download&id=abc');
  assert.equal(asked.init.credentials, 'omit');
  assert.equal(cv.name, 'Dana Levi CV.pdf');
  assert.equal(cv.type, 'application/pdf');
  assert.equal(cv.size, PDF.length);
  assert.equal(Buffer.from(cv.data, 'base64').toString('latin1'), PDF.toString('latin1'));
});

test('a DOCX with no name anywhere is called Resume.docx', async () => {
  const { ctx } = worker(async () => file(DOCX, { 'x-url': 'https://drive.usercontent.google.com/download?id=abc' }));
  const cv = await ctx.fetchCvLink('https://drive.google.com/file/d/abc/view');
  assert.equal(cv.name, 'Resume.docx');
  assert.equal(cv.type, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
});

test('an HTML page instead of the file says the link is not public', async () => {
  const { ctx } = worker(async () => file(Buffer.from('<!doctype html><title>Sign in - Google Accounts</title>'), { 'content-type': 'text/html; charset=utf-8' }));
  await assert.rejects(ctx.fetchCvLink('https://drive.google.com/file/d/abc/view'), { message: /isn't public/ });
});

test('a 403 says the link is not public', async () => {
  const { ctx } = worker(async () => file(Buffer.from(''), {}, 403));
  await assert.rejects(ctx.fetchCvLink('https://www.dropbox.com/s/abc/cv.pdf?dl=0'), { message: /isn't public/ });
});

test('a file that is neither PDF nor DOCX is refused', async () => {
  const { ctx } = worker(async () => file(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), { 'content-type': 'image/png' }));
  await assert.rejects(ctx.fetchCvLink('https://example.com/cv.png'), { message: "The file at this link isn't a PDF or DOCX." });
});

test('a file over 5 MB is refused, by its length header or its body', async () => {
  const big = Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)]);
  const byHeader = worker(async () => file(PDF, { 'content-length': big.length })).ctx;
  await assert.rejects(byHeader.fetchCvLink('https://example.com/cv.pdf'), { message: /larger than 5 MB/ });
  const byBody = worker(async () => file(big)).ctx;
  await assert.rejects(byBody.fetchCvLink('https://example.com/cv.pdf'), { message: /larger than 5 MB/ });
});

test('a link that cannot be reached says so', async () => {
  const { ctx } = worker(async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(ctx.fetchCvLink('https://example.com/cv.pdf'), { message: /Couldn't reach this link/ });
});

test('saving a link keeps the uploaded file aside, and Upload a file brings it back', async () => {
  const { ctx, store } = worker(async () => file(PDF, { 'content-disposition': 'attachment; filename="Linked.pdf"' }));
  const upload = { name: 'Uploaded.pdf', type: 'application/pdf', size: 3, data: 'AAAA' };
  Object.assign(store, { cv: upload, cvSavedAt: '2026-11-01T10:00:00.000Z' });
  const st = await ctx.saveCvLink('https://example.com/Linked.pdf');
  assert.equal(st.cv.name, 'Linked.pdf');
  assert.equal(store.cvLink.mode, 'link');
  assert.equal(store.cvUpload.cv.name, 'Uploaded.pdf');
  const back = await ctx.useCvFile();
  assert.equal(back.cv.name, 'Uploaded.pdf');
  assert.equal(store.cvSavedAt, '2026-11-01T10:00:00.000Z');
  assert.equal(store.cvLink.mode, 'file');
  assert.equal(store.cvLink.url, 'https://example.com/Linked.pdf');
  assert.equal(store.cvUpload, undefined);
});

test('a failed refresh keeps the last good copy and leaves the error for Settings', async () => {
  const { ctx, store } = worker(async () => file(Buffer.from('<html>Virus scan warning</html>'), { 'content-type': 'text/html' }));
  const good = { name: 'Linked.pdf', type: 'application/pdf', size: 3, data: 'AAAA' };
  const fetchedAt = new Date(Date.now() - 7 * 3600 * 1000).toISOString();
  Object.assign(store, { cv: good, cvLink: { url: 'https://example.com/cv.pdf', mode: 'link', fetchedAt, error: null } });
  await ctx.refreshCvLink();
  assert.equal(store.cv, good);
  assert.match(store.cvLink.error, /isn't public/);
  assert.equal(store.cvLink.fetchedAt, fetchedAt);
});

test('a fresh copy is not fetched again', async () => {
  let calls = 0;
  const { ctx, store } = worker(async () => { calls++; return file(PDF); });
  Object.assign(store, { cv: { data: 'AAAA' }, cvLink: { url: 'https://example.com/cv.pdf', mode: 'link', fetchedAt: new Date().toISOString(), error: null } });
  await ctx.refreshCvLink();
  assert.equal(calls, 0);
});

test('on the account, the link\'s file goes up once and the account\'s copy never replaces it', async () => {
  const puts = [];
  const { ctx, store } = worker(async (url, init = {}) => {
    if (url.endsWith('/me/cv') && init.method === 'PUT') { puts.push(JSON.parse(init.body)); return reply(200, { cv: { uploaded_at: '2026-11-26T09:00:00Z' } }); }
    if (url.endsWith('/me/storage')) return reply(200, { mode: 'account', ready: true, cv: { uploaded_at: '2026-11-20T09:00:00Z' } });
    if (url.endsWith('/me/storage/secrets')) return reply(200, {});
    if (url.endsWith('/me/cv')) throw new Error('the account copy must not come down');
    return file(PDF, { 'content-disposition': 'attachment; filename="Linked.pdf"' });
  });
  Object.assign(store, { token: 'ooj_live', storageMode: 'account' });
  await ctx.saveCvLink('https://example.com/Linked.pdf');
  assert.equal(puts.length, 1);
  assert.equal(puts[0].name, 'Linked.pdf');
  await ctx.syncStorage();
  assert.equal(store.cv.name, 'Linked.pdf');
  // The same file six hours later is not sent again.
  store.cvLink.fetchedAt = new Date(Date.now() - 7 * 3600 * 1000).toISOString();
  await ctx.refreshCvLink();
  assert.equal(puts.length, 1);
  assert.equal(store.cvLink.error, null);
});
