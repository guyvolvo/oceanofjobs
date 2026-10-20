importScripts('lib/match.js', 'ats/greenhouse.js');

const API = 'https://oceanofjobs.com/api';
const PER_RUN = 3;
const RUN_MINUTES = 15;
const ATS_FILES = { greenhouse: ['lib/match.js', 'ats/greenhouse.js'] };

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

const report = (job_id, status, reason) =>
  api('/me/apply/result', { method: 'POST', body: { job_id, status, reason } }).catch(() => {});

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
  const facts = {
    name: `${c.first_name || ''} ${c.last_name || ''}`.trim(), location: c.location,
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
async function inTab(tabId, ats, method, args = []) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ATS_FILES[ats] });
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
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
  const tab = await chrome.tabs.create({ url: job.url, active: false });
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
  const p = new URLSearchParams({ ats: 'greenhouse', limit: '25', max_age_days: '14', count: 'skip' });
  if (preferences.skills && preferences.skills.length) p.set('skills', preferences.skills.join(','));
  if (preferences.seniority) p.set('seniority', preferences.seniority);
  if (preferences.workplace && preferences.workplace.length) p.set('workplace', preferences.workplace.join(','));
  if (preferences.country && preferences.country.length) p.set('country', preferences.country.join(','));
  if (preferences.city && preferences.city.length) p.set('city', preferences.city.join(','));
  const { jobs = [] } = await api('/jobs?' + p, { auth: false });
  return jobs.filter((j) => j.ats === 'greenhouse');
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
    const screen = { history, guardrails, now, retrySkipped: queueMode, minMatch: queueMode ? null : guardrails.min_match };
    let jobs = [];
    if (queueMode) {
      const { queue = [] } = await api('/me/apply/queue');
      for (const item of queue) {
        if (jobs.length >= left) break;
        const job = await fetchJob(item.job_id);
        const why = !job ? 'job not found' : job.closed_at ? 'job closed' : oojMatch.screenJob(job, screen);
        if (why) {
          await report(item.job_id, 'skipped', why);
          await api(`/me/apply/queue/${encodeURIComponent(item.job_id)}`, { method: 'DELETE' }).catch(() => {});
          continue;
        }
        jobs.push(job);
      }
    } else {
      jobs = oojMatch.pickJobs(await autoCandidates(preferences), screen);
    }

    for (const job of jobs) {
      if (left <= 0) break;
      const outcome = await applyTo(job, ctx);
      if (outcome === 'limit') break;
      if (queueMode) await api(`/me/apply/queue/${encodeURIComponent(job.id)}`, { method: 'DELETE' }).catch(() => {});
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

chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'run') run(); });

chrome.storage.onChanged.addListener((changes) => {
  // A fresh token from the website: start soon instead of waiting 15 minutes.
  if (changes.token && changes.token.newValue) chrome.alarms.create('run', { periodInMinutes: RUN_MINUTES, delayInMinutes: 0.5 });
  if (changes.token && !changes.token.newValue) setBadge(0);
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (msg.type === 'status') { status().then(reply); return true; }
  if (msg.type === 'pause') { chrome.storage.local.set({ paused: !!msg.paused }).then(() => reply({ ok: true })); return true; }
  return false;
});
