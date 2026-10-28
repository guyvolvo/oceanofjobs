importScripts('lib/providers.js', 'lib/match.js', 'ats/greenhouse.js', 'ats/ashby.js', 'ats/workable.js', 'ats/generic.js', 'ats/workday.js');

const API = 'https://oceanofjobs.com/api';
// One job at a time, so a full run is a few minutes; the plan and the
// user's own daily limit still cap the day.
const PER_RUN = 20;
const RUN_MINUTES = 15;
// Dedicated fillers first; generic is the fallback for every other page.
const ATS_FILES = {
  greenhouse: ['lib/match.js', 'ats/greenhouse.js'],
  ashby: ['lib/match.js', 'ats/ashby.js'],
  workable: ['lib/match.js', 'ats/workable.js'],
  generic: ['lib/match.js', 'ats/generic.js'],
  // Gets into the form and signs in; generic.js reads and fills its pages.
  workday: ['lib/match.js', 'ats/generic.js', 'ats/workday.js'],
};

// The filler that reads and fills url. Workday's file only gets into its
// forms, so on Workday it is the general one.
function adapterFor(url) {
  return Object.keys(ATS_FILES).find((n) => n !== 'generic' && globalThis.oojAts[n].read && globalThis.oojAts[n].onSite(url)) || 'generic';
}

class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (auth) {
    const { token } = await chrome.storage.local.get('token');
    if (!token) throw new HttpError(401, null);
    headers.Authorization = `Bearer ${token}`;
  }
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(API + path, { method, headers, body: body && JSON.stringify(body) });
  if (res.status === 401 && auth) await chrome.storage.local.set({ authError: true });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new HttpError(res.status, data);
  return data;
}

// A job skipped before any attempt starts (closed, unsupported, already
// applied): kept as a free record so a run doesn't pick it again. The
// history shows the reason as written here; the codes stay in the extension.
const report = (job_id, status, reason) =>
  api('/me/apply/result', { method: 'POST', body: { job_id, status, reason: oojMatch.reasonText(reason) } }).catch(() => {});

// Application attempts (api/AUTO_APPLY_CONTRACT.md). One id per attempt,
// made before the first call and reused for every retry of the same call,
// so a lost response can never reserve, charge or refund twice. A retry
// after a network error repeats the API call, never the submission.
const newAttemptId = () => crypto.randomUUID().replace(/-/g, '');
const SERVER_GONE = "Couldn't connect to Ocean of Jobs, so nothing was submitted. Try again in a minute.";

// One attempt call: {data} on success, {refused: code, error} when the
// server said no (final), {transient: true} when it couldn't be reached or
// failed (the same call may be repeated).
async function attemptCall(path, body, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      return { data: await api(path, { method: 'POST', body }) };
    } catch (e) {
      if (e.status && e.status < 500 && e.status !== 429) {
        return { refused: (e.body && e.body.code) || String(e.status), status: e.status, error: e.body && e.body.error,
          questions: (e.body && e.body.questions) || [] };
      }
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 1000 * 3 ** i));
  }
  return { transient: true };
}

// Reports that must reach the server: settlements and Filled entries.
// Kept in storage until the server acknowledges them, so they survive the
// popup closing, the browser restarting and the network dropping.
async function sendDurable(path, body) {
  const { outbox = [] } = await chrome.storage.local.get('outbox');
  outbox.push({ path, body, at: new Date().toISOString() });
  await chrome.storage.local.set({ outbox });
  await flushOutbox();
}

let flushing = false;
async function flushOutbox() {
  if (flushing) return;
  flushing = true;
  try {
    const { outbox = [] } = await chrome.storage.local.get('outbox');
    const left = [];
    for (const item of outbox) {
      const r = await attemptCall(item.path, item.body, 1);
      // Acknowledged, or refused for good (already settled, expired, no such
      // attempt): either way, sending it again can't change anything.
      if (r.transient) left.push(item);
    }
    // Reports added while this ran are kept too.
    const { outbox: now = [] } = await chrome.storage.local.get('outbox');
    const sent = new Set(outbox.filter((i) => !left.includes(i)).map((i) => JSON.stringify(i)));
    const keep = now.filter((i) => !sent.has(JSON.stringify(i)));
    await chrome.storage.local.set({ outbox: keep });
    if (keep.length) chrome.alarms.create('outbox', { delayInMinutes: 1 });
  } finally {
    flushing = false;
  }
}

// Attempts this browser has started and not yet reported, so a crash or
// restart can be reported on the next start: past the Submit gate it is
// Submission unconfirmed (the click may have happened), before it a release.
async function track(attemptId, phase) {
  const { inflight = {} } = await chrome.storage.local.get('inflight');
  if (phase) inflight[attemptId] = { phase, at: new Date().toISOString() };
  else delete inflight[attemptId];
  await chrome.storage.local.set({ inflight });
}

async function settle(attemptId, outcome, reason = '', questions) {
  await track(attemptId, null);
  const body = { outcome, reason: oojMatch.reasonText(reason) };
  if (questions) body.questions = questions;
  await sendDurable(`/me/apply/attempts/${attemptId}/settle`, body);
}

async function recoverInflight() {
  const { inflight = {} } = await chrome.storage.local.get('inflight');
  for (const [id, { phase }] of Object.entries(inflight)) {
    if (phase === 'started') await settle(id, 'unconfirmed', 'The browser closed while the application was being submitted.');
    else await settle(id, 'failed', 'The browser closed before the application was submitted.');
  }
  await flushOutbox();
}

