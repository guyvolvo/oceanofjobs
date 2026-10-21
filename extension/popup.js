const $ = (id) => document.getElementById(id);
const ACCOUNT = 'https://oceanofjobs.com/apply';
const { plural, reasonText, filledText } = oojMatch;

for (const a of document.querySelectorAll('.open-options')) {
  a.addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
}
$('connect').addEventListener('click', () => chrome.tabs.create({ url: ACCOUNT }));

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
  none: ['No application detected', true],
  form: ['Fill application', false],
  unsupported: ["This site isn't supported", true],
  filling: ['Filling application…', true],
  review: ['Review filled fields', false],
  done: ['Application filled', true],
};
let fillState = 'checking';
function setFill(state) {
  fillState = state;
  $('fill').textContent = FILL[state][0];
  $('fill').disabled = FILL[state][1];
}
const activeTab = () => chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => t);
// The popup closes when the user clicks into the page, so a fill is
// remembered per tab (and address) for "Review filled fields" next time.
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
    out.textContent = 'Nothing left to check. Look over the form, then submit it.';
    return;
  }
  const what = r.kind === 'required' ? 'Required field, still empty.' : 'Answer suggested by AI. Check it before you submit.';
  out.textContent = `${what} ${r.index} of ${r.left} to check.`;
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
      ? 'Your connection has expired. Connect your account again to continue.'
      : 'Connect the extension to your Ocean of Jobs account to start applying for jobs.';
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
  $('needs').textContent = String(s.needs.length);
  $('needs-label').textContent = `${plural(s.needs.length, 'needs', 'need')} your input`;
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
    input.setAttribute('aria-label', `Answer: ${n.question}`);
    const save = document.createElement('button');
    save.className = 'btn';
    save.textContent = 'Save';
    row.append(input, save);
    row.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!input.value.trim()) return input.focus();
      save.disabled = true;
      const r = await chrome.runtime.sendMessage({ type: 'answer', question: n.question, answer: input.value.trim(), job_id: n.job_id });
      if (r && r.ok) return render(await chrome.runtime.sendMessage({ type: 'status' }));
      save.disabled = false;
      save.textContent = 'Try again';
    });
    li.append(q, row);
    return li;
  }
  list.hidden = $('needs-head').hidden = $('needs-help').hidden = !s.needs.length;
  $('pause').textContent = paused ? 'Resume' : 'Pause';
  $('state').textContent = paused
    ? "Auto apply is paused. The extension won't apply on its own until you resume."
    : s.lastRun ? `Last checked ${new Date(s.lastRun).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Not checked yet';
}

// The queue: the count on open, the jobs once expanded.
async function renderQueue() {
  const q = await chrome.runtime.sendMessage({ type: 'queue' });
  const note = $('queue-note');
  if (!q || q.error) {
    $('queue-n').textContent = '';
    note.textContent = "Couldn't load the queue.";
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
  note.textContent = q.total ? `Showing the first ${q.items.length} ${plural(q.items.length, 'job')}.` : 'No jobs in your queue. Add jobs on Ocean of Jobs or through your AI assistant.';
}

chrome.runtime.sendMessage({ type: 'status' }).then((s) => {
  render(s);
  if (s.connected) {
    renderQueue();
    detect();
  }
});
