// Greenhouse filler. Every ATS file registers the same shape on
// globalThis.oojAts[<ats>]:
//   matches(url)            can this file apply to the job at url
//   onSite(url)             is url on this ATS's hosts (where the filler may run)
//   pageData()              optional; runs in the page's own world and
//                           returns a string handed to read()
//   read(data)              {fields, redirectTo} or {error}
//   fill(fills, cv)         {errors}
//   submit()                true once the submit button was clicked
//   outcome()               'submitted', {failed: reason} or null (still waiting)
// The service worker loads it with importScripts for matches(); the rest
// runs in the job tab, injected next to lib/match.js.
(function (root) {
  const HOSTS = ['boards.greenhouse.io', 'job-boards.greenhouse.io'];

  function onSite(url) {
    try { return HOSTS.includes(new URL(url).hostname); } catch { return false; }
  }

  function matches(url) {
    let u;
    try { u = new URL(url); } catch { return false; }
    if (u.protocol !== 'https:' || !HOSTS.includes(u.hostname)) return false;
    if (/^\/[^/]+\/jobs\/\d+\/?$/.test(u.pathname)) return true;
    // The link /api/jobs hands out for Greenhouse jobs (GREENHOUSE_APPLY_URL_SQL).
    return u.pathname === '/embed/job_app' && u.searchParams.has('for') && u.searchParams.has('token');
  }

  const TYPES = {
    input_text: 'text', textarea: 'textarea', input_file: 'file',
    multi_value_single_select: 'select', multi_value_multi_select: 'multiselect',
  };

  // The job-boards app ships the whole form as JSON (window.__remixContext),
  // options included, while the DOM only renders a select's options once
  // its menu is open. So the JSON is the source and the DOM is only typed
  // into. The inline script is gone once React hydrates, and a content
  // script cannot see page globals, hence pageData() in the main world.
  // It also waits until the form can be filled, since the background run
  // starts right at the load event: React has not hydrated yet (a select
  // clicked then never opens), and the CV uploader has no S3 fields until
  // the page fetches them after hydrating (a file attached before fails
  // with "reading 'uploadFile'"). Self-contained because executeScript
  // serialises it.
  async function pageData() {
    if (!window.__remixContext) return null;
    const ready = () => {
      const f = document.getElementById('application-form') || document.querySelector('form');
      if (!f || !Object.keys(f).some((k) => k.startsWith('__react'))) return false;
      return !f.querySelector('input[type="file"]')
        || performance.getEntriesByType('resource').some((e) => e.name.includes('/presigned_fields'));
    };
    // Bounded by the clock, not a count: a background tab's timers fire at most once a second.
    for (const until = Date.now() + 10000; !ready() && Date.now() < until;) await new Promise((r) => setTimeout(r, 100));
    return JSON.stringify(window.__remixContext);
  }

  function fromRemix(scriptText) {
    const start = scriptText.indexOf('{'), end = scriptText.lastIndexOf('}');
    if (start < 0 || end < start) return null;
    let ctx;
    try { ctx = JSON.parse(scriptText.slice(start, end + 1)); } catch { return null; }
    const routes = Object.values((ctx.state && ctx.state.loaderData) || {});
    const route = routes.find((r) => r && r.jobPost);
    if (!route) return null;
    const post = route.jobPost;
    const questions = [...(post.questions || [])];
    for (const s of post.eeoc_sections || []) questions.push(...(s.questions || []));
    const fields = [];
    for (const q of questions) {
      // Resume/CV is [file, paste-as-text]; the file is the one we use.
      const f = (q.fields || [])[0];
      if (!f || !TYPES[f.type]) continue;
      fields.push({
        name: f.name,
        label: String(q.label || '').trim(),
        required: !!q.required,
        type: TYPES[f.type],
        options: (f.values || []).map((v) => String(v.label)),
      });
    }
    return { fields, redirectTo: post.redirect_to || null };
  }

  function labelText(el) {
    const l = el && (document.getElementById(el.id + '-label') || document.querySelector(`label[for="${CSS.escape(el.id)}"]`));
    return l ? l.textContent.replace(/\*\s*$/, '').trim() : '';
  }

  function form() {
    return document.getElementById('application-form') || document.querySelector('form');
  }

  function read(data) {
    const script = [...document.scripts].find((s) => s.textContent.includes('window.__remixContext'));
    const text = data || (script && script.textContent);
    const page = text && fromRemix(text);
    if (!page || !form()) return { error: 'application form not found' };
    // Selects the JSON leaves out: the phone country and the Hispanic/Latino
    // question that EEO sections render on their own.
    const known = new Set(page.fields.map((f) => f.name.replace(/_/g, '-')));
    for (const el of form().querySelectorAll('input.select__input[role="combobox"]')) {
      if (known.has(el.id.replace(/_/g, '-'))) continue;
      page.fields.push({ name: el.id, label: labelText(el), required: el.getAttribute('aria-required') === 'true', type: 'select', options: [] });
    }
    return page;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, ms) {
    for (const until = Date.now() + ms; Date.now() < until; await sleep(150)) {
      const v = fn();
      if (v) return v;
    }
    return fn();
  }

  // React keeps its own copy of an input's value; the prototype setter plus
  // an input event is what makes it notice a programmatic change.
  function setValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function element(name) {
    return document.getElementById(name) || document.getElementById(name.replace(/_/g, '-'));
  }

  function menuOptions(input) {
    return [...document.querySelectorAll(`[id^="react-select-${CSS.escape(input.id)}-option-"]`)];
  }

  // react-select only counts as focused after a focusin, and Greenhouse opens
  // the menu on keyup, so a bare focus() or keydown does nothing. A
  // background tab never gets real focus, hence the synthetic events.
  function openMenu(input) {
    input.focus();
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    for (const type of ['keydown', 'keyup']) {
      input.dispatchEvent(new KeyboardEvent(type, { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, bubbles: true, cancelable: true }));
    }
  }

  async function chooseOption(input, value, key) {
    const listed = () => menuOptions(input).length && menuOptions(input);
    openMenu(input);
    let opts = await waitFor(listed, 1500);
    if (!opts) {
      // Location is looked up as you type and has no options until then.
      setValue(input, key === 'location' ? value.split(',')[0] : value);
      opts = await waitFor(listed, 8000);
    }
    if (!opts) return 'no options to pick from';
    let i = root.oojMatch.pickOption(opts.map((o) => o.textContent), value);
    if (i < 0 && key === 'location') i = 0;
    if (i < 0) return `no option matches "${value}"`;
    opts[i].click();
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    const container = input.closest('.select__control') || input.closest('.select-shell');
    const picked = await waitFor(() => container && container.querySelector('[class*="single-value"], [class*="multi-value"]'), 1500);
    return picked ? null : 'the choice did not stick';
  }

  function chooseCheckboxes(fieldset, value) {
    const boxes = [...fieldset.querySelectorAll('input[type="checkbox"]')];
    const labels = boxes.map((b) => labelText(b) || (document.querySelector(`label[for="${CSS.escape(b.id)}"]`) || {}).textContent || '');
    const i = root.oojMatch.pickOption(labels, value);
    if (i < 0) return `no option matches "${value}"`;
    if (!boxes[i].checked) boxes[i].click();
    return null;
  }

  function attachCv(input, cv) {
    if (!cv || !cv.data) return 'no CV saved in the extension';
    const bytes = Uint8Array.from(atob(cv.data), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], cv.name, { type: cv.type }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return null;
  }

  async function fillOne(f, cv) {
    const el = element(f.name);
    if (!el) return 'not on the page';
    if (f.type === 'file') return attachCv(el, cv);
    if (el.tagName === 'FIELDSET') return chooseCheckboxes(el, f.value);
    if (el.getAttribute('role') === 'combobox') return chooseOption(el, f.value, f.key);
    if (el.tagName === 'SELECT') {
      const i = root.oojMatch.pickOption([...el.options].map((o) => o.textContent), f.value);
      if (i < 0) return `no option matches "${f.value}"`;
      el.selectedIndex = i;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return null;
    }
    setValue(el, f.value);
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return null;
  }

  async function fill(fills, cv) {
    const errors = [];
    let later = [];
    for (const f of fills) {
      const err = await fillOne(f, cv);
      // Some EEO questions (race) only appear after an earlier answer.
      if (err === 'not on the page') later.push(f);
      else if (err) errors.push(`${f.label}: ${err}`);
    }
    for (const f of later) {
      const err = await fillOne(f, cv);
      if (err && f.required) errors.push(`${f.label}: ${err}`);
    }
    return { errors };
  }

  function submit() {
    const f = form();
    const button = f && f.querySelector('button[type="submit"], input[type="submit"]');
    if (!button) return false;
    button.click();
    return true;
  }

  // signals: {path, confirmation, captcha, securityCode, errors}. Kept apart
  // from the DOM so the tests can feed it.
  function decide(s) {
    if (/\/confirmation\/?$/.test(s.path) && s.confirmation) return 'submitted';
    if (s.captcha) return { failed: 'captcha' };
    if (s.securityCode) return { failed: 'Greenhouse asked for an email security code' };
    if (s.errors && s.errors.length) return { failed: 'form errors: ' + s.errors.slice(0, 3).join(', ') };
    return null;
  }

  // reCAPTCHA keeps its challenge frame in the page all the time, hidden
  // and parked off screen, so size alone says nothing.
  function visible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 50 && r.height > 50 && r.bottom > 0 && r.top < innerHeight
      && el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  }

  function outcome() {
    const errored = [...document.querySelectorAll('[aria-invalid="true"]')];
    // Errors no field is marked for: a rejected submit or a failed CV upload.
    const messages = [...document.querySelectorAll('.helper-text--error')].map((el) => el.textContent.trim()).filter(Boolean);
    return decide({
      path: location.pathname,
      confirmation: !!document.querySelector('.confirmation, .application-confirmation'),
      captcha: [...document.querySelectorAll('iframe')].some((f) => /recaptcha\/(api2|enterprise)\/bframe|hcaptcha|challenges\.cloudflare/.test(f.src) && visible(f)),
      securityCode: !!document.querySelector('input[id*="security" i], input[name*="security" i]'),
      errors: [...messages, ...errored.map((el) => labelText(el) || el.id)],
    });
  }

  root.oojAts = root.oojAts || {};
  root.oojAts.greenhouse = { matches, onSite, pageData, read, fill, submit, outcome };
  if (typeof module === 'object' && module.exports) module.exports = { matches, onSite, pageData, fromRemix, decide };
})(globalThis);
