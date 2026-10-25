const $ = (id) => document.getElementById(id);
const ACCOUNT = 'https://oceanofjobs.com/apply';
const { plural, reasonText, filledText } = oojMatch;

// Settings open in the popup itself, in place of the main view.
let settingsMounted = false;
function showSettings() {
  for (const id of ['head', 'out', 'in']) $(id).hidden = true;
  $('settings-view').hidden = false;
  if (!settingsMounted) oojSettings.mount($('settings-view'), { inPopup: true, onBack: hideSettings });
  settingsMounted = true;
}
function hideSettings() {
  $('settings-view').hidden = true;
  $('head').hidden = false;
  chrome.runtime.sendMessage({ type: 'status' }).then(render);
}
$('gear').addEventListener('click', showSettings);
for (const a of document.querySelectorAll('.open-options')) {
  a.addEventListener('click', (e) => { e.preventDefault(); showSettings(); });
}

// Once, for people whose settings an older version kept in this browser:
// the offer to move them to the account. Keep it local hides it for good;
// the switch in Settings still works.
async function offerMove() {
  const [{ moveDismissed }, st] = await Promise.all([chrome.storage.local.get('moveDismissed'), chrome.runtime.sendMessage({ type: 'storageState' })]);
  $('move').hidden = !(st && !st.error && st.connected && st.ready && st.mode === 'local' && st.cv && !moveDismissed);
}
$('move-agree').addEventListener('change', (e) => { $('move-yes').disabled = !e.target.checked; });
$('move-no').addEventListener('click', () => { chrome.storage.local.set({ moveDismissed: true }); $('move').hidden = true; });
$('move-yes').addEventListener('click', async () => {
  $('move-yes').disabled = true;
  const r = await chrome.runtime.sendMessage({ type: 'storageMode', mode: 'account', consent: true });
  if (r && r.error) {
    $('move-msg').textContent = r.error;
    $('move-msg').hidden = false;
    $('move-yes').disabled = false;
    return;
  }
  $('move').hidden = true;
});
$('ver').textContent = 'v' + chrome.runtime.getManifest().version;
$('connect').addEventListener('click', () => chrome.tabs.create({ url: ACCOUNT }));
// The dashboard connects the extension by itself once the reader has
// logged in, so a second device picks up the same queue in one step.
$('login').addEventListener('click', (e) => { e.preventDefault(); chrome.tabs.create({ url: ACCOUNT + '?connect=1' }); });

// On a site outside our host permissions, the first click also asks for
// access to every site. Asked once: after a no, only Settings asks again.
const ALL_SITES = 'https://*/*';
let ask = false;
chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
  if (!tab || !/^https:/.test(tab.url || '')) return;
  const { allSitesAsked } = await chrome.storage.local.get('allSitesAsked');
  ask = !allSitesAsked && !(await chrome.permissions.contains({ origins: [new URL(tab.url).origin + '/*'] }));
  $('fill-why').hidden = !ask;
});

// The fill button says what it would do on this tab. Opening the popup
// grants access to the tab (activeTab), so the page is read before any
// click; nothing is filled until the click.
const FILL = {
  checking: ['Checking this page…', true],
  none: ['No application found', true],
  form: ['Fill application', false],
  unsupported: ["This site isn't supported", true],
  filling: ['Filling application…', true],
  review: ['Review answers', false],
  done: ['Ready to review', true],
};
let fillState = 'checking';
function setFill(state) {
  fillState = state;
  $('fill').textContent = FILL[state][0];
  $('fill').disabled = FILL[state][1];
}
const activeTab = () => chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => t);
// The popup closes when the user clicks into the page, so a fill is
// remembered per tab (and address) for "Review answers" next time.
const filledKey = (tab) => `filled:${tab.id}`;

async function detect() {
  const tab = await activeTab();
  if (!tab) return setFill('none');
  const { [filledKey(tab)]: filled } = await chrome.storage.session.get(filledKey(tab));
  if (filled && filled.url === tab.url) return setFill(filled.review ? 'review' : 'done');
  const r = await chrome.runtime.sendMessage({ type: 'pageState', tabId: tab.id }).catch(() => null);
  setFill((r && r.state) || 'none');
}

async function review() {
  const tab = await activeTab();
  const { [filledKey(tab)]: filled = {} } = await chrome.storage.session.get(filledKey(tab));
  const r = await chrome.runtime.sendMessage({ type: 'reviewFields', tabId: tab.id, frameId: filled.frameId || 0 }).catch(() => null);
  const out = $('fill-result');
  out.className = 'note ok';
  out.hidden = false;
  if (!r || !r.left) {
    await chrome.storage.session.set({ [filledKey(tab)]: { ...filled, review: false } });
    setFill('done');
    out.textContent = "You're all caught up. Review the form, then submit it.";
    return;
  }
  const what = r.kind === 'required' ? 'This required field is still empty.' : 'AI suggested this answer. Check it before submitting.';
  out.textContent = `${what} ${r.index} of ${r.left} to review.`;
}

$('fill').addEventListener('click', async () => {
  if (fillState === 'review') return review();
  // Before any await: Chrome shows the prompt only during the click.
  const asking = ask && chrome.permissions.request({ origins: [ALL_SITES] });
  if (asking) {
    ask = false;
    // Saved before the answer, since the prompt can close the popup.
    chrome.storage.local.set({ allSitesAsked: true });
    await asking.catch(() => false);
    $('fill-why').hidden = true;
  }
  const out = $('fill-result');
  setFill('filling');
  out.hidden = true;
  const tab = await activeTab();
  const r = tab ? await chrome.runtime.sendMessage({ type: 'fillTab', tabId: tab.id }) : { error: 'No application form found on this page.' };
  out.className = !r || r.error ? 'note error' : 'note ok';
  out.textContent = !r || r.error ? reasonText((r && r.error) || "Couldn't fill in this page. Reload it and try again.") : filledText(r);
  out.hidden = false;
  if (!r || r.error) return detect();
  const needsLook = r.missing.length > 0 || r.suggested > 0;
  const now = await activeTab();
  await chrome.storage.session.set({ [filledKey(now)]: { url: now.url, frameId: r.frameId || 0, review: needsLook } });
  setFill(needsLook ? 'review' : 'done');
});

