// On a Greenhouse application form the user is looking at: offer to fill
// it in from their Ocean of Jobs profile. The user checks the form and
// presses Submit themselves; the credit counts only once they do. Runs
// only when the account has "Jobs I view anywhere on the web" turned on.
(function () {
  const gh = globalThis.oojAts && globalThis.oojAts.greenhouse;
  if (!gh || window.__oojDetect) return;
  window.__oojDetect = true;
  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

  // The confirmation page after a form we filled: tell the extension.
  if (gh.outcome() === 'submitted') {
    send({ type: 'confirmedHere' });
    return;
  }

  const formReady = () => document.querySelector('#application-form, #application_form, form input[type="file"]');
  let tries = 0;
  const wait = setInterval(async () => {
    if (++tries > 20) return clearInterval(wait);
    if (!formReady()) return;
    clearInterval(wait);
    const offer = await send({ type: 'offerHere', url: location.href });
    if (offer && offer.show) card(offer);
  }, 500);

  function card(offer) {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      :host { all: initial; }
      .c { width: 300px; padding: 16px; border-radius: 14px; background: #0e0f11; color: #f2f0ef; font: 400 14px/1.45 system-ui, sans-serif;
           box-shadow: 0 12px 32px rgba(0,0,0,.28); border: 1px solid rgba(242,240,239,.12); }
      .h { display: flex; align-items: center; gap: 8px; font-weight: 600; }
      .h img { width: 20px; height: 20px; }
      .x { margin-left: auto; border: 0; background: none; color: #9a9ca3; font-size: 18px; cursor: pointer; line-height: 1; }
      p { margin: 8px 0 12px; color: #b9b4ad; font-size: 13px; }
      button.go { width: 100%; height: 38px; border: 0; border-radius: 999px; background: #f2f0ef; color: #0e0f11; font: 600 14px system-ui, sans-serif; cursor: pointer; }
      button.go:disabled { opacity: .6; cursor: progress; }
      .warn { color: #ff6b5e; }
      .ok { color: #2fae60; }
    </style>
    <div class="c" role="dialog" aria-label="Apply with Ocean of Jobs">
      <div class="h"><img src="${chrome.runtime.getURL('icons/icon-32.png')}" alt="">Apply with Ocean of Jobs<button class="x" aria-label="Close">×</button></div>
      <p class="msg"></p>
      <button class="go">Fill in this application</button>
    </div>`;
    document.documentElement.appendChild(host);
    const msg = root.querySelector('.msg');
    const go = root.querySelector('.go');
    root.querySelector('.x').addEventListener('click', () => host.remove());
    if (offer.blocked) {
      msg.className = 'msg warn';
      msg.textContent = offer.blocked;
      if (!offer.action) go.hidden = true;
      else {
        go.textContent = offer.action.label;
        go.addEventListener('click', () => (offer.action.options ? send({ type: 'openOptions' }) : window.open(offer.action.url, '_blank', 'noopener')));
      }
      return;
    }
    msg.textContent = 'Fill in this application from your profile. You check it and press Submit.'
      + (offer.remaining != null ? ` ${offer.remaining} applications left on your plan.` : '');
    go.addEventListener('click', async () => {
      go.disabled = true;
      go.textContent = 'Filling in…';
      const title = (document.querySelector('h1') || {}).textContent || document.title;
      const company = new URL(location.href).searchParams.get('for') || location.pathname.split('/')[1] || '';
      const r = await send({ type: 'fillHere', url: location.href, title: String(title).trim().slice(0, 300), company });
      if (!r || r.error) {
        msg.className = 'msg warn';
        msg.textContent = (r && r.error) || 'Something went wrong. Reload the page and try again.';
        go.disabled = false;
        go.textContent = 'Try again';
        return;
      }
      msg.className = 'msg ok';
      msg.textContent = r.missing.length
        ? `Filled in ${r.filled} fields. ${r.missing.length} need your answer, outlined on the form. Check everything, then press Submit.`
        : `Filled in ${r.filled} fields. Check everything, then press Submit.`;
      go.hidden = true;
      // A form that confirms without leaving the page.
      const watch = setInterval(() => {
        if (gh.outcome() !== 'submitted') return;
        clearInterval(watch);
        send({ type: 'confirmedHere' });
        msg.textContent = 'Applied. It is in your application history.';
      }, 2000);
    });
  }
})();
