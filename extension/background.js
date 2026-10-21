importScripts('lib/match.js', 'ats/greenhouse.js', 'ats/ashby.js', 'ats/workable.js', 'ats/generic.js');

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
};

function adapterFor(url) {
  return Object.keys(ATS_FILES).find((n) => n !== 'generic' && globalThis.oojAts[n].onSite(url)) || 'generic';
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

// The history shows the reason as written here; the codes stay in the extension.
const report = (job_id, status, reason) =>
  api('/me/apply/result', { method: 'POST', body: { job_id, status, reason: oojMatch.reasonText(reason) } }).catch(() => {});

function setBadge(n) {
  chrome.action.setBadgeText({ text: n ? String(n) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#40513b' });
}

async function addNeeds(field, job) {
  const { needs = [] } = await chrome.storage.local.get('needs');
  if (!needs.some((n) => oojMatch.normalise(n.question) === oojMatch.normalise(field.label))) {
    needs.push({ question: field.label, job_id: job.id, company: job.company_name || job.company_domain, title: job.title, url: job.url, at: new Date().toISOString() });
  }
  await chrome.storage.local.set({ needs });
}

// Questions the user has answered on the website since we asked.
async function pruneNeeds(answers) {
  const { needs = [] } = await chrome.storage.local.get('needs');
  await chrome.storage.local.set({ needs: needs.filter((n) => oojMatch.findAnswer(n.question, answers) === undefined) });
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
  if (ai.provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
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
  } else if (ai.provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
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
  answer !== undefined && !(field.options && field.options.length && oojMatch.pickOption(field.options, answer) < 0);

// A required question with no saved answer. Basic and Pro get it drafted
// (and saved) by our server; Free, or a plan out of AI answers, falls back
// to the user's own key. undefined means skip the job.
async function answerUnknown(field, job, ctx) {
  if (ctx.serverAi) {
    try {
      const { answer } = await api('/me/apply/draft', {
        method: 'POST', body: { question: field.label, options: field.options || [], job: { title: job.title, company: job.company_name || job.company_domain } },
      });
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
  await api('/me/apply/answers', { method: 'POST', body: { question: field.label, answer } }).catch(() => {});
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

// One job, start to finish: 'submitted', 'skipped', 'failed', 'captcha'
// or 'limit' (the plan has no credits left, nothing was claimed).
async function applyTo(job, ctx) {
  const ats = globalThis.oojAts[job.ats];
  if (!ats || !ats.matches(job.url)) {
    await report(job.id, 'skipped', 'unsupported site');
    return 'skipped';
  }
  const tab = await chrome.tabs.create({ url: ats.formUrl ? ats.formUrl(job.url) : job.url, active: false });
  try {
    if (!(await waitForLoad(tab.id))) {
      await report(job.id, 'skipped', 'page did not load');
      return 'skipped';
    }
    const [main] = ats.pageData
      ? await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: ats.pageData })
      : [];
    const page = await inTab(tab.id, job.ats, 'read', [main ? main.result : null]);
    if (!page || page.error) {
      await report(job.id, 'skipped', (page && page.error) || 'application form not found');
      return 'skipped';
    }
    const plan = oojMatch.planFill(page.fields, ctx.profile, job);
    if (plan.missing.length && ctx.settings.unknowns === 'ai') {
      for (const f of [...plan.missing]) {
        if (f.type === 'file' || oojMatch.isEeo(f)) continue;
        const answer = await answerUnknown(f, job, ctx);
        if (answer === undefined) continue;
        ctx.profile.answers = [...(ctx.profile.answers || []), { question: f.label, answer }];
        plan.missing.splice(plan.missing.indexOf(f), 1);
        plan.fills.push({ ...f, value: answer });
      }
    }
    if (plan.missing.length) {
      for (const f of plan.missing) await addNeeds(f, job);
      await report(job.id, 'skipped', 'needs answer: ' + plan.missing.map((f) => f.label).join('; '));
      return 'skipped';
    }

    try {
      await api('/me/apply/claim', { method: 'POST', body: { job_id: job.id, company: job.company_domain, title: job.title, url: job.url } });
    } catch (e) {
      if (e.status === 402) return 'limit';
      if (e.status === 409) return 'skipped';
      throw e;
    }
    // Claimed from here on, so every way out reports a result.
    try {
      const filled = await inTab(tab.id, job.ats, 'fill', [plan.fills, ctx.cv]);
      if (!filled || filled.errors.length) {
        await report(job.id, 'failed', 'could not fill ' + ((filled && filled.errors.join('; ')) || 'the form'));
        return 'failed';
      }
      if (!(await inTab(tab.id, job.ats, 'submit'))) {
        await report(job.id, 'failed', 'submit button not found');
        return 'failed';
      }
      const result = await waitForOutcome(tab.id, job.ats, page.redirectTo);
      if (result === 'submitted') {
        await report(job.id, 'submitted', '');
        return 'submitted';
      }
      await report(job.id, 'failed', result.failed);
      return result.failed === 'captcha' ? 'captcha' : 'failed';
    } catch (e) {
      await report(job.id, 'failed', String(e.message || e).slice(0, 200));
      return 'failed';
    }
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
  // Only sites with a dedicated filler: the generic one never applies on its own.
  const dedicated = Object.keys(ATS_FILES).filter((n) => n !== 'generic');
  const p = new URLSearchParams({ ats: dedicated.join(','), limit: '25', max_age_days: '14', count: 'skip' });
  if (preferences.skills && preferences.skills.length) p.set('skills', preferences.skills.join(','));
  if (preferences.seniority) p.set('seniority', preferences.seniority);
  if (preferences.workplace && preferences.workplace.length) p.set('workplace', preferences.workplace.join(','));
  if (preferences.country && preferences.country.length) p.set('country', preferences.country.join(','));
  if (preferences.city && preferences.city.length) p.set('city', preferences.city.join(','));
  const { jobs = [] } = await api('/jobs?' + p, { auth: false });
  return jobs.filter((j) => dedicated.includes(j.ats));
}

let running = false;

async function run() {
  if (running) return;
  running = true;
  try {
    const st = await chrome.storage.local.get(['token', 'paused', 'cv', 'ai']);
    if (!st.token || st.paused || !st.cv) return;
    const [{ profile, preferences }, usage, { applied: history }] = await Promise.all([
      api('/me/apply/profile'), api('/me/apply/usage'), api('/me/apply/history?limit=50'),
    ]);
    await chrome.storage.local.set({ authError: false });
    await pruneNeeds(profile.answers);
    const now = Date.now();
    setBadge(oojMatch.appliedToday(history, now));
    const settings = profile.settings || {};
    const guardrails = settings.guardrails || {};
    let left = oojMatch.budget(usage, history, guardrails, now, PER_RUN);
    if (!left) return;

    const ctx = { profile, preferences, settings, cv: st.cv, ai: st.ai, serverAi: ['basic', 'pro'].includes(usage.plan) };
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
      if (outcome === 'submitted') {
        left--;
        history.push({ job_id: job.id, company: job.company_domain, status: 'submitted', at: new Date().toISOString() });
        setBadge(oojMatch.appliedToday(history, Date.now()));
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
  const [{ profile, preferences }, usage, { applied }] = await Promise.all([
    api('/me/apply/profile'), api('/me/apply/usage'), api('/me/apply/history?limit=100'),
  ]);
  accountCache = { at: Date.now(), profile, preferences, usage, history: applied };
  return accountCache;
}

// Whether to offer filling this page, and if not, why: the card always
// says what stands in the way rather than staying silent.
const ACCOUNT_URL = 'https://oceanofjobs.com/account#autoapply';
const NOT_CONNECTED = 'Connect Ocean of Jobs to fill in this application.';
const EXPIRED = 'Your connection has expired. Connect again to continue.';
const NO_CV = 'Add your CV in extension settings before applying.';
const ALREADY = "You've already applied to this job with Ocean of Jobs.";
const UNEXPECTED = 'Something went wrong. Reload the page and try again.';
const READ_ERROR = "Couldn't read the application form on this page.";
const BOT_CHECK = "This site requires you to submit the form yourself. Review your answers and use the site's Submit button.";
const UNREACHABLE = "Couldn't load your Ocean of Jobs account. Try again in a minute.";
async function offerHere(url) {
  const st = await chrome.storage.local.get(['token', 'authError', 'cv']);
  if (!st.token || st.authError) {
    return { show: true, blocked: st.authError ? EXPIRED : NOT_CONNECTED, action: { label: 'Connect account', url: ACCOUNT_URL } };
  }
  // No dedicated filler: fill only, which needs no account check.
  if (!globalThis.oojAts[adapterFor(url)].matches(url)) {
    return st.cv ? { show: true, assist: true } : { show: true, assist: true, blocked: NO_CV, action: { label: 'Add CV', options: true } };
  }
  let a;
  try {
    a = await account();
  } catch (e) {
    if (e.status === 401) return { show: true, blocked: EXPIRED, action: { label: 'Connect account', url: ACCOUNT_URL } };
    return { show: true, blocked: UNREACHABLE };
  }
  if (!((a.profile.settings || {}).sources || []).includes('ats_pages')) {
    return { show: true, blocked: 'Turn on "Jobs I open on Greenhouse, Ashby or Workable" under Auto apply on your account, then reload this page.', action: { label: 'Open Auto apply', url: ACCOUNT_URL } };
  }
  if (!st.cv) return { show: true, blocked: NO_CV, action: { label: 'Add CV', options: true } };
  const id = await pageJobId(url);
  if (a.history.some((h) => h.job_id === id && h.status === 'submitted')) return { show: true, blocked: ALREADY };
  return { show: true, remaining: a.usage.remaining };
}

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
    serverAi: ['basic', 'pro'].includes(a.usage.plan) };
  const { plan, suggested } = await planWithSuggestions(page, job, ctx);
  try {
    await api('/me/apply/claim', { method: 'POST', body: { job_id: job.id, company: job.company_domain, title: job.title, url: job.url } });
  } catch (e) {
    if (e.status === 402) return { error: (e.body && e.body.error) || 'Your plan has no applications left.' };
    if (e.status === 409) return { error: ALREADY };
    throw e;
  }
  const result = await fillAndMark(tabId, frameId, name, plan, suggested, ctx.cv);
  const { pendingHere = {} } = await chrome.storage.local.get('pendingHere');
  pendingHere[tabId] = job.id;
  await chrome.storage.local.set({ pendingHere });
  return result;
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
  // Amber: the AI suggested it, check it. Red: still needs the user.
  await chrome.scripting.executeScript({
    target: frameId ? { tabId, frameIds: [frameId] } : { tabId },
    args: [suggested.map((f) => f.name), plan.missing.map((f) => f.name)],
    func: (amber, red) => [[amber, '#e0a43a'], [red, '#ff6b5e']].forEach(([names, color]) => names.forEach((n) => {
      const docs = [document, ...[...document.querySelectorAll('iframe')].map((f) => { try { return f.contentDocument; } catch { return null; } }).filter(Boolean)];
      const el = docs.map((d) => d.querySelector(`[data-ooj-box="${CSS.escape(n)}"]`)).find(Boolean)
        || document.getElementById(n) || document.getElementById(n.replace(/_/g, '-')) || document.querySelector(`[name="${CSS.escape(n)}"]`);
      const box = el && (el.hasAttribute('data-ooj-box') ? el : el.closest('.select__control') || el.closest('fieldset') || el);
      if (box) { box.style.outline = `2px solid ${color}`; box.style.outlineOffset = '2px'; }
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

// "Fill in this page" in the popup, on whatever site the tab shows. The
// popup's click grants activeTab for the page; a form in an iframe is
// reached through the host permissions. No credit is claimed: the user
// reviews and submits the form themselves.
async function fillTab(tabId) {
  const st = await chrome.storage.local.get(['token', 'authError', 'cv']);
  if (!st.token || st.authError) return { error: st.authError ? EXPIRED : NOT_CONNECTED };
  if (!st.cv) return { error: NO_CV };
  let tab = await chrome.tabs.get(tabId);
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
  if (!page || page.openUrl) return { error: 'Application form opened. Click "Fill in this page" again to continue.' };
  return assist(tabId, frameId, name, page, tab.url, tab.title);
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
  const job = { id: await pageJobId(url), url, title: title || '', company_name: u.hostname, company_domain: u.hostname, location: '', ats: name };
  const ctx = { profile: a.profile, preferences: a.preferences, settings: a.profile.settings || {}, cv: st.cv, ai: st.ai,
    serverAi: ['basic', 'pro'].includes(a.usage.plan) };
  const { plan, suggested } = await planWithSuggestions(page, job, ctx);
  const result = await fillAndMark(tabId, frameId, name, plan, suggested, ctx.cv);
  return { ...result, ats: name, fields: page.fields.length, required: page.fields.filter((f) => f.required).length };
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
  let page = await readForm(tabId, 'generic', frameId).catch(() => null);
  let moved = false;
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
  const submit = await inTab(tabId, 'generic', 'submitInfo', [], frameId).catch(() => null);
  const out = { ...r, frameId, url, submit: submit && !submit.botCheck && r.filled > 0 && submit.text, botCheck: !!(submit && submit.botCheck) };
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
  const frameId = msg.frameId != null ? msg.frameId : sender.frameId;
  const info = await inTab(tabId, 'generic', 'submitInfo', [], frameId).catch(() => null);
  if (info && info.botCheck) return { error: BOT_CHECK };
  if (!info || !info.text) return { error: oojMatch.reasonText('submit button not found') };
  const id = await pageJobId(msg.url);
  try {
    await api('/me/apply/claim', { method: 'POST', body: { job_id: id, company: msg.company, title: msg.title, url: msg.url } });
  } catch (e) {
    if (e.status === 402) return { error: (e.body && e.body.error) || 'Your plan has no applications left.' };
    if (e.status === 409) return { error: ALREADY };
    throw e;
  }
  accountCache = null;
  // Claimed from here on, so every way out reports a result.
  let out;
  try {
    const before = await inTab(tabId, 'generic', 'submit', [], frameId);
    out = before ? await watchHere(tabId, frameId, before) : { failed: 'submit button not found' };
  } catch (e) {
    out = { failed: String(e.message || e).slice(0, 200) };
  }
  if (out === 'submitted') {
    await report(id, 'submitted', '');
    return { submitted: true };
  }
  await report(id, 'failed', out ? out.failed : 'no confirmation');
  return out ? { failed: out.failed } : { unknown: true };
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

// The AI's best answer for a page the user will review: our server on
// Basic and Pro, else the user's own key. Not saved as a saved answer.
async function suggestAnswer(field, job, ctx) {
  if (ctx.serverAi) {
    try {
      const { answer } = await api('/me/apply/draft', {
        method: 'POST',
        body: { question: field.label, options: field.options || [], mode: 'suggest',
          job: { title: job.title, company: job.company_name, location: job.location } },
      });
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
      supported: !!(job && globalThis.oojAts[job.ats] && globalThis.oojAts[job.ats].matches(job.url)),
    };
  }));
  return { total: queue.length, items };
}

// The user submitted a form we filled, or closed it without submitting.
async function settleHere(tabId, status, reason) {
  const { pendingHere = {} } = await chrome.storage.local.get('pendingHere');
  const id = pendingHere[tabId];
  if (!id) return;
  delete pendingHere[tabId];
  await chrome.storage.local.set({ pendingHere });
  accountCache = null;
  await report(id, status, reason);
}

chrome.tabs.onRemoved.addListener((tabId) => settleHere(tabId, 'skipped', 'not submitted'));

async function status() {
  const st = await chrome.storage.local.get(['token', 'paused', 'cv', 'needs', 'authError', 'lastRun', 'lastError']);
  const out = {
    connected: !!st.token && !st.authError, authError: !!st.authError, paused: !!st.paused,
    hasCv: !!st.cv, needs: st.needs || [], lastRun: st.lastRun || null, lastError: st.lastError || null,
  };
  if (!out.connected) return out;
  try {
    const [usage, { applied }] = await Promise.all([api('/me/apply/usage'), api('/me/apply/history?limit=50')]);
    out.usage = usage;
    out.appliedToday = oojMatch.appliedToday(applied, Date.now());
    setBadge(out.appliedToday);
  } catch (e) {
    if (e.status === 401) { out.connected = false; out.authError = true; }
  }
  return out;
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

chrome.runtime.onInstalled.addListener(() => { schedule(); syncAllSites(); });
chrome.runtime.onStartup.addListener(schedule);
chrome.permissions.onAdded.addListener(syncAllSites);
chrome.permissions.onRemoved.addListener(syncAllSites);
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'run') run(); });

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
    api('/me/apply/answers', { method: 'POST', body: { question: msg.question, answer: msg.answer } }).then(async () => {
      const { needs = [] } = await chrome.storage.local.get('needs');
      const done = needs.find((n) => n.question === msg.question);
      const left = needs.filter((n) => n.question !== msg.question);
      await chrome.storage.local.set({ needs: left });
      accountCache = null;
      // A board job with nothing else to answer goes back in the queue; a
      // page that is not on the board answers 404, which is fine.
      let requeued = false;
      if (done && done.job_id && !left.some((n) => n.job_id === done.job_id)) {
        requeued = await api(`/me/apply/queue/${encodeURIComponent(done.job_id)}`, { method: 'PUT' }).then(() => true, () => false);
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
  if (msg.type === 'fillTab') {
    fillTab(msg.tabId).catch(() => ({ error: "Couldn't fill in this page. Reload it and try again." })).then(reply);
    return true;
  }
  if (msg.type === 'confirmedHere') { settleHere(sender.tab.id, 'submitted', '').then(() => reply({ ok: true })); return true; }
  return false;
});
