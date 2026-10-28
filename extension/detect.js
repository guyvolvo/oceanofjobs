// The fill button, top right on a page with an application form. On a
// form a dedicated filler knows (Greenhouse, Ashby, Workable) the card
// fills it, then submits it from the card; the credit counts only once
// sent, and only when the account has "Jobs I open on supported hiring sites"
// turned on. On any other form the card fills, and submits too when the
// form has one clear submit button; that credit counts only when the site
// confirms. On those sites a job posting whose Apply button opens the
// form gets the button as well. Nothing goes over the network until the
// button is clicked, and pages without a form get nothing at all.
(function () {
  if (window.__oojDetect) return;
  window.__oojDetect = true;
  const all = globalThis.oojAts || {};
  const { reasonText, filledText, sentText, plural, SUBMITTED, UNCONFIRMED: UNCONFIRMED_TEXT } = globalThis.oojMatch;
  const UNEXPECTED = 'Something went wrong. Reload the page and try again.';
  // Why Full automatic stopped after filling, as a sentence before what to do next.
  const held = (r) => (r.held ? reasonText(r.held) + ' ' : '');
  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);
  const site = Object.keys(all).find((n) => n !== 'generic' && all[n].onSite(location.href));

  // The confirmation page after a form we filled: tell the extension.
  if (site && all[site].outcome() === 'submitted') {
    send({ type: 'settleHere', result: 'submitted' });
    return;
  }
  const dedicated = site && all[site].matches(location.href) ? all[site] : null;
  const isTop = window === window.top;
  let shown = false;

  // A form in an iframe shows its button on the page around it, where the
  // user sees it, and the fill goes to that frame. A fill that followed a
  // posting's Apply link to this page shows its result here.
  if (isTop) {
    chrome.runtime.onMessage.addListener((msg, sender, reply) => {
      if (msg.type === 'formBelow') show({ frameId: msg.frameId, url: msg.url });
      else if (msg.type === 'fillFromApply') {
        // /apply opened this job: start the card's fill, as a click would.
        const go = built && built.root.querySelector('.go');
        const ready = !!go && !go.disabled && !go.hidden && go.textContent === 'Fill application';
        if (ready) go.click();
        reply(ready);
        return false;
      } else if (msg.type === 'filledHere') {
        show({ frameId: msg.result.frameId, url: msg.result.url }, msg.result).then(reply);
        return true;
      } else return false;
      reply({ ok: true });
      return false;
    });
  }

  // A form that asks for a CV, or any form on a page that says it is about
  // a job. On a site no dedicated filler knows, also a job posting whose
  // Apply button opens the form.
  // Some forms keep a hidden "Application submitted" heading ready.
  const heading = () => ([...document.querySelectorAll('h1')].find((h) => h.checkVisibility()) || {}).textContent || '';
  function look() {
    if (shown || !all.generic) return shown;
    if (globalThis.oojMatch.notJobSite(location.hostname)) return false;
    const p = all.generic.formHere();
    // Our own name is no job word: Dodo's checkout and receipts carry
    // "Ocean of Jobs auto apply".
    const jobish = () => globalThis.oojMatch.jobish((location.href + ' ' + document.title + ' ' + heading()).replace(/ocean ?of ?jobs/gi, ''));
    // A sign-up, contact or checkout form (only name, email, phone,
    // address, card) is no application, whatever the page says.
    const form = p.score > 0 && (p.file || dedicated || (!p.contactOnly && jobish()));
    if (!form && !(isTop && !site && all.generic.postingHere() && jobish())) return false;
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
  // With a result, the card opens on it. False when nothing shows yet.
  let building = false;
  let built = null;
  async function show(target, result) {
    if (!built) await build(target);
    if (!built || !result) return !!built;
    built.open();
    filled(built.root, result, target);
    return true;
  }

  async function build(target) {
    if (building || (shown && target.frameId == null)) return;
    building = shown = true;
    if (await send({ type: 'hidden', host: location.hostname })) return;
    const icon = (await send({ type: 'icon' })) || '';
    const name = dedicated ? 'Apply with Ocean of Jobs' : 'Fill with Ocean of Jobs';
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
      .frame { margin: 10px 0 0; font-size: 12px; color: #9a9ca3; }
      .link { border: 0; padding: 0; background: none; color: #f2f0ef; font: inherit; text-decoration: underline; cursor: pointer; }
      .warn { color: #ff6b5e; }
      .ok { color: #2fae60; }
    </style>
    <button class="fab" aria-label="${name}" title="${name}"><img src="${icon}" alt=""></button>
    <div class="c" role="dialog" aria-label="${name}" hidden>
      <div class="h"><img src="${icon}" alt=""><span class="t">${name}</span><button class="x" aria-label="Close">×</button></div>
      <p class="msg"></p>
      <button class="go">Fill application</button>
      <p class="frame" hidden>To show this card at the top of careers pages, allow access to all sites in <button class="link">Settings</button>.</p>
      <button class="hide">Hide on this site until Chrome restarts</button>
    </div>`;
    document.documentElement.appendChild(host);
    const fab = root.querySelector('.fab');
    const c = root.querySelector('.c');
    root.querySelector('.hide').addEventListener('click', () => { send({ type: 'hide', host: location.hostname }); host.remove(); });
    root.querySelector('.x').addEventListener('click', () => { c.hidden = true; fab.hidden = false; fab.focus(); });
    let ready = false;
    const open = () => {
      fab.hidden = true;
      c.hidden = false;
      const first = !ready;
      ready = true;
      return first;
    };
    // A card that said what stands in the way (not connected, no resume)
    // asks again when reopened and when the account changes, so
    // connecting in another tab clears it without a page reload.
    let blocked = false;
    const ask = async () => {
      const offer = await send({ type: 'offerHere', url: target.url }) || { blocked: UNEXPECTED };
      const go = root.querySelector('.go');
      const fresh = go.cloneNode(false); // drops the old click handler
      fresh.hidden = fresh.disabled = false;
      fresh.textContent = 'Fill application';
      go.replaceWith(fresh);
      const msg = root.querySelector('.msg');
      msg.className = 'msg';
      msg.textContent = '';
      blocked = !!offer.blocked;
      card(root, offer, target);
    };
    fab.addEventListener('click', () => { if (open() || blocked) ask(); });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (blocked && area === 'local' && (changes.token || changes.authError || changes.cv)) ask();
    });
    // Drawn inside a form's frame only when the page around it has no
    // Ocean of Jobs access, which Settings can grant.
    if (!isTop) {
      root.querySelector('.frame').hidden = false;
      root.querySelector('.link').addEventListener('click', () => send({ type: 'openOptions' }));
    }
    built = { root, open };
    // Opened straight away: the user came here to apply.
    fab.click();
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
      msg.textContent = 'Fill in this application with your profile. Review your answers before submitting.';
      go.addEventListener('click', async () => {
        go.disabled = true;
        go.textContent = 'Filling application…';
        const r = await send({ type: 'fillHere', url: target.url, frameId: target.frameId, title });
        if (!r || r.error) {
          msg.className = 'msg warn';
          msg.textContent = reasonText((r && r.error) || UNEXPECTED);
          go.disabled = false;
          go.textContent = 'Try again';
          return;
        }
        filled(root, r, target);
      });
      return;
    }
    dedicatedCard(root, offer, title, msg, go);
  }

  // After a fill on a site no dedicated filler knows. With one clear
  // submit button on the form, the card sends it: the credit is claimed
  // first and given back unless the site confirms within 20 seconds. In
  // Full automatic (r.auto) the card presses its own Submit once.
  function filled(root, r, target) {
    const msg = root.querySelector('.msg');
    const old = root.querySelector('.go');
    const go = old.cloneNode(true);
    old.replaceWith(go);
    const to = { frameId: r.frameId != null ? r.frameId : target.frameId, url: r.url || target.url };
    msg.className = 'msg ok';
    msg.textContent = filledText(r) + ' ' + held(r)
      + (r.submit ? 'Review your answers, then submit the application here.'
        + (r.botCheck ? " If the site's human check stops it, use the site's Submit button." : '')
        : r.botCheck ? "Review your answers, then use the site's Submit button."
          : 'Review your answers, then submit the application on the page.');
    go.hidden = !r.submit;
    go.disabled = false;
    go.textContent = 'Submit application';
    let auto = !!r.auto;
    go.addEventListener('click', async () => {
      if (go.disabled) return;
      go.disabled = true;
      go.textContent = 'Submitting…';
      const title = String(heading() || document.title).trim().slice(0, 300);
      const s = await send({ type: 'submitHere', url: to.url, frameId: to.frameId, title, company: location.hostname, auto });
      auto = false; // a press after this one is the user's own
      msg.className = s && s.submitted ? 'msg ok' : 'msg warn';
      msg.textContent = sentText(s);
      // Pressing again could send it twice.
      if (s && (s.submitted || s.unknown)) {
        go.hidden = true;
        return;
      }
      go.disabled = false;
      go.textContent = 'Submit application';
    });
    if (auto) go.click();
  }

  function dedicatedCard(root, offer, title, msg, go) {
    const ats = dedicated;
    go.textContent = 'Fill application';
    msg.textContent = 'Fill in the application with your profile, review your answers, then submit it here.'
      + (offer.remaining != null ? ` ${offer.remaining} ${plural(offer.remaining, 'application')} left on your plan.` : '');
    let submitting = false;
    let auto = false;
    go.addEventListener('click', async () => {
      if (submitting) return;
      go.disabled = true;
      go.textContent = 'Filling application…';
      const company = new URL(location.href).searchParams.get('for') || location.pathname.split('/')[1] || '';
      const where = (document.querySelector('.job__location, .location, [class*="location"]') || {}).textContent || '';
      const r = await send({ type: 'fillHere', url: location.href, title, company, location: where.trim().slice(0, 200) });
      if (!r || r.error) {
        msg.className = 'msg warn';
        msg.textContent = reasonText((r && r.error) || UNEXPECTED);
        go.disabled = false;
        go.textContent = 'Try again';
        return;
      }
      msg.className = 'msg ok';
      msg.textContent = filledText(r) + ' ' + held(r) + 'Review your answers, then submit the application here.';
      // The same button now submits; one listener, so a second click can't fill again.
      submitting = true;
      go.disabled = false;
      go.textContent = 'Submit application';
      // Full automatic: Submit is pressed once for the user.
      auto = !!r.auto;
      if (auto) go.click();
    });
    go.addEventListener('click', async () => {
      if (!submitting || go.disabled) return;
      go.disabled = true;
      go.textContent = 'Submitting…';
      // The server reserves a credit and must acknowledge before the site's
      // button is pressed. No acknowledgement, no click.
      const company = new URL(location.href).searchParams.get('for') || location.pathname.split('/')[1] || '';
      const ok = await send({ type: 'startSubmit', url: location.href, title, company, auto });
      auto = false;
      if (!ok || !ok.ok) {
        msg.className = 'msg warn';
        msg.textContent = ok && ok.review ? sentText(ok) : reasonText((ok && ok.error) || UNEXPECTED);
        go.disabled = false;
        go.textContent = 'Submit application';
        return;
      }
      if (!(await ats.submit())) {
        send({ type: 'settleHere', result: { failed: 'submit button not found' } });
        msg.className = 'msg warn';
        msg.textContent = reasonText('submit button not found');
        go.hidden = true;
        return;
      }
      const started = Date.now();
      const watch = setInterval(() => {
        const out = ats.outcome();
        if (out === 'submitted') {
          clearInterval(watch);
          send({ type: 'settleHere', result: 'submitted' });
          msg.className = 'msg ok';
          msg.textContent = SUBMITTED;
          go.hidden = true;
        } else if ((out && out.failed) || Date.now() - started > 30000) {
          clearInterval(watch);
          send({ type: 'settleHere', result: out && out.failed ? out : null });
          msg.className = 'msg warn';
          if (out && /^form errors/i.test(out.failed)) {
            // The site's own errors: nothing was sent and the credit is back.
            msg.textContent = `Not submitted: ${reasonText(out.failed).replace(/\.$/, '')}. Fix the issue on the form, then try again.`;
            go.disabled = false;
            go.textContent = 'Submit application';
          } else {
            // Pressing again could send it twice, so the button goes.
            msg.textContent = UNCONFIRMED_TEXT;
            go.hidden = true;
          }
        }
      }, 1000);
    });
  }
})();
