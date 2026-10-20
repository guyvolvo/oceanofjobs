const $ = (id) => document.getElementById(id);
const ACCOUNT = 'https://oceanofjobs.com/account#autoapply';

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

// Fills the form in the tab the popup was opened on. Opening the popup
// is what grants access to that tab (activeTab).
$('fill').addEventListener('click', async () => {
  // Before any await: Chrome shows the prompt only during the click.
  const asking = ask && chrome.permissions.request({ origins: [ALL_SITES] });
  if (asking) {
    ask = false;
    // Saved before the answer, since the prompt can close the popup.
    chrome.storage.local.set({ allSitesAsked: true });
    await asking.catch(() => false);
    $('fill-why').hidden = true;
  }
  const btn = $('fill'), out = $('fill-result');
  btn.disabled = true;
  btn.textContent = 'Filling in…';
  out.hidden = true;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const r = tab ? await chrome.runtime.sendMessage({ type: 'fillTab', tabId: tab.id }) : { error: 'No page to fill.' };
  btn.disabled = false;
  btn.textContent = 'Fill in this page';
  out.className = !r || r.error ? 'note error' : 'note ok';
  out.textContent = !r || r.error ? (r && r.error) || 'Something went wrong.' : fillSummary(r);
  out.hidden = false;
});

function fillSummary(r) {
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  let s = `Filled ${n(r.filled, 'field', 'fields')}.`;
  if (r.suggested) s += ` ${n(r.suggested, 'answer', 'answers')} suggested by AI, outlined in amber.`;
  if (r.missing.length) s += ` ${r.missing.length} ${r.missing.length === 1 ? 'needs' : 'need'} your answer, outlined in red.`;
  if (r.errors.length) s += ` ${r.errors.length} could not be filled.`;
  return s + ' Check the form, then submit it yourself.';
}

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
      ? 'Your connection to Ocean of Jobs was revoked or expired.'
      : 'Connect the extension to your Ocean of Jobs account to start applying.';
    $('connect').textContent = s.authError ? 'Reconnect' : 'Connect';
    return;
  }
  paused = s.paused;
  $('no-cv').hidden = s.hasCv;
  if (s.usage) {
    $('plan').textContent = `${s.usage.plan[0].toUpperCase()}${s.usage.plan.slice(1)} plan`;
    $('plan').hidden = false;
    $('left-label').textContent = `of ${s.usage.limit} left ${s.usage.period === 'day' ? 'today' : 'this month'}`;
    $('left').textContent = String(s.usage.remaining);
  }
  $('today').textContent = s.appliedToday == null ? '…' : String(s.appliedToday);
  $('needs').textContent = String(s.needs.length);
  const list = $('needs-list');
  list.replaceChildren(...s.needs.slice(0, 5).map((n) => {
    const li = document.createElement('li');
    li.textContent = n.question;
    return li;
  }));
  list.hidden = $('needs-help').hidden = !s.needs.length;
  $('pause').textContent = paused ? 'Resume' : 'Pause';
  $('state').textContent = paused
    ? 'Paused. Nothing is sent until you resume.'
    : s.lastRun ? `Last checked ${new Date(s.lastRun).toLocaleTimeString()}. Checks every 15 minutes.` : 'Checks every 15 minutes.';
}

// The queue: the count on open, the jobs once expanded.
async function renderQueue() {
  const q = await chrome.runtime.sendMessage({ type: 'queue' });
  const note = $('queue-note');
  if (!q || q.error) {
    $('queue-n').textContent = '';
    note.textContent = 'Could not load the queue.';
    note.hidden = false;
    return;
  }
  $('queue-n').textContent = String(q.total);
  $('queue-list').replaceChildren(...q.items.map((j) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `https://oceanofjobs.com/job/${encodeURIComponent(j.id)}`;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = j.title;
    const sub = document.createElement('small');
    sub.textContent = j.supported ? j.company : `${j.company ? j.company + ' · ' : ''}can't apply on this site yet`;
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
  note.textContent = q.total ? `Showing the first ${q.items.length}.` : 'Nothing queued. Queue jobs from your AI assistant.';
}

chrome.runtime.sendMessage({ type: 'status' }).then((s) => {
  render(s);
  if (s.connected) renderQueue();
});
