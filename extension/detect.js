// The fill button, top right on a page with an application form. On a
// form a dedicated filler knows (Greenhouse, Ashby, Workable) the card
// fills it, then submits it from the card; the credit counts only once
// sent, and only when the account has "Jobs I view anywhere on the web"
// turned on. On any other form the card only fills: the user checks it
// and presses the site's own submit. Nothing goes over the network until
// the button is clicked, and pages without a form get nothing at all.
(function () {
  if (window.__oojDetect) return;
  window.__oojDetect = true;
  const all = globalThis.oojAts || {};
  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);
  const site = Object.keys(all).find((n) => n !== 'generic' && all[n].onSite(location.href));

  // The confirmation page after a form we filled: tell the extension.
  if (site && all[site].outcome() === 'submitted') {
    send({ type: 'confirmedHere' });
    return;
  }
  const dedicated = site && all[site].matches(location.href) ? all[site] : null;
  const isTop = window === window.top;
  let shown = false;

  // A form in an iframe shows its button on the page around it, where the
  // user sees it, and the fill goes to that frame.
  if (isTop) {
    chrome.runtime.onMessage.addListener((msg, sender, reply) => {
      if (msg.type !== 'formBelow') return false;
      show({ frameId: msg.frameId, url: msg.url });
      reply({ ok: true });
      return false;
    });
  }

  // A form that asks for a CV, or any form on a page that says it is about a job.
  const JOBISH = /job|career|apply|application|position|vacanc|opening|recruit|resume|\bcv\b|hiring|talent|bewerb|stelle|emploi|empleo|משר|דרוש/i;
  function look() {
    if (shown || !all.generic) return shown;
    const p = all.generic.formHere();
    if (!(p.score > 0 && (p.file || dedicated || JOBISH.test(location.href + ' ' + document.title)))) return false;
    found();
    return true;
  }

  async function found() {
    if (!isTop && !dedicated) {
      shown = true;
      const r = await send({ type: 'formBelow' });
      if (r && r.shown) return;
      shown = false;
    }
    show({ frameId: null, url: location.href });
  }

  let tries = 0;
  const wait = setInterval(() => { if (look() || ++tries >= 20) clearInterval(wait); }, 500);
  // A form that opens from an Apply button later on.
  const onClick = () => setTimeout(() => { if (look()) document.removeEventListener('click', onClick, true); }, 1500);
  document.addEventListener('click', onClick, true);

  // Just below the top right corner, moved down past the site's own
  // links and buttons there.
  function topOffset() {
    const x = document.documentElement.clientWidth - 16 - 20;
    for (let y = 16; y <= 160; y += 8) {
      const busy = [[0, 20], [-18, 4], [18, 4], [-18, 36], [18, 36]].some(([dx, dy]) => {
        const el = document.elementFromPoint(x + dx, y + dy);
        return el && el.closest('a, button, input, select, textarea, [role="button"], [role="link"], [onclick]');
      });
      if (!busy) return y;
    }
    return 16;
  }

  // The page's own form and one in a frame below can both ask for it.
  let building = false;
  async function show(target) {
    if (building || (shown && target.frameId == null)) return;
    building = shown = true;
    if (await send({ type: 'hidden', host: location.hostname })) return;
    const icon = (await send({ type: 'icon' })) || '';
    const host = document.createElement('div');
    host.setAttribute('data-ooj-fill', '');
    host.style.cssText = `position:fixed;top:${topOffset()}px;right:16px;z-index:2147483647;`;
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      :host { all: initial; }
      [hidden] { display: none !important; }
      .fab { display: block; width: 40px; height: 40px; padding: 0; border: 0; border-radius: 50%; background: #0e0f11; cursor: pointer;
             box-shadow: 0 4px 14px rgba(0,0,0,.28); transition: transform 150ms ease, box-shadow 150ms ease; }
      .fab:hover { transform: scale(1.06); box-shadow: 0 6px 18px rgba(0,0,0,.34); }
      .fab:focus-visible, button:focus-visible { outline: 2px solid #2fae60; outline-offset: 2px; }
      .fab img { display: block; width: 40px; height: 40px; border-radius: 50%; }
      .c { width: 300px; padding: 16px; border-radius: 14px; background: #0e0f11; color: #f2f0ef; font: 400 14px/1.45 system-ui, sans-serif;
           box-shadow: 0 12px 32px rgba(0,0,0,.28); border: 1px solid rgba(242,240,239,.12); transform-origin: top right; animation: open 160ms ease-out; }
      @keyframes open { from { opacity: 0; transform: scale(.94) translateY(-6px); } }
      .h { display: flex; align-items: center; gap: 8px; font-weight: 600; }
      .h img { width: 20px; height: 20px; border-radius: 50%; }
      .x { margin-left: auto; border: 0; background: none; color: #9a9ca3; font-size: 18px; cursor: pointer; line-height: 1; }
      p { margin: 8px 0 12px; color: #b9b4ad; font-size: 13px; }
      button.go { width: 100%; height: 38px; border: 0; border-radius: 999px; background: #f2f0ef; color: #0e0f11; font: 600 14px system-ui, sans-serif; cursor: pointer; }
      button.go:disabled { opacity: .6; cursor: progress; }
      .hide { display: block; margin: 10px auto 0; border: 0; background: none; color: #9a9ca3; font: 400 12px system-ui, sans-serif; cursor: pointer; }
      .hide:hover { color: #f2f0ef; }
      .warn { color: #ff6b5e; }
      .ok { color: #2fae60; }
    </style>
    <button class="fab" aria-label="Fill this application with Ocean of Jobs" title="Fill this application with Ocean of Jobs"><img src="${icon}" alt=""></button>
    <div class="c" role="dialog" aria-label="Fill with Ocean of Jobs" hidden>
      <div class="h"><img src="${icon}" alt=""><span class="t">Fill with Ocean of Jobs</span><button class="x" aria-label="Close">×</button></div>
      <p class="msg"></p>
      <button class="go">Fill in this form</button>
      <button class="hide">Hide on this site until Chrome restarts</button>
    </div>`;
    document.documentElement.appendChild(host);
    const fab = root.querySelector('.fab');
    const c = root.querySelector('.c');
    root.querySelector('.hide').addEventListener('click', () => { send({ type: 'hide', host: location.hostname }); host.remove(); });
    root.querySelector('.x').addEventListener('click', () => { c.hidden = true; fab.hidden = false; fab.focus(); });
    let ready = false;
    fab.addEventListener('click', async () => {
      fab.hidden = true;
      c.hidden = false;
      if (ready) return;
      ready = true;
      card(root, await send({ type: 'offerHere', url: target.url }) || { blocked: 'Something went wrong. Reload the page and try again.' }, target);
    });
  }

  function card(root, offer, target) {
    const msg = root.querySelector('.msg');
    const go = root.querySelector('.go');
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
    const title = String((document.querySelector('h1') || {}).textContent || document.title).trim().slice(0, 300);
    if (offer.assist) {
      msg.textContent = 'Fills this form from your profile. Check it, then send it with the site\'s own button.';
      go.addEventListener('click', async () => {
        go.disabled = true;
        go.textContent = 'Filling in…';
        const r = await send({ type: 'fillHere', url: target.url, frameId: target.frameId, title });
        if (!r || r.error) {
          msg.className = 'msg warn';
          msg.textContent = (r && r.error) || 'Something went wrong. Reload the page and try again.';
          go.disabled = false;
          go.textContent = 'Try again';
          return;
        }
        msg.className = 'msg ok';
        msg.textContent = `Filled in ${r.filled} fields.`
          + (r.suggested ? ` ${r.suggested} suggested by AI, outlined in amber.` : '')
          + (r.missing.length ? ` ${r.missing.length} still ${r.missing.length === 1 ? 'needs' : 'need'} your answer, outlined in red.` : '')
          + ' Check the form, then send it yourself.';
        go.hidden = true;
      });
      return;
    }
    const ats = dedicated;
    root.querySelector('.t').textContent = 'Apply with Ocean of Jobs';
    go.textContent = 'Fill in this application';
    msg.textContent = 'Fill in this application from your profile, check it, then submit it from here.'
      + (offer.remaining != null ? ` ${offer.remaining} applications left on your plan.` : '');
    let submitting = false;
    go.addEventListener('click', async () => {
      if (submitting) return;
      go.disabled = true;
      go.textContent = 'Filling in and suggesting answers…';
      const company = new URL(location.href).searchParams.get('for') || location.pathname.split('/')[1] || '';
      const where = (document.querySelector('.job__location, .location, [class*="location"]') || {}).textContent || '';
      const r = await send({ type: 'fillHere', url: location.href, title, company, location: where.trim().slice(0, 200) });
      if (!r || r.error) {
        msg.className = 'msg warn';
        msg.textContent = (r && r.error) || 'Something went wrong. Reload the page and try again.';
        go.disabled = false;
        go.textContent = 'Try again';
        return;
      }
      msg.className = 'msg ok';
      msg.textContent = `Filled in ${r.filled} fields.`
        + (r.missing.length ? ` ${r.missing.length} still ${r.missing.length === 1 ? 'needs' : 'need'} your answer, outlined in red.` : '');
      // The same button now submits; one listener, so a second click can't fill again.
      submitting = true;
      go.disabled = false;
      go.textContent = 'Submit application';
    });
    go.addEventListener('click', async () => {
      if (!submitting || go.disabled) return;
      go.disabled = true;
      go.textContent = 'Submitting…';
      if (!(await ats.submit())) {
        msg.className = 'msg warn';
        msg.textContent = 'Could not find the form\'s submit button. Press it on the form.';
        go.hidden = true;
        return;
      }
      const started = Date.now();
      const watch = setInterval(() => {
        const out = ats.outcome();
        if (out === 'submitted') {
          clearInterval(watch);
          send({ type: 'confirmedHere' });
          msg.className = 'msg ok';
          msg.textContent = 'Applied. It is in your application history.';
          go.hidden = true;
        } else if ((out && out.failed) || Date.now() - started > 30000) {
          clearInterval(watch);
          msg.className = 'msg warn';
          msg.textContent = out && out.failed ? `Not sent: ${out.failed}. Fix it on the form, then press Submit application.` : 'No confirmation yet. Check the form.';
          go.disabled = false;
          go.textContent = 'Submit application';
        }
      }, 1000);
    });
  }
})();