// Reserve a credit for one job. {attemptId} or {error, limit, taken}.
async function reserve(job) {
  const attemptId = newAttemptId();
  await track(attemptId, 'reserved');
  const r = await attemptCall('/me/apply/attempts', {
    attempt_id: attemptId, job_id: job.id, url: job.url, title: job.title, company: job.company_name || job.company_domain,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  if (r.data) return { attemptId };
  await track(attemptId, null);
  // Reserved but the answer was lost: release it rather than wait 30 minutes.
  if (r.transient) await sendDurable(`/me/apply/attempts/${attemptId}/settle`, { outcome: 'failed', reason: SERVER_GONE });
  return { error: r.error || SERVER_GONE, limit: r.refused === 'limit_reached', taken: r.refused === 'job_taken' };
}

// The Submit gate: true only when the server acknowledged submission start.
// Anything else (expired, refused, unreachable) means don't click. An
// automatic run sends the answers it filled ({answers, mode: 'auto'}): the
// server holds back AI answers the user hasn't approved (needs_review,
// {review: questions}; the caller pauses the job) and keeps a copy of what
// was sent. The card sends mode 'card' when the user pressed Submit
// themselves, 'auto' when Full automatic pressed it (cardGate).
async function gate(attemptId, sent = {}) {
  const r = await attemptCall(`/me/apply/attempts/${attemptId}/submission-started`, sent);
  if (r.data && r.data.submit === true) {
    await track(attemptId, 'started');
    return { ok: true };
  }
  if (r.refused === 'needs_review') return { review: r.questions.length ? r.questions : ['an AI answer'] };
  if (r.refused === 'expired') {
    await track(attemptId, null);
    return { error: "This application took too long to prepare, so it wasn't submitted. Try again." };
  }
  await settle(attemptId, 'failed', r.transient ? SERVER_GONE : (r.error || 'Not submitted.'));
  return { error: r.transient ? SERVER_GONE : (r.error || 'Not submitted.') };
}

// After the click: the site's own validation errors (or a CAPTCHA it put
// up) mean nothing was sent; any other uncertainty is Submission
// unconfirmed, never Submitted.
function afterClick(result) {
  if (result === 'submitted') return ['submitted', ''];
  const why = (result && result.failed) || '';
  if (/^(form errors|captcha|ashby will not take|submit button not found)/i.test(why)) return ['failed', why];
  return ['unconfirmed', why || 'no confirmation after submitting'];
}

function setBadge(n) {
  chrome.action.setBadgeText({ text: n ? String(n) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#40513b' });
}

async function draftAnswer(field, profile, preferences, job, ai) {
  const c = profile.contact || {};
  // Never who the applicant is (name, email, phone): no answer needs it.
  const facts = {
    location: c.location,
    links: profile.links, work: profile.work, skills: preferences.skills, seniority: preferences.seniority,
    saved_answers: (profile.answers || []).slice(0, 30),
  };
  const prompt = [
    `You are filling in a job application for the candidate below. Job: "${job.title}" at ${job.company_name || job.company_domain}.`,
    `Candidate facts (JSON): ${JSON.stringify(facts)}`,
    `Question: ${field.label}`,
    field.options && field.options.length
      ? `Reply with exactly one of these options and nothing else: ${field.options.map((o) => JSON.stringify(o)).join(', ')}`
      : 'Reply with the answer only, in the first person, at most 80 words.',
    'Use only the facts above. If they do not answer the question truthfully, reply UNKNOWN.',
  ].join('\n\n');
  let text;
  const provider = oojProviders[ai.provider];
  if (!provider) return undefined;
  if (ai.provider === 'anthropic') {
    const res = await fetch(provider.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'x-api-key': ai.key, 'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model: ai.model, max_tokens: 4000, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await res.json();
    if (!res.ok || data.stop_reason === 'refusal') return undefined;
    text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  } else {
    const res = await fetch(provider.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${ai.key}` },
      body: JSON.stringify({ model: ai.model, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await res.json();
    if (!res.ok) return undefined;
    text = data.choices && data.choices[0] && data.choices[0].message.content;
  }
  text = String(text || '').trim();
  return !text || /^unknown\b/i.test(text) ? undefined : text;
}

const fits = (field, answer) =>
  answer != null && !(field.options && field.options.length && oojMatch.pickOption(field.options, answer) < 0);

// /me/apply/draft, waiting out one rate limit (20 a minute) rather than
// giving up on the server's AI for the rest of the run.
async function draft(body) {
  try {
    return await api('/me/apply/draft', { method: 'POST', body });
  } catch (e) {
    const wait = e.status === 429 && e.body && e.body.retry_after;
    if (!wait || wait > 90) throw e;
    // In 10-second steps, each with an extension call: an idle worker is stopped after 30.
    for (let left = wait; left > 0; left -= 10) {
      await new Promise((res) => setTimeout(res, Math.min(left, 10) * 1000));
      await chrome.runtime.getPlatformInfo();
    }
    return api('/me/apply/draft', { method: 'POST', body });
  }
}

// A required question with no saved answer. Our server drafts (and saves)
// it on every plan; a plan out of AI answers falls back to the user's own
// key. undefined means skip the job. ctx.wroteIt says
// whether the AI wrote this answer just now, for the Submit gate.
async function answerUnknown(field, job, ctx) {
  ctx.wroteIt = false;
  if (ctx.serverAi) {
    try {
      const { answer, source } = await draft(
        { question: field.label, options: field.options || [], job: { id: job.id, title: job.title, company: job.company_name || job.company_domain } });
      ctx.wroteIt = source === 'ai';
      return fits(field, answer) ? answer : undefined;
    } catch (e) {
      // 422: the profile cannot answer this, and a second model would only guess.
      if (e.status === 422) return undefined;
      // 402 (no plan or used up) and 503 (not set up) hold for the rest of the run.
      ctx.serverAi = false;
    }
  }
  if (!ctx.ai || !ctx.ai.key) return undefined;
  const answer = await draftAnswer(field, ctx.profile, ctx.preferences, job, ctx.ai).catch(() => undefined);
  if (!fits(field, answer)) return undefined;
  ctx.wroteIt = true;
  await api('/me/apply/answers', { method: 'POST', body: { question: field.label, answer, job_id: job.id, source: 'ai' } }).catch(() => {});
  return answer;
}

function waitForLoad(tabId, ms = 30000) {
  return new Promise((resolve) => {
    const done = (ok) => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listen); resolve(ok); };
    const listen = (id, info) => { if (id === tabId && info.status === 'complete') done(true); };
    const timer = setTimeout(() => done(false), ms);
    chrome.tabs.onUpdated.addListener(listen);
    chrome.tabs.get(tabId).then((t) => t.status === 'complete' && done(true), () => done(false));
  });
}

// Runs one method of the ATS filler inside the tab. The files go in again
// each time because a full navigation (the confirmation page) drops them.
async function inTab(tabId, ats, method, args = [], frameId) {
  const target = frameId ? { tabId, frameIds: [frameId] } : { tabId };
  await chrome.scripting.executeScript({ target, files: ATS_FILES[ats] });
  const [res] = await chrome.scripting.executeScript({
    target,
    func: (a, m, xs) => globalThis.oojAts[a][m](...xs),
    args: [ats, method, args],
  });
  return res && res.result;
}

async function waitForOutcome(tabId, atsName, redirectTo) {
  const ats = globalThis.oojAts[atsName];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return { failed: 'tab closed' };
    if (redirectTo && tab.url && tab.url.startsWith(redirectTo)) return 'submitted';
    if (tab.status !== 'complete' || !ats.onSite(tab.url)) continue;
    const r = await inTab(tabId, atsName, 'outcome').catch(() => null);
    if (r) return r;
  }
  return { failed: 'no confirmation after submitting' };
}

// What a run fills from the profile, and the AI's answers to required
// questions nothing answered when the user lets it draft them. The labels
// it drafted go in drafted, for the Submit gate.
// Required boxes and agreements, answered so the form can be sent, in runs
// and in Fill application (oojMatch.mustAnswer).
function answerRequired(plan) {
  for (const f of [...plan.missing]) {
    const value = oojMatch.mustAnswer(f);
    if (value === undefined) continue;
    plan.missing.splice(plan.missing.indexOf(f), 1);
    plan.fills.push({ ...f, value });
  }
}

async function planRun(fields, job, ctx, drafted) {
  const plan = oojMatch.planFill(fields, ctx.profile, job);
  answerRequired(plan);
  if (!plan.missing.length || ctx.settings.unknowns !== 'ai') return plan;
  for (const f of [...plan.missing]) {
    if (f.type === 'file' || oojMatch.isEeo(f)) continue;
    const answer = await answerUnknown(f, job, ctx);
    if (answer === undefined) continue;
    ctx.profile.answers = [...(ctx.profile.answers || []), { question: f.label, answer, ...(ctx.wroteIt ? { source: 'ai', approval: 'pending' } : {}) }];
    plan.missing.splice(plan.missing.indexOf(f), 1);
    plan.fills.push({ ...f, value: answer });
    if (ctx.wroteIt) drafted.add(f.label);
  }
  return plan;
}

// Every answered question, as filled; the server decides which are the
// AI's from the saved answers, and only says no to those.
const sentAnswers = (fills, job, drafted) => fills.filter((f) => f.type !== 'file' && !oojMatch.isEeo(f) && f.label).slice(0, 50)
  .map((f) => ({ question: f.label, answer: String(f.value), job_id: job.id, ...(drafted.has(f.label) ? { source: 'ai' } : {}) }));

// Sites a run applies to with the general filler, each checked on live
// postings with tests/e2e/_ext_coverage.mjs before it goes in here.
// Workday goes the same way once ats/workday.js has signed in.
const GENERAL_ATS = new Set(['workday', 'smartrecruiters', 'bamboohr', 'jazzhr', 'recruitee', 'lever', 'teamtailor', 'pinpoint',
  'breezy', 'personio', 'comeet']);
const dedicatedRun = (job) => !!(globalThis.oojAts[job.ats] && globalThis.oojAts[job.ats].read && globalThis.oojAts[job.ats].matches(job.url));
const generalRun = (job) => GENERAL_ATS.has(job.ats) && !dedicatedRun(job);
// Whether a run can apply to job at all.
const canRun = (job) => dedicatedRun(job) || generalRun(job);

// Into a Workday application: Apply, then Autofill with Resume (or Apply
// Manually), then signed in with the profile's email and the Workday password from the extension's
// options, or a new account made with them. null once on the form's first
// page, else the reason it stopped.
async function intoWorkday(tabId, ctx, job) {
  const enter = async () => {
    // The Apply buttons may load a new page, which ends the script unanswered.
    for (let i = 0; i < 4; i++) {
      const r = await inTab(tabId, 'workday', 'enter').catch(() => null);
      if (r) return r;
      await waitForLoad(tabId);
    }
    return { error: 'application form not found' };
  };
  let r = await enter();
  if (r.error) return r.error;
  if (r.at === 'form') return null;
  const email = (ctx.profile.contact || {}).email;
  if (!email) return 'no email in the profile';
  let { workday } = await chrome.storage.local.get('workday');
  if (!workday || !workday.password) {
    // None set: one made here and saved like a typed one, so Settings shows
    // it and every Workday site after this one gets the same.
    await saveSecrets({ workday: globalThis.oojAts.workday.newPassword() }).catch(() => null);
    ({ workday } = await chrome.storage.local.get('workday'));
    if (!workday || !workday.password) return 'no Workday password';
  }
  let signed = await inTab(tabId, 'workday', 'account', [email, workday.password]).catch(() => null);
  // A new account sends some sites to their own sign-in page; the redirect
  // can land a moment after the page reports loaded.
  await new Promise((res) => setTimeout(res, 2000));
  await waitForLoad(tabId);
  if (/\/login\b/.test((await chrome.tabs.get(tabId)).url)) {
    signed = await inTab(tabId, 'workday', 'signInPage', [email, workday.password]).catch(() => null);
    // An account just made that can't sign in yet: Workday wants its email
    // confirmed first ("wrong email or password" until then, on NVIDIA's).
    if (signed && signed.failed) return 'Workday account to verify';
    if (signed === 'in' || signed === null) {
      await chrome.tabs.update(tabId, { url: job.url });
      await new Promise((res) => setTimeout(res, 1000));
      await waitForLoad(tabId);
    }
  }
  if (signed && signed.verify) return 'Workday account to verify';
  if (signed && signed.failed) return signed.failed;
  r = await enter();
  return r.at === 'form' ? null : r.error || 'Workday sign-in: no answer';
}

// A fill the user starts on a Workday posting or its sign-in step takes
// the run's way in, so the general reader lands on the form's first page.
// null once there (or off Workday), else the reason it stopped.
async function workdayFirst(tabId, url) {
  if (!globalThis.oojAts.workday.matches(url)) return null;
  let a;
  try {
    a = await account();
  } catch (e) {
    return e.status === 401 ? EXPIRED : UNREACHABLE;
  }
  return intoWorkday(tabId, { profile: a.profile }, { url });
}

// The general filler's run on a tab that shows job.url: the form found the
// way "Fill application" finds it (an Apply link followed, a form frame
// entered), a wizard filled page by page through its Next buttons, then
// the gate and the click. Counted as Submitted only when the site says so
// (outcome's strict mode). Returns [outcome, why, questions, at]; outcome
// null means the gate refused and settled it already. state.clicked is set
// once past the gate.
async function viaGeneral(job, ctx, id, tabId, state) {
  const workday = job.ats === 'workday';
  if (workday) {
    const stop = await intoWorkday(tabId, ctx, job);
    if (stop) return ['failed', stop];
  }
  let frameId = 0, page = null;
  for (let hop = 0; hop < 3; hop++) {
    page = await readForm(tabId, 'generic', frameId).catch(() => null);
    if (page && page.frame) {
      const f = await frameWithForm(tabId, 10000);
      if (!f || f.frameId === 0) return ['failed', READ_ERROR];
      frameId = f.frameId;
      continue;
    }
    if (!page || !page.openUrl) break;
    await chrome.tabs.update(tabId, { url: page.openUrl });
    await new Promise((r) => setTimeout(r, 1000));
    await waitForLoad(tabId);
    frameId = 0;
  }
  if (!page || page.openUrl || page.frame) return ['failed', READ_ERROR];
  const wall = await inTab(tabId, 'generic', 'wall', [], frameId).catch(() => null);
  if (wall && wall.signIn) return ['failed', 'sign in first'];
  if (page.error) return ['failed', page.error];
  const drafted = new Set();
  const fills = [];
  // A wizard: each page filled, then its Next pressed, until a page has
  // the button that sends the form.
  for (let step = 0; ; step++) {
    const plan = await planRun(page.fields, job, ctx, drafted);
    if (plan.missing.length) {
      const questions = plan.missing.map((f) => f.label);
      return ['needs_input', 'needs answer: ' + questions.join('; '), questions];
    }
    const filled = await inTab(tabId, 'generic', 'fill', [plan.fills, ctx.cv], frameId);
    // An optional question it couldn't answer is left as it is; a required one stops the run.
    const hard = filled ? filled.errors.filter((e) => plan.fills.some((f) => f.required && e.startsWith(f.label + ':'))) : ['the form'];
    if (hard.length) return ['failed', 'could not fill ' + hard.join('; ')];
    fills.push(...plan.fills.filter((f) => !filled.errors.some((e) => e.startsWith(f.label + ':'))));
    const info = await inTab(tabId, 'generic', 'submitInfo', [], frameId);
    // A CAPTCHA or an invisible human check: the extension never gets round
    // one. Everything is answered, so the job waits in Needs attention for
    // the user to open and send, and the credit goes back.
    if (info && info.botCheck || await inTab(tabId, 'generic', 'wall', [], frameId).then((w) => w && w.captcha, () => false)) {
      return ['needs_input', 'ready to submit', []];
    }
    if (info && info.text) break;
    if (step >= 8) return ['failed', 'submit button not found'];
    const before = await inTab(tabId, 'generic', 'next', [], frameId);
    if (!before) return ['failed', 'submit button not found'];
    const moved = await inTab(tabId, 'generic', 'nextOutcome', [before], frameId).catch(() => null);
    if (moved && moved.failed) return ['failed', moved.failed];
    await waitForLoad(tabId);
    page = await readForm(tabId, 'generic', frameId).catch(() => null);
    if (!page || page.error || page.openUrl || page.frame) return ['failed', READ_ERROR];
  }
  const ok = await gate(id, { answers: sentAnswers(fills, job, drafted), mode: 'auto' });
  if (ok.review) return ['needs_input', 'check AI answers: ' + ok.review.join('; '), ok.review];
  if (!ok.ok) return [null];
  state.clicked = true;
  const before = await inTab(tabId, 'generic', 'submit', [], frameId);
  if (!before) return ['failed', 'submit button not found'];
  const until = Date.now() + 30000;
  let out = null;
  while (!out && Date.now() < until) {
    out = await (workday ? inTab(tabId, 'workday', 'outcome', [before, until - Date.now()])
      : inTab(tabId, 'generic', 'outcome', [before, until - Date.now(), true], frameId)).catch(() => null);
    if (!out) await new Promise((r) => setTimeout(r, 1000));
  }
  return afterClick(out);
}

// One job, start to finish: 'submitted', 'skipped', 'failed', 'captcha'
// or 'limit' (the plan has no credits left, nothing was claimed).
async function applyTo(job, ctx) {
  const ats = globalThis.oojAts[job.ats];
  const general = generalRun(job);
  if (!canRun(job)) {
    await report(job.id, 'skipped', 'unsupported site');
    return 'skipped';
  }
  // Reserve before opening the form (contract R1). Every way out below
  // settles the attempt; before the gate that always releases the credit.
  const held = await reserve(job);
  if (held.limit) return 'limit';
  if (held.taken) {
    await report(job.id, 'skipped', 'already applied');
    return 'skipped';
  }
  if (!held.attemptId) return 'failed';
  const id = held.attemptId;
  let clicked = false;
  const state = { clicked: false };
  const tab = await chrome.tabs.create({ url: !general && ats.formUrl ? ats.formUrl(job.url) : job.url, active: false });
  try {
    if (!(await waitForLoad(tab.id))) {
      await settle(id, 'failed', 'page did not load');
      return 'failed';
    }
    if (general) {
      const [outcome, why, questions] = await viaGeneral(job, ctx, id, tab.id, state);
      clicked = state.clicked;
      if (!outcome) return 'failed';
      await settle(id, outcome, why, questions);
      return outcome === 'needs_input' ? 'skipped' : outcome;
    }
    const [main] = ats.pageData
      ? await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: ats.pageData })
      : [];
    const page = await inTab(tab.id, job.ats, 'read', [main ? main.result : null]);
    if (!page || page.error) {
      await settle(id, 'failed', (page && page.error) || 'application form not found');
      return 'failed';
    }
    const drafted = new Set();
    const plan = await planRun(page.fields, job, ctx, drafted);
    if (plan.missing.length) {
      // Paused until the user answers (R15): the job stays out of runs and
      // shows in Needs attention with its questions.
      const questions = plan.missing.map((f) => f.label);
      await settle(id, 'needs_input', 'needs answer: ' + questions.join('; '), questions);
      return 'skipped';
    }
    const filled = await inTab(tab.id, job.ats, 'fill', [plan.fills, ctx.cv]);
    if (!filled || filled.errors.length) {
      await settle(id, 'failed', 'could not fill ' + ((filled && filled.errors.join('; ')) || 'the form'));
      return 'failed';
    }
    const ok = await gate(id, { answers: sentAnswers(plan.fills, job, drafted), mode: 'auto' });
    if (ok.review) {
      // Paused for the user to check the AI's answers (Needs attention);
      // nothing was clicked, and the credit goes back.
      await settle(id, 'needs_input', 'check AI answers: ' + ok.review.join('; '), ok.review);
      return 'skipped';
    }
    if (!ok.ok) return 'failed';
    clicked = true;
    if (!(await inTab(tab.id, job.ats, 'submit'))) {
      // The gate passed but no button was pressed: nothing was sent.
      await settle(id, 'failed', 'submit button not found');
      return 'failed';
    }
    const [outcome, why] = afterClick(await waitForOutcome(tab.id, job.ats, page.redirectTo));
    await settle(id, outcome, why);
    if (outcome === 'failed' && /^captcha/i.test(why)) return 'captcha';
    return outcome;
  } catch (e) {
    // After the gate the click may have happened: unconfirmed, never retried.
    clicked = clicked || state.clicked;
    await settle(id, clicked ? 'unconfirmed' : 'failed', String(e.message || e).slice(0, 200));
    return clicked ? 'unconfirmed' : 'failed';
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function fetchJob(id) {
  try {
    return await api(`/jobs/${encodeURIComponent(id)}`, { auth: false });
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function autoCandidates(preferences) {
  // Sites with a filler of their own, and those the general one applies on.
  const dedicated = Object.keys(ATS_FILES).filter((n) => n !== 'generic' && globalThis.oojAts[n].read);
  const p = new URLSearchParams({ ats: [...dedicated, ...GENERAL_ATS].join(','), limit: '25', max_age_days: '14', count: 'skip' });
  if (preferences.skills && preferences.skills.length) p.set('skills', preferences.skills.join(','));
  if (preferences.seniority) p.set('seniority', preferences.seniority);
  if (preferences.workplace && preferences.workplace.length) p.set('workplace', preferences.workplace.join(','));
  if (preferences.country && preferences.country.length) p.set('country', preferences.country.join(','));
  if (preferences.city && preferences.city.length) p.set('city', preferences.city.join(','));
  const { jobs = [] } = await api('/jobs?' + p, { auth: false });
  return jobs.filter(canRun);
}

let running = false;

// Where the CV, the Workday password and the own AI key live: in this
// browser (chrome.storage.local), or on the account (api/user_files.py)
// when the member chose "Save my settings to: Account". Everything that
// uses them keeps reading chrome.storage.local; with the account chosen
// that is a copy, refreshed from the account here (syncStorage), and
// every change made in Settings goes to both.
async function storageState() {
  const local = await chrome.storage.local.get(['token', 'authError', 'cv', 'cvSavedAt', 'workday', 'ai', 'storageMode']);
  let view = null;
  if (local.token && !local.authError) view = await api('/me/storage').catch((e) => ({ error: e.status || 0 }));
  return {
    connected: !!local.token && !local.authError,
    mode: view && !view.error ? view.mode : local.storageMode || 'local',
    ready: !!(view && view.ready),
    cv: local.cv ? { name: local.cv.name, type: local.cv.type, size: local.cv.size, savedAt: local.cvSavedAt || null } : null,
    workday: !!(local.workday && local.workday.password),
    ai: local.ai ? { provider: local.ai.provider, model: local.ai.model || '' } : null,
  };
}

async function syncStorage() {
  const view = await api('/me/storage');
  const { storageMode: before } = await chrome.storage.local.get('storageMode');
  await chrome.storage.local.set({ storageMode: view.mode });
  if (view.mode !== 'account') return view;
  if (before !== 'account') {
    // Chosen elsewhere (a CV uploaded on the website, another computer):
    // what this browser kept goes up before the account's copy comes down,
    // so nothing saved here is lost.
    const local = await chrome.storage.local.get(['workday', 'ai']);
    const up = {};
    if (!view.workday && local.workday && local.workday.password) up.workday = local.workday.password;
    if (!view.ai && local.ai && local.ai.key) up.ai = local.ai;
    if (Object.keys(up).length) await api('/me/storage/secrets', { method: 'PUT', body: up });
  }
  const local = await chrome.storage.local.get(['cv', 'cvSavedAt']);
  if (!view.cv) {
    if (local.cv) await chrome.storage.local.remove(['cv', 'cvSavedAt']);
  } else if (!local.cv || local.cvSavedAt !== view.cv.uploaded_at) {
    const file = await api('/me/cv');
    await chrome.storage.local.set({ cv: { name: file.name, type: file.type, size: file.size, data: file.data }, cvSavedAt: file.uploaded_at });
  }
  const secrets = await api('/me/storage/secrets');
  if (secrets.workday) await chrome.storage.local.set({ workday: { password: secrets.workday } });
  else await chrome.storage.local.remove('workday');
  if (secrets.ai) await chrome.storage.local.set({ ai: secrets.ai });
  else await chrome.storage.local.remove('ai');
  return view;
}

// To the account: the member ticked the privacy box. What this browser
// holds goes up, then the account is the copy every browser reads.
// To this computer: the account's copy comes down first, then the
// account deletes it.
async function setStorageMode(mode, consent) {
  if (mode === 'account') {
    await api('/me/storage', { method: 'PUT', body: { mode: 'account', consent: consent === true } });
    const local = await chrome.storage.local.get(['cv', 'workday', 'ai']);
    if (local.cv) {
      const saved = await api('/me/cv', { method: 'PUT', body: { name: local.cv.name, type: local.cv.type, data: local.cv.data, consent: true } });
      await chrome.storage.local.set({ cvSavedAt: saved.cv.uploaded_at });
    }
    await api('/me/storage/secrets', { method: 'PUT', body: {
      workday: local.workday && local.workday.password ? local.workday.password : null,
      ai: local.ai && local.ai.key ? local.ai : null,
    } });
  } else {
    await syncStorage();
    await api('/me/storage', { method: 'PUT', body: { mode: 'local' } });
  }
  await chrome.storage.local.set({ storageMode: mode });
  return storageState();
}

async function saveCv(cv) {
  const { storageMode } = await chrome.storage.local.get('storageMode');
  if (!cv) {
    if (storageMode === 'account') await api('/me/cv', { method: 'DELETE' });
    await chrome.storage.local.remove(['cv', 'cvSavedAt']);
    return storageState();
  }
  let savedAt = new Date().toISOString();
  if (storageMode === 'account') savedAt = (await api('/me/cv', { method: 'PUT', body: { ...cv, consent: true } })).cv.uploaded_at;
  await chrome.storage.local.set({ cv, cvSavedAt: savedAt });
  return storageState();
}

// {workday: string|null} and/or {ai: {provider, key, model}|null}; a field
// left out stays as it is, null removes it.
async function saveSecrets(change) {
  const { storageMode } = await chrome.storage.local.get('storageMode');
  if (storageMode === 'account') await api('/me/storage/secrets', { method: 'PUT', body: change });
  if ('workday' in change) {
    if (change.workday) await chrome.storage.local.set({ workday: { password: change.workday } });
    else await chrome.storage.local.remove('workday');
  }
  if ('ai' in change) {
    if (change.ai) await chrome.storage.local.set({ ai: change.ai });
    else await chrome.storage.local.remove('ai');
  }
  return storageState();
}

async function run() {
  if (running) return;
  running = true;
  try {
    // With the settings on the account, another computer may have changed them.
    if ((await chrome.storage.local.get('token')).token) await syncStorage().catch(() => {});
    const st = await chrome.storage.local.get(['token', 'paused', 'cv', 'ai']);
    if (!st.token) return;
    await flushOutbox();
    if (st.paused || !st.cv) return;
    const tz = encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone);
    const [{ profile, preferences }, summary, { applied: history }] = await Promise.all([
      api('/me/apply/profile'), api('/me/apply/summary?tz=' + tz), api('/me/apply/history?limit=200'),
    ]);
    await chrome.storage.local.set({ authError: false });
    const now = Date.now();
    // The server's numbers (summary), never counted here: the server holds
    // the plan's limit and the user's daily maximum for every path.
    setBadge(summary.applied_today);
    const settings = profile.settings || {};
    const guardrails = settings.guardrails || {};
    let left = Math.min(PER_RUN, summary.remaining == null ? PER_RUN : summary.remaining);
    if (!left) return;

    const ctx = { profile, preferences, settings, cv: st.cv, ai: st.ai, serverAi: true };
    const queueMode = settings.mode === 'queue';
    // Queued jobs come first in both modes. The user or their AI assistant
    // chose each one, so the minimum match does not apply and a skip may retry.
    const screen = { history, guardrails, now, retrySkipped: true, minMatch: null };
    const queued = [];
    const { queue = [] } = await api('/me/apply/queue');
    for (const item of queue) {
      if (queued.length >= left) break;
      const job = await fetchJob(item.job_id);
      const why = !job ? 'job not found' : job.closed_at ? 'job closed' : oojMatch.screenJob(job, screen);
      if (why) {
        await report(item.job_id, 'skipped', why);
        await api(`/me/apply/queue/${encodeURIComponent(item.job_id)}`, { method: 'DELETE' }).catch(() => {});
        continue;
      }
      queued.push(job);
    }
    const queuedIds = new Set(queued.map((j) => j.id));
    let jobs = queued;
    if (!queueMode) {
      const picked = oojMatch.pickJobs(await autoCandidates(preferences),
        { history, guardrails, now, retrySkipped: false, minMatch: guardrails.min_match });
      jobs = oojMatch.withQueued(queued, picked, guardrails);
    }

    for (const job of jobs) {
      if (left <= 0) break;
      const outcome = await applyTo(job, ctx);
      if (outcome === 'limit') break;
      if (queuedIds.has(job.id)) await api(`/me/apply/queue/${encodeURIComponent(job.id)}`, { method: 'DELETE' }).catch(() => {});
      if (outcome === 'captcha') break;
      if (outcome === 'submitted' || outcome === 'unconfirmed') {
        left--;
        history.push({ job_id: job.id, company: job.company_domain, status: outcome, at: new Date().toISOString() });
      }
    }
  } catch (e) {
    await chrome.storage.local.set({ lastError: String(e.message || e) });
  } finally {
    await chrome.storage.local.set({ lastRun: new Date().toISOString() });
    running = false;
  }
}

// A form the user opened themselves (detect.js). The job may not be in
// our database, so its id is a hash of the page address: stable, and the
// shape claim() accepts.
async function pageJobId(url) {
  const u = new URL(url);
  const key = u.origin + u.pathname + '?' + ['for', 'token', 'gh_jid'].map((k) => `${k}=${u.searchParams.get(k) || ''}`).join('&');
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
  return [...bytes.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

let accountCache = null;
async function account() {
  if (accountCache && Date.now() - accountCache.at < 5 * 60000) return accountCache;
  const tz = encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [{ profile, preferences }, usage, { applied }] = await Promise.all([
    api('/me/apply/profile'), api('/me/apply/summary?tz=' + tz), api('/me/apply/history?limit=200'),
  ]);
  accountCache = { at: Date.now(), profile, preferences, usage, history: applied };
  return accountCache;
}

// Whether to offer filling this page, and if not, why: the card always
// says what stands in the way rather than staying silent.
const ACCOUNT_URL = 'https://oceanofjobs.com/apply';
const NOT_CONNECTED = 'Connect your Ocean of Jobs account to fill in this application.';
const EXPIRED = 'Your connection has expired. Connect again to continue.';
const NO_CV = 'Add your resume in Settings before applying.';
const ALREADY = "You've already applied to this job with Ocean of Jobs.";
const UNEXPECTED = 'Something went wrong. Reload the page and try again.';
const READ_ERROR = "Couldn't read the application form on this page.";
const UNREACHABLE = "Couldn't load your Ocean of Jobs account. Try again in a minute.";
async function offerHere(url) {
  const st = await chrome.storage.local.get(['token', 'authError', 'cv']);
  if (!st.token || st.authError) {
    return { show: true, blocked: st.authError ? EXPIRED : NOT_CONNECTED, action: { label: 'Connect account', url: ACCOUNT_URL } };
  }
  // No dedicated filler: fill only, which needs no account check.
  if (!globalThis.oojAts[adapterFor(url)].matches(url)) {
    return st.cv ? { show: true, assist: true } : { show: true, assist: true, blocked: NO_CV, action: { label: 'Add resume', options: true } };
  }
  let a;
  try {
    a = await account();
  } catch (e) {
    if (e.status === 401) return { show: true, blocked: EXPIRED, action: { label: 'Connect account', url: ACCOUNT_URL } };
    return { show: true, blocked: UNREACHABLE };
  }
  if (!((a.profile.settings || {}).sources || []).includes('ats_pages')) {
    return { show: true, blocked: 'Turn on "Jobs I open on supported hiring sites" under Auto apply on your account, then reload this page.', action: { label: 'Open Auto apply', url: ACCOUNT_URL } };
  }
  if (!st.cv) return { show: true, blocked: NO_CV, action: { label: 'Add resume', options: true } };
  const id = await pageJobId(url);
  if (a.history.some((h) => h.job_id === id && ['submitted', 'unconfirmed', 'sent'].includes(h.status))) return { show: true, blocked: ALREADY };
  return { show: true, remaining: a.usage.remaining };
}

// The job a tab shows: the board's id when /apply's "Apply to next" opened
// it, so its reservation and its queue entry line up; otherwise a stable
// hash of the page address (the server matches both by canonical identity).
async function jobForTab(tabId, url, title, company) {
  const key = `tabjob:${tabId}`;
  const { [key]: board } = await chrome.storage.session.get(key);
  const id = board && new URL(board.url).host === new URL(url).host ? board.id : await pageJobId(url);
  company = (await pageCompany(tabId)) || company;
  return { id, url, title: title || '', company_name: company || '', company_domain: company || '', board: !!board };
}

// The employer the page names: the posting's structured data, then a title
// like "Engineer at Cyera". Hosted forms (Comeet, Lever) live on the ATS's
// address, so the address alone would name the ATS. '' when it names none.
async function pageCompany(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: () => {
      const find = (o) => !o || typeof o !== 'object' ? '' : (o.hiringOrganization && o.hiringOrganization.name)
        || [].concat(o['@graph'] || [], Array.isArray(o) ? o : []).map(find).find(Boolean) || '';
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try { const n = find(JSON.parse(s.textContent)); if (n) return String(n); } catch { /* not JSON */ }
      }
      const og = (document.querySelector('meta[property="og:title"]') || {}).content || document.title;
      const m = / at ([^|–—-]{2,80}?)\s*(?:[|–—-].*)?$/.exec(og || '');
      return m ? m[1] : '';
    } });
    return String((r && r.result) || '').trim().slice(0, 200);
  } catch { return ''; }
}

// A fill the user will check and send: in History as Filled, no credit.
// Then the tab is watched for the user sending it (watchSend).
async function recordFilled(job, tabId, frameId, email) {
  const attemptId = newAttemptId();
  await sendDurable('/me/apply/filled', { attempt_id: attemptId, job_id: job.id, url: job.url, title: job.title,
    company: job.company_name || job.company_domain });
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  await setWatch(tabId, { attemptId, email: String(email || '').trim().toLowerCase(), url: tab.url, until: Date.now() + WATCH_FOR, clickAt: 0 });
  await inTab(tabId, 'generic', 'watchSend', [], frameId).catch(() => null);
}

// A filled form the user sends with the site's own button shows as Filled
// until the extension sees it go. The strongest sign is the form's own
// POST: it carries the applicant's email, the site accepts it, and it
// comes within a minute of a press on the form's send button. The other
// is a confirmation on the page (generic.watchSend, sentHere). Either
// marks the Filled entry sent: Applied on the board, still no credit.
const WATCH_FOR = 2 * 60 * 60 * 1000;
const SEND_WINDOW = 60 * 1000;

async function watches() {
  return (await chrome.storage.session.get('sendWatch')).sendWatch || {};
}
async function setWatch(tabId, w) {
  const all = await watches();
  if (w) all[tabId] = w;
  else delete all[tabId];
  await chrome.storage.session.set({ sendWatch: all });
}
async function watchFor(tabId) {
  const w = (await watches())[tabId];
  return w && w.until > Date.now() ? w : null;
}
async function markSent(tabId, how) {
  const w = await watchFor(tabId);
  if (!w) return;
  await setWatch(tabId, null);
  await sendDurable(`/me/apply/attempts/${w.attemptId}/sent`, { how });
}

// Whether a request body has the applicant's email in it, as typed or URL-encoded.
function carries(body, email) {
  if (!email || !body) return false;
  const want = [email, encodeURIComponent(email).toLowerCase()];
  const parts = body.formData ? Object.values(body.formData).flat().map(String)
    : (body.raw || []).filter((r) => r.bytes).map((r) => new TextDecoder().decode(r.bytes));
  return parts.some((p) => want.some((e) => p.toLowerCase().includes(e)));
}

// requestId -> whether that POST carried the email, for onCompleted.
const sendPosts = new Map();
const SEND_FILTER = { urls: ['https://*/*'], types: ['main_frame', 'sub_frame', 'xmlhttprequest', 'other'] };
chrome.webRequest.onBeforeRequest.addListener((d) => {
  if (d.method !== 'POST' || d.tabId < 0) return;
  sendPosts.set(d.requestId, watchFor(d.tabId).then((w) => !!w && carries(d.requestBody, w.email)));
}, SEND_FILTER, ['requestBody']);
chrome.webRequest.onCompleted.addListener(async (d) => {
  const carried = sendPosts.get(d.requestId);
  if (!carried) return;
  sendPosts.delete(d.requestId);
  if (!(await carried) || d.statusCode >= 400) return;
  const w = await watchFor(d.tabId);
  if (w && w.clickAt && Date.now() - w.clickAt < SEND_WINDOW) await markSent(d.tabId, 'request');
}, SEND_FILTER);
chrome.webRequest.onErrorOccurred.addListener((d) => { sendPosts.delete(d.requestId); }, SEND_FILTER);

// A send that loads another page: look there for a confirmation, and
// watch again if it's the form back with errors.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return;
  const w = await watchFor(tabId);
  if (!w || !w.clickAt || Date.now() - w.clickAt > 3 * 60 * 1000) return;
  if (await inTab(tabId, 'generic', 'sentHere', [w.url]).catch(() => false)) await markSent(tabId, 'page');
  else await inTab(tabId, 'generic', 'watchSend').catch(() => null);
});

async function fillHere(msg, tabId, frameId) {
  const st = await chrome.storage.local.get(['cv', 'ai']);
  if (!st.cv) return { error: NO_CV };
  accountCache = null;
  const a = await account();
  const name = adapterFor(msg.url);
  const job = { id: await pageJobId(msg.url), url: msg.url, title: msg.title, company_name: msg.company, company_domain: msg.company,
    location: msg.location || '', ats: name };
  const page = await readForm(tabId, name, frameId);
  if (!page || page.error) return { error: (page && page.error) || READ_ERROR };
  const ctx = { profile: a.profile, preferences: a.preferences, settings: a.profile.settings || {}, cv: st.cv, ai: st.ai,
    serverAi: true };
  const { plan, suggested } = await planWithSuggestions(page, job, ctx);
  // Filling costs nothing (R8); a credit is reserved only when Submit is
  // pressed on the card, by the user or by Full automatic (startSubmit).
  const result = await fillAndMark(tabId, frameId, name, plan, suggested, ctx.cv);
  await recordFilled(await jobForTab(tabId, msg.url, msg.title, msg.company), tabId, frameId, a.profile.contact && a.profile.contact.email);
  // The dedicated filler presses its own button and handles a CAPTCHA
  // (ats outcome), as in automatic runs: reCAPTCHA sits on every
  // Greenhouse and Ashby form, so generic's bot check isn't asked here.
  const why = autoWhy(a, job, msg.url, result, { text: 'Submit' });
  return { ...result, auto: why === null, held: why || '' };
}

// Full automatic: whether a fill goes on to submit, or why it stops (oojMatch.autoSubmit).
function autoWhy(a, job, url, result, info) {
  const s = a.profile.settings || {};
  const screen = { history: a.history, guardrails: s.guardrails || {}, now: Date.now(), retrySkipped: true, minMatch: null };
  // Never apply to holds domains: the company the page names, or the page's own host.
  const screened = oojMatch.screenJob(job, screen) || oojMatch.screenJob({ ...job, company_domain: new URL(url).hostname }, screen);
  return oojMatch.autoSubmit({ fill: s.fill, plan: a.usage.plan, botCheck: !!(info && info.botCheck), submit: !!(info && info.text) && result.filled > 0,
    missing: result.missing, errors: result.errors, remaining: a.usage.remaining, screened });
}

// The gate for a Submit from the card: mode 'card' when the user pressed
// it, 'auto' when Full automatic did, so AI answers need what an automatic
// run needs. Held for review, the credit goes back and the card says which.
async function cardGate(attemptId, tabId, auto) {
  const ok = await gate(attemptId, { mode: auto ? 'auto' : 'card', answers: await cardAnswers(tabId) });
  if (ok.review) await settle(attemptId, 'skipped', 'check AI answers: ' + ok.review.join('; '));
  return ok;
}

// "Submit application" on the card: reserve a credit and pass the gate
// before the card presses the site's button. {ok} or {error}.
async function startSubmit(msg, tabId) {
  await setWatch(tabId, null); // the card's own attempt records this send
  const job = await jobForTab(tabId, msg.url, msg.title, msg.company);
  const held = await reserve(job);
  if (!held.attemptId) return { error: held.taken ? ALREADY : held.error };
  const ok = await cardGate(held.attemptId, tabId, msg.auto);
  if (!ok.ok) return ok;
  const { pendingHere = {} } = await chrome.storage.local.get('pendingHere');
  pendingHere[tabId] = { attemptId: held.attemptId, jobId: job.board ? job.id : null };
  await chrome.storage.local.set({ pendingHere });
  return { ok: true };
}

async function readForm(tabId, name, frameId) {
  const ats = globalThis.oojAts[name];
  const target = frameId ? { tabId, frameIds: [frameId] } : { tabId };
  const [main] = ats.pageData ? await chrome.scripting.executeScript({ target, world: 'MAIN', func: ats.pageData }) : [];
  return inTab(tabId, name, 'read', [main ? main.result : null], frameId);
}

// The user checks this form before submitting, so every question with no
// saved answer gets the AI's best suggestion, outlined for review.
async function planWithSuggestions(page, job, ctx) {
  const plan = oojMatch.planFill(page.fields, ctx.profile, job);
  answerRequired(plan);
  const suggested = [];
  for (const f of oojMatch.suggestable(page.fields, plan)) {
    const answer = await suggestAnswer(f, job, ctx);
    if (answer === undefined) continue;
    if (plan.missing.includes(f)) plan.missing.splice(plan.missing.indexOf(f), 1);
    plan.fills.push({ ...f, value: answer });
    suggested.push(f);
  }
  return { plan, suggested };
}

async function fillAndMark(tabId, frameId, name, plan, suggested, cv) {
  const filled = await inTab(tabId, name, 'fill', [plan.fills, cv], frameId);
  // What the AI suggested here, for the record when the user presses Submit
  // on the card (cardAnswers).
  await chrome.storage.session.set({ [`cardai:${tabId}`]: { frameId, items: suggested.map((f) => ({
    question: f.label, name: f.name, answer: String((plan.fills.find((x) => x.name === f.name) || {}).value ?? '') })) } });
  // Amber: the AI suggested it, check it. Red: still needs the user.
  await chrome.scripting.executeScript({
    target: frameId ? { tabId, frameIds: [frameId] } : { tabId },
    args: [suggested.map((f) => f.name), plan.missing.map((f) => f.name)],
    func: (amber, red) => [[amber, '#e0a43a', 'ai'], [red, '#ff6b5e', 'required']].forEach(([names, color, kind]) => names.forEach((n) => {
      const docs = [document, ...[...document.querySelectorAll('iframe')].map((f) => { try { return f.contentDocument; } catch { return null; } }).filter(Boolean)];
      const el = docs.map((d) => d.querySelector(`[data-ooj-box="${CSS.escape(n)}"]`)).find(Boolean)
        || document.getElementById(n) || document.getElementById(n.replace(/_/g, '-')) || document.querySelector(`[name="${CSS.escape(n)}"]`);
      const box = el && (el.hasAttribute('data-ooj-box') ? el : el.closest('.select__control') || el.closest('fieldset') || el);
      if (box) { box.style.outline = `2px solid ${color}`; box.style.outlineOffset = '2px'; box.dataset.oojReview = kind; }
    })),
  });
  const errors = (filled && filled.errors) || ['could not fill the form'];
  return {
    filled: plan.fills.length - errors.length,
    suggested: suggested.length,
    statements: suggested.filter((f) => oojMatch.isStatement(f.label)).map((f) => f.label),
    missing: plan.missing.map((f) => f.label),
    errors,
  };
}

// The AI's suggestions on this tab as they stand when the user presses
// Submit: what's in each field now. Unchanged, it's the AI's answer;
// changed, it's the user's. [] when nothing was suggested or nothing can be
// read; the gate then records nothing, it doesn't refuse.
async function cardAnswers(tabId) {
  const key = `cardai:${tabId}`;
  const { [key]: card } = await chrome.storage.session.get(key);
  if (!card || !card.items.length) return [];
  try {
    const [r] = await chrome.scripting.executeScript({
      target: card.frameId ? { tabId, frameIds: [card.frameId] } : { tabId },
      args: [card.items.map((i) => i.name)],
      func: (names) => names.map((n) => {
        const docs = [document, ...[...document.querySelectorAll('iframe')].map((f) => { try { return f.contentDocument; } catch { return null; } }).filter(Boolean)];
        const box = docs.map((d) => d.querySelector(`[data-ooj-box="${CSS.escape(n)}"]`)).find(Boolean)
          || document.getElementById(n) || document.querySelector(`[name="${CSS.escape(n)}"]`);
        if (!box) return null;
        const single = box.querySelector && box.querySelector('[class*="single-value"]');
        if (single) return single.textContent.trim();
        const el = box.matches('input, textarea, select') ? box : box.querySelector('textarea, select, input:not([type=hidden])');
        const checked = box.querySelector && box.querySelector('input:checked');
        if (checked && (checked.type === 'radio' || checked.type === 'checkbox')) {
          const label = checked.closest('label') || (checked.id && document.querySelector(`label[for="${CSS.escape(checked.id)}"]`));
          return (label ? label.textContent : checked.value).trim();
        }
        if (el && el.tagName === 'SELECT') return ((el.selectedOptions || [])[0] || {}).text || '';
        return el ? el.value : null;
      }),
    });
    const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
    return card.items.map((item, i) => ({ item, now: r.result[i] })).filter(({ now }) => now != null && String(now).trim())
      .map(({ item, now }) => ({ question: item.question, answer: String(now).slice(0, 800), ...(same(now, item.answer) ? { source: 'ai' } : {}) }));
  } catch {
    return [];
  }
}

// The frame of the tab that holds an application form, among the frames
// we may script: the page itself (activeTab or a host permission) and
// iframes on hosts we have a permission for. Waits up to ms for a frame
// that is still loading.
async function frameWithForm(tabId, ms) {
  const target = { tabId, allFrames: true };
  for (const until = Date.now() + ms; ; await new Promise((r) => setTimeout(r, 500))) {
    const res = await chrome.scripting.executeScript({ target, files: ['ats/generic.js'] })
      .then(() => chrome.scripting.executeScript({ target, func: () => ({ ...globalThis.oojAts.generic.formHere(), url: location.href }) }))
      .catch(() => []);
    const best = oojMatch.pickFrame(res);
    if (best || Date.now() >= until) return best && { frameId: best.frameId, url: best.result.url };
  }
}

// "Fill application" in the popup, on whatever site the tab shows. The
// popup's click grants activeTab for the page; a form in an iframe is
// reached through the host permissions. No credit is claimed: the user
// reviews and submits the form themselves, unless Full automatic submits it.
async function fillTab(tabId) {
  const st = await chrome.storage.local.get(['token', 'authError', 'cv']);
  if (!st.token || st.authError) return { error: st.authError ? EXPIRED : NOT_CONNECTED };
  if (!st.cv) return { error: NO_CV };
  let tab = await chrome.tabs.get(tabId);
  const stop = await workdayFirst(tabId, tab.url);
  if (stop) return { error: stop };
  tab = await chrome.tabs.get(tabId);
  let name, page, frameId = 0;
  // A posting page links to its form, or the Apply button reloads the
  // page: read again once it loads. activeTab does not follow the tab to
  // another site, so there the read fails and the user clicks again.
  let moved = false;
  for (let hop = 0; hop < 3; hop++) {
    name = adapterFor(tab.url);
    // Ashby and Workable keep the form at its own address, and their
    // readers find nothing on the posting page the user is looking at.
    let form = null;
    try { form = globalThis.oojAts[name].formUrl ? globalThis.oojAts[name].formUrl(tab.url) : null; } catch { /* not a single job */ }
    page = form && form !== tab.url ? { openUrl: form } : await readForm(tabId, name).catch(() => null);
    // The form is in an iframe (embedded from another site, or opened by
    // the Apply button): fill it there when we may, rather than leave the page.
    if (!form && (!page || page.error || page.frame)) {
      const f = await frameWithForm(tabId, page && page.frame ? 10000 : 0);
      if (f && f.frameId !== 0) {
        frameId = f.frameId;
        name = adapterFor(f.url);
        page = await readForm(tabId, name, frameId).catch(() => null);
        if (page && page.openUrl) page = { error: READ_ERROR };
        tab = { ...tab, url: f.url };
      }
    }
    if (page && !page.openUrl) break;
    const before = tab.url;
    if (page) await chrome.tabs.update(tabId, { url: page.openUrl });
    await new Promise((r) => setTimeout(r, 1000));
    await waitForLoad(tabId);
    tab = await chrome.tabs.get(tabId);
    if (!page && tab.url === before) {
      // Nothing to inject into and nothing moved: a browser page, the Web Store.
      if (!moved) return { error: "The extension can't fill in this page." };
      break;
    }
    moved = true;
  }
  if (!page || page.openUrl) return { error: 'Application page opened. Click Fill application again to continue.' };
  const r = await assist(tabId, frameId, name, page, tab.url, tab.title);
  if (!r.auto) return r;
  // Full automatic: the card's Submit (submitHere), pressed for the user.
  return { ...r, sent: await submitHere({ url: tab.url, frameId, title: tab.title, company: new URL(tab.url).hostname, auto: true },
    { tab: { id: tabId }, frameId }) };
}

// Plans and fills a form the user will check and send themselves.
async function assist(tabId, frameId, name, page, url, title) {
  if (page.error) return { error: page.error };
  const st = await chrome.storage.local.get(['cv', 'ai']);
  let a;
  try {
    accountCache = null;
    a = await account();
  } catch (e) {
    return { error: e.status === 401 ? EXPIRED : UNREACHABLE };
  }
  const u = new URL(url);
  const job = { ...(await jobForTab(tabId, url, title, u.hostname)), location: '', ats: name };
  const ctx = { profile: a.profile, preferences: a.preferences, settings: a.profile.settings || {}, cv: st.cv, ai: st.ai,
    serverAi: true };
  const { plan, suggested } = await planWithSuggestions(page, job, ctx);
  const result = await fillAndMark(tabId, frameId, name, plan, suggested, ctx.cv);
  await recordFilled(job, tabId, frameId, a.profile.contact && a.profile.contact.email);
  const submit = await inTab(tabId, 'generic', 'submitInfo', [], frameId).catch(() => null);
  const why = autoWhy(a, job, url, result, submit);
  return { ...result, ats: name, frameId, fields: page.fields.length, required: page.fields.filter((f) => f.required).length,
    submitInfo: submit, auto: why === null, held: why || '' };
}

// What the popup's fill button offers on a tab, before any click: opening
// the popup grants activeTab, so the page is read with the same readers a
// fill uses, and nothing is filled or sent. 'form' when a fill would find a
// form (or an Apply link to follow), 'none' when it would not, 'unsupported'
// where Chrome lets no extension in (browser pages, the Web Store, PDFs).
async function pageState(tabId) {
  const tab = await chrome.tabs.get(tabId);
  let u;
  try { u = new URL(tab.url); } catch { return 'unsupported'; }
  if (!/^https?:$/.test(u.protocol) || u.hostname === 'chromewebstore.google.com'
      || (u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore')) || /\.pdf$/i.test(u.pathname)) return 'unsupported';
  const reachable = await chrome.scripting.executeScript({ target: { tabId }, func: () => true }).then(() => true, () => false);
  if (!reachable) return 'unsupported';
  // Its sign-in step has no fields to read; a fill signs in first.
  if (globalThis.oojAts.workday.matches(tab.url)) return 'form';
  const name = adapterFor(tab.url);
  try {
    const form = globalThis.oojAts[name].formUrl && globalThis.oojAts[name].formUrl(tab.url);
    if (form && form !== tab.url) return 'form';
  } catch { /* not a single job's page */ }
  const page = await readForm(tabId, name).catch(() => null);
  if (page && !page.error && !page.frame && (page.openUrl || (page.fields && page.fields.length))) return 'form';
  return (await frameWithForm(tabId, 0)) ? 'form' : 'none';
}

// "Review answers": moves to the next field the last fill marked,
// required ones still empty first, then answers AI suggested. Each click
// goes one further; {left: 0} once nothing needs attention.
async function reviewFields(tabId, frameId) {
  const [res] = await chrome.scripting.executeScript({
    target: frameId ? { tabId, frameIds: [frameId] } : { tabId },
    func: () => {
      const docs = [document, ...[...document.querySelectorAll('iframe')].map((f) => { try { return f.contentDocument; } catch { return null; } }).filter(Boolean)];
      const boxes = docs.flatMap((d) => [...d.querySelectorAll('[data-ooj-review]')]);
      const fieldOf = (b) => (b.matches('input, select, textarea') ? b : b.querySelector('input:not([type=hidden]), select, textarea'));
      const empty = (b) => {
        const choices = [...b.querySelectorAll('input[type=checkbox], input[type=radio]')];
        if (choices.length) return !choices.some((i) => i.checked);
        const el = fieldOf(b);
        return !!el && !String(el.value || '').trim();
      };
      const queue = [...boxes.filter((b) => b.dataset.oojReview === 'required' && empty(b)), ...boxes.filter((b) => b.dataset.oojReview === 'ai')];
      const at = queue.findIndex((b) => b.hasAttribute('data-ooj-current'));
      boxes.forEach((b) => b.removeAttribute('data-ooj-current'));
      if (!queue.length) return { left: 0 };
      const i = (at + 1) % queue.length;
      const box = queue[i];
      box.setAttribute('data-ooj-current', '');
      box.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const el = fieldOf(box) || box.querySelector('button, [tabindex]');
      if (el) el.focus({ preventScroll: true });
      return { left: queue.length, index: i + 1, kind: box.dataset.oojReview };
    },
  });
  return res ? res.result : { left: 0 };
}

const site = (url) => new URL(url).hostname.split('.').slice(-2).join('.');

// The fill button on a page with no dedicated filler, like "Fill in this
// page". The form may sit in a frame below the button. On a job posting
// the Apply button loads the form, in the page or in a frame, or links to
// it on the same site; the tab goes there and the new page shows the card.
// The result names the frame and address the card submits to.
async function assistHere(msg, sender) {
  const st = await chrome.storage.local.get(['token', 'authError', 'cv']);
  if (!st.token || st.authError) return { error: st.authError ? EXPIRED : NOT_CONNECTED };
  if (!st.cv) return { error: NO_CV };
  const tabId = sender.tab.id;
  let frameId = msg.frameId != null ? msg.frameId : sender.frameId;
  let url = msg.url;
  let moved = false;
  if (frameId === 0 && globalThis.oojAts.workday.matches(url)) {
    const stop = await workdayFirst(tabId, url);
    if (stop) return { error: stop };
    url = (await chrome.tabs.get(tabId)).url;
    moved = url !== msg.url;
  }
  let page = await readForm(tabId, 'generic', frameId).catch(() => null);
  if (page && page.frame) {
    const f = await frameWithForm(tabId, 10000);
    page = f && f.frameId !== frameId ? await readForm(tabId, 'generic', f.frameId).catch(() => null) : null;
    if (f) ({ frameId, url } = f);
  } else if (page && page.openUrl && frameId === 0 && site(page.openUrl) === site(url)) {
    url = page.openUrl;
    await chrome.tabs.update(tabId, { url });
    await new Promise((r) => setTimeout(r, 1000));
    await waitForLoad(tabId);
    page = await readForm(tabId, 'generic', 0).catch(() => null);
    moved = true;
  }
  if (!page || page.openUrl) return { error: READ_ERROR };
  const r = await assist(tabId, frameId, 'generic', page, url, msg.title);
  if (r.error) return r;
  const submit = r.submitInfo;
  // A page with a human check still gets the card's Submit for the user to
  // press; Full automatic leaves it to them (autoWhy).
  const out = { ...r, frameId, url, submit: submit && r.filled > 0 && submit.text, botCheck: !!(submit && submit.botCheck) };
  // The card that asked went with the old page. detect.js on the new one
  // may still be starting, so try for a few seconds.
  for (let i = 0; moved && i < 10; i++) {
    if (await chrome.tabs.sendMessage(tabId, { type: 'filledHere', result: out }, { frameId: 0 }).catch(() => false)) break;
    await new Promise((res) => setTimeout(res, 500));
  }
  return out;
}

// "Submit application" on the card of a page with no dedicated filler:
// claim a credit, press the form's own button, watch for a confirmation.
// The credit counts only when one shows; otherwise it is given back.
async function submitHere(msg, sender) {
  const tabId = sender.tab.id;
  await setWatch(tabId, null); // the card's own attempt records this send
  const frameId = msg.frameId != null ? msg.frameId : sender.frameId;
  const info = await inTab(tabId, 'generic', 'submitInfo', [], frameId).catch(() => null);
  if (!info || !info.text) return { error: oojMatch.reasonText('submit button not found') };
  const job = await jobForTab(tabId, msg.url, msg.title, msg.company);
  const held = await reserve(job);
  if (!held.attemptId) return { error: held.taken ? ALREADY : held.error };
  const ok = await cardGate(held.attemptId, tabId, msg.auto);
  if (ok.review) return { review: ok.review };
  if (!ok.ok) return { error: ok.error };
  accountCache = null;
  // Past the gate: every way out settles, and an uncertain one is
  // Submission unconfirmed (never retried).
  let before = null;
  let out;
  try {
    before = await inTab(tabId, 'generic', 'submit', [], frameId);
    out = before ? await watchHere(tabId, frameId, before) : { failed: 'submit button not found' };
  } catch (e) {
    out = { failed: String(e.message || e).slice(0, 200) };
  }
  if (!before && out && out.failed === 'submit button not found') {
    await settle(held.attemptId, 'failed', out.failed);
    return { failed: out.failed };
  }
  const [outcome, why] = afterClick(out || null);
  await settle(held.attemptId, outcome, why);
  if (job.board && outcome !== 'failed') await api(`/me/apply/queue/${job.id}`, { method: 'DELETE' }).catch(() => {});
  if (outcome === 'submitted') return { submitted: true };
  return outcome === 'failed' ? { failed: why } : { unknown: true };
}

// generic.outcome() in the form's frame for up to 20 seconds. A navigation
// ends the script early with no answer, so it goes in again on the new page.
async function watchHere(tabId, frameId, before) {
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    const r = await inTab(tabId, 'generic', 'outcome', [before, until - Date.now()], frameId).catch(() => null);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 1000));
  }
  return null;
}

// The AI's best answer for a page the user will review: our server, or
// the user's own key once the plan's AI answers run out. Not saved as a saved answer.
async function suggestAnswer(field, job, ctx) {
  if (ctx.serverAi) {
    try {
      const { answer } = await draft({ question: field.label, options: field.options || [], mode: 'suggest',
        job: { id: job.id, title: job.title, company: job.company_name, location: job.location } });
      return fits(field, answer) ? answer : undefined;
    } catch (e) {
      if (e.status === 422) return undefined;
      ctx.serverAi = false;
    }
  }
  if (!ctx.ai || !ctx.ai.key) return undefined;
  const answer = await draftAnswer(field, ctx.profile, ctx.preferences, job, ctx.ai).catch(() => undefined);
  return fits(field, answer) ? answer : undefined;
}

// The auto apply queue for the popup, with each job's title and whether
// the extension can fill its site yet.
async function queueView() {
  const { queue = [] } = await api('/me/apply/queue');
  const items = await Promise.all(queue.slice(0, 25).map(async (q) => {
    // null: the server has no such job. undefined: it could not be asked.
    const job = await fetchJob(q.job_id).catch(() => undefined);
    return {
      id: q.job_id, title: job ? job.title : job === null ? oojMatch.reasonText('job closed') : "Couldn't load this job.",
      company: job ? (job.company_name || job.company_domain) : '',
      supported: !!(job && canRun(job)),
    };
  }));
  return { total: queue.length, items };
}

// The outcome the card saw after pressing Submit, or the tab closed after
// the gate: the click may have happened, so that one is unconfirmed.
async function settleHere(tabId, result) {
  const { pendingHere = {} } = await chrome.storage.local.get('pendingHere');
  const p = pendingHere[tabId];
  if (!p) return;
  delete pendingHere[tabId];
  await chrome.storage.local.set({ pendingHere });
  accountCache = null;
  const [outcome, why] = result === 'closed' ? ['unconfirmed', 'The tab closed before the site confirmed the application.'] : afterClick(result);
  await settle(p.attemptId, outcome, why);
  if (p.jobId && outcome !== 'failed') await api(`/me/apply/queue/${p.jobId}`, { method: 'DELETE' }).catch(() => {});
}

chrome.tabs.onRemoved.addListener((tabId) => {
  settleHere(tabId, 'closed');
  setWatch(tabId, null);
  chrome.storage.session.remove([`tabjob:${tabId}`, `cardai:${tabId}`]);
});

// The popup's numbers, all from the server's summary and needs: nothing is
// counted in the extension.
async function status() {
  const st = await chrome.storage.local.get(['token', 'paused', 'cv', 'authError', 'lastRun', 'lastError', 'outbox']);
  const out = {
    connected: !!st.token && !st.authError, authError: !!st.authError, paused: !!st.paused,
    hasCv: !!st.cv, needs: [], lastRun: st.lastRun || null, lastError: st.lastError || null, pending: (st.outbox || []).length,
  };
  if (!out.connected) return out;
  try {
    const tz = encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone);
    const [summary, { needs }] = await Promise.all([api('/me/apply/summary?tz=' + tz), api('/me/apply/needs')]);
    out.summary = summary;
    out.usage = { plan: summary.plan, period: summary.period, remaining: summary.remaining };
    out.appliedToday = summary.applied_today;
    // One row per question, grouped by job in the popup.
    out.needs = needs.flatMap((n) => n.questions.map((question) => ({
      question, job_id: n.job_id, title: n.title, company: n.company, draft: (n.drafts || {})[question] || '',
      link: n.link && n.link.startsWith('/') ? 'https://oceanofjobs.com' + n.link : n.link || n.url,
    })));
    setBadge(summary.applied_today);
  } catch (e) {
    if (e.status === 401) { out.connected = false; out.authError = true; }
  }
  return out;
}

// /apply's "Apply to next": the first job in the queue, opened in a new
// active tab with its card filling it in. The user checks and submits.
async function applyNext() {
  const { queue = [] } = await api('/me/apply/queue');
  for (const item of queue) {
    const job = await fetchJob(item.job_id);
    if (!job || !canRun(job)) continue;
    const ats = globalThis.oojAts[job.ats];
    const url = dedicatedRun(job) && ats.formUrl ? ats.formUrl(job.url) : job.url;
    const tab = await chrome.tabs.create({ url, active: true });
    await chrome.storage.session.set({ [`tabjob:${tab.id}`]: { id: job.id, url } });
    if (await waitForLoad(tab.id)) {
      for (let i = 0; i < 10; i++) {
        if (await chrome.tabs.sendMessage(tab.id, { type: 'fillFromApply' }, { frameId: 0 }).catch(() => false)) break;
        await new Promise((r) => setTimeout(r, 700));
      }
    }
    return { ok: true, job_id: job.id };
  }
  return { error: 'None of the jobs in your queue are ready to fill in.' };
}

function schedule() {
  chrome.alarms.create('run', { periodInMinutes: RUN_MINUTES, delayInMinutes: 1 });
}

// With the optional access to every site, the fill button comes to every
// https page too. The ATS sites in the manifest already have it.
const ALL_SITES = 'https://*/*';
async function syncAllSites() {
  const on = await chrome.permissions.contains({ origins: [ALL_SITES] });
  await chrome.scripting.unregisterContentScripts({ ids: ['detect-all'] }).catch(() => {});
  if (!on) return;
  await chrome.scripting.registerContentScripts([{
    id: 'detect-all', matches: [ALL_SITES], excludeMatches: ['https://oceanofjobs.com/*', ...chrome.runtime.getManifest().content_scripts[1].matches],
    js: ['lib/match.js', 'ats/generic.js', 'detect.js'], allFrames: true, runAt: 'document_idle', persistAcrossSessions: true,
  }]).catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => { schedule(); syncAllSites(); recoverInflight(); });
chrome.runtime.onStartup.addListener(() => { schedule(); recoverInflight(); });
chrome.permissions.onAdded.addListener(syncAllSites);
chrome.permissions.onRemoved.addListener(syncAllSites);
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'run') run();
  if (a.name === 'outbox') flushOutbox();
});

// The /apply dashboard on oceanofjobs.com (externally_connectable).
chrome.runtime.onMessageExternal.addListener((msg, sender, reply) => {
  if (!sender.url || new URL(sender.url).origin !== 'https://oceanofjobs.com') return false;
  if (msg && msg.type === 'ping') {
    chrome.storage.local.get(['token', 'authError']).then((st) =>
      reply({ ok: true, version: chrome.runtime.getManifest().version, connected: !!st.token && !st.authError }));
    return true;
  }
  if (msg && msg.type === 'openOptions') {
    chrome.runtime.openOptionsPage().then(() => reply({ ok: true }), () => reply({ ok: false }));
    return true;
  }
  if (msg && msg.type === 'applyNext') {
    applyNext().catch((e) => ({ error: e.status === 401 ? EXPIRED : UNEXPECTED })).then(reply);
    return true;
  }
  return false;
});

chrome.storage.onChanged.addListener((changes) => {
  // A fresh token from the website: start soon instead of waiting 15 minutes.
  if (changes.token && changes.token.newValue) chrome.alarms.create('run', { periodInMinutes: RUN_MINUTES, delayInMinutes: 0.5 });
  if (changes.token && !changes.token.newValue) setBadge(0);
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (msg.type === 'status') { status().then(reply); return true; }
  if (msg.type === 'queue') { queueView().catch((e) => ({ error: e.message || String(e) })).then(reply); return true; }
  if (msg.type === 'unqueue') {
    api(`/me/apply/queue/${encodeURIComponent(msg.id)}`, { method: 'DELETE' }).then(() => reply({ ok: true }), (e) => reply({ error: e.message || String(e) }));
    return true;
  }
  if (msg.type === 'answer') {
    api('/me/apply/answers', { method: 'POST', body: { question: msg.question, answer: msg.answer, job_id: msg.job_id } }).then(async () => {
      accountCache = null;
      // The job goes back in the queue once every question it waited on
      // has a saved answer; a page that isn't on the board answers 404.
      const [{ needs }, { profile }] = await Promise.all([api('/me/apply/needs'), api('/me/apply/profile')]);
      const job = needs.find((n) => n.job_id === msg.job_id);
      let requeued = false;
      const decided = (profile.answers || []).filter((a) => a.approval !== 'pending');
      if (job && job.questions.every((q) => oojMatch.findAnswer(q, decided, job.job_id) !== undefined)) {
        requeued = await api(`/me/apply/queue/${encodeURIComponent(job.job_id)}`, { method: 'PUT' }).then(() => true, () => false);
      }
      reply({ ok: true, requeued });
    }, (e) => reply({ error: e.message || String(e) }));
    return true;
  }
  if (msg.type === 'pause') { chrome.storage.local.set({ paused: !!msg.paused }).then(() => reply({ ok: true })); return true; }
  if (msg.type === 'offerHere') {
    offerHere(msg.url).catch(() => ({ show: true, blocked: UNEXPECTED })).then(reply);
    return true;
  }
  if (msg.type === 'openOptions') { chrome.runtime.openOptionsPage(); reply({ ok: true }); return false; }
  // The settings view (settings.js), in the popup or its tab.
  const storageCall = { storageState: () => storageState(), storageSync: () => syncStorage().then(storageState, storageState),
    storageMode: () => setStorageMode(msg.mode, msg.consent), storageCv: () => saveCv(msg.cv), storageSecrets: () => saveSecrets(msg.change) }[msg.type];
  if (storageCall) {
    storageCall().then(reply, (e) => reply({ error: (e.body && e.body.error) || (e.status === 401 ? EXPIRED : UNEXPECTED) }));
    return true;
  }
  if (msg.type === 'formBelow') {
    // Ask the page itself to show the button; a page we have no access to
    // runs no detect.js, so the frame shows it.
    chrome.tabs.sendMessage(sender.tab.id, { type: 'formBelow', frameId: sender.frameId, url: sender.url }, { frameId: 0 })
      .then((r) => reply({ shown: !!(r && r.ok) }), () => reply({ shown: false }));
    return true;
  }
  if (msg.type === 'icon') {
    // As a data URL: a web accessible icon would let any site detect the extension.
    fetch(chrome.runtime.getURL('icons/icon-48.png')).then((r) => r.arrayBuffer())
      .then((b) => reply('data:image/png;base64,' + btoa(String.fromCharCode(...new Uint8Array(b)))), () => reply(''));
    return true;
  }
  if (msg.type === 'hidden' || msg.type === 'hide') {
    // Hidden sites last for the browser session, so session storage.
    chrome.storage.session.get('hidden').then(async ({ hidden = [] }) => {
      if (msg.type === 'hide' && !hidden.includes(msg.host)) await chrome.storage.session.set({ hidden: [...hidden, msg.host] });
      reply(hidden.includes(msg.host) || msg.type === 'hide');
    });
    return true;
  }
  if (msg.type === 'fillHere') {
    (globalThis.oojAts[adapterFor(msg.url)].matches(msg.url) ? fillHere(msg, sender.tab.id, sender.frameId) : assistHere(msg, sender))
      .catch((e) => ({ error: e.status === 401 ? EXPIRED : UNEXPECTED }))
      .then(reply);
    return true;
  }
  if (msg.type === 'submitHere') {
    submitHere(msg, sender)
      .catch((e) => ({ error: e.status === 401 ? EXPIRED : UNEXPECTED }))
      .then(reply);
    return true;
  }
  if (msg.type === 'pageState') {
    pageState(msg.tabId).catch(() => 'none').then((state) => reply({ state }));
    return true;
  }
  if (msg.type === 'reviewFields') {
    reviewFields(msg.tabId, msg.frameId).catch(() => ({ left: 0 })).then(reply);
    return true;
  }
  if (msg.type === 'fillTab') {
    fillTab(msg.tabId).catch(() => ({ error: "Couldn't fill in this page. Reload it and try again." })).then(reply);
    return true;
  }
  if (msg.type === 'startSubmit') {
    startSubmit(msg, sender.tab.id).catch(() => ({ error: SERVER_GONE })).then(reply);
    return true;
  }
  if (msg.type === 'sendClick') {
    watchFor(sender.tab.id).then((w) => w && setWatch(sender.tab.id, { ...w, clickAt: Date.now() })).then(() => reply({ ok: true }));
    return true;
  }
  if (msg.type === 'sentPage') { markSent(sender.tab.id, 'page').then(() => reply({ ok: true })); return true; }
  if (msg.type === 'settleHere') { settleHere(sender.tab.id, msg.result).then(() => reply({ ok: true })); return true; }
  return false;
});