let paused = false;
$('pause').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'pause', paused: !paused });
  render(await chrome.runtime.sendMessage({ type: 'status' }));
});

function render(s) {
  $('out').hidden = s.connected;
  $('in').hidden = !s.connected;
  if (!s.connected) {
    $('out-text').textContent = s.authError
      ? 'Your connection has expired. Your account and saved information are still there. Connect again to keep using the extension.'
      : 'Connect your Ocean of Jobs account to start applying.';
    return;
  }
  paused = s.paused;
  $('no-cv').hidden = s.hasCv;
  if (s.usage) {
    $('plan').textContent = `${s.usage.plan[0].toUpperCase()}${s.usage.plan.slice(1)}`;
    $('plan').hidden = false;
    $('left-label').textContent = `${plural(s.usage.remaining, 'application')} left ${s.usage.period === 'day' ? 'today' : 'this month'}`;
    $('left').textContent = String(s.usage.remaining);
  }
  $('today').textContent = s.appliedToday == null ? '…' : String(s.appliedToday);
  $('today-label').textContent = `${plural(s.appliedToday || 0, 'application')} submitted today`;
  $('needs').textContent = String(s.needs.length);
  $('needs-label').textContent = `${plural(s.needs.length, 'needs', 'need')} your attention`;
  const list = $('needs-list');
  // Grouped by the job that asked, answered right here: the answer goes to
  // the account's saved answers, and a job with nothing left to answer is
  // queued again for the next run.
  const jobs = new Map();
  for (const n of s.needs) {
    const k = n.job_id || n.url || n.question;
    if (!jobs.has(k)) jobs.set(k, { n, qs: [] });
    jobs.get(k).qs.push(n);
  }
  list.replaceChildren(...[...jobs.values()].slice(0, 5).flatMap(({ n: first, qs }) => [jobHead(first), ...qs.map(needItem)]));
  function jobHead(n) {
    const li = document.createElement('li');
    li.className = 'need-job';
    const a = document.createElement('a');
    a.href = n.link || '#';
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = [n.title, n.company].filter(Boolean).join(' · ') || 'A job';
    li.append(a);
    return li;
  }
  function needItem(n) {
    const li = document.createElement('li');
    const q = document.createElement('span');
    q.textContent = n.question;
    const row = document.createElement('form');
    row.className = 'answer-row';
    const input = document.createElement('input');
    input.placeholder = 'Your answer';
    // The AI's draft, waiting for the user to approve or change it.
    input.value = n.draft || '';
    input.setAttribute('aria-label', `Answer: ${n.question}`);
    const save = document.createElement('button');
    save.className = 'btn';
    save.textContent = 'Save answer';
    row.append(input, save);
    row.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!input.value.trim()) return input.focus();
      save.disabled = true;
      const r = await chrome.runtime.sendMessage({ type: 'answer', question: n.question, answer: input.value.trim(), job_id: n.job_id });
      if (r && r.ok) return render(await chrome.runtime.sendMessage({ type: 'status' }));
      save.disabled = false;
      const err = li.querySelector('.answer-error') || li.appendChild(document.createElement('span'));
      err.className = 'answer-error';
      err.textContent = "Couldn't save your answer. Try again.";
    });
    li.append(q, row);
    return li;
  }
  list.hidden = $('needs-head').hidden = $('needs-help').hidden = !s.needs.length;
  $('pause').textContent = paused ? 'Resume' : 'Pause';
  $('state').textContent = paused
    ? "Auto apply is paused. The extension won't apply to jobs automatically until you resume it."
    : s.lastRun ? `Last checked ${new Date(s.lastRun).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Not checked yet';
}

// The queue: the count on open, the jobs once expanded.
async function renderQueue() {
  const q = await chrome.runtime.sendMessage({ type: 'queue' });
  const note = $('queue-note');
  if (!q || q.error) {
    $('queue-n').textContent = '';
    note.textContent = "Couldn't load your queue. Try again.";
    note.hidden = false;
    return;
  }
  $('queue-n').textContent = `(${q.total})`;
  $('queue-list').replaceChildren(...q.items.map((j) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `https://oceanofjobs.com/job/${encodeURIComponent(j.id)}`;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = j.title;
    const sub = document.createElement('small');
    sub.textContent = j.supported ? j.company : reasonText('unsupported site');
    if (!j.supported) sub.className = 'warn';
    a.append(sub);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.textContent = 'Remove';
    rm.addEventListener('click', async () => {
      rm.disabled = true;
      await chrome.runtime.sendMessage({ type: 'unqueue', id: j.id });
      renderQueue();
    });
    li.append(a, rm);
    return li;
  }));
  note.hidden = q.total > 0 && q.total <= q.items.length;
  note.textContent = q.total ? `Showing the first ${q.items.length} ${plural(q.items.length, 'job')}.` : 'Your queue is empty. Add jobs on Ocean of Jobs or through your AI assistant.';
}

chrome.runtime.sendMessage({ type: 'status' }).then((s) => {
  render(s);
  if (s.connected) {
    renderQueue();
    detect();
    offerMove();
  }
});
