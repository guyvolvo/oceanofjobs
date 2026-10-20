// Workable filler, the same shape as ats/greenhouse.js. Our job links are
// the posting (apply.workable.com/j/<shortcode>); formUrl() turns one into
// its form page, which the background run opens instead.
(function (root) {
  const HOST = 'apply.workable.com';
  const JOB_PATH = /^(\/[^/]+)?\/j\/([0-9A-Z]+)(\/apply)?\/?$/i;

  function onSite(url) {
    try { return new URL(url).hostname === HOST; } catch { return false; }
  }

  function matches(url) {
    let u;
    try { u = new URL(url); } catch { return false; }
    return u.protocol === 'https:' && u.hostname === HOST && JOB_PATH.test(u.pathname);
  }

  function formUrl(url) {
    const u = new URL(url);
    const m = JOB_PATH.exec(u.pathname);
    return m ? `${u.origin}${m[1] || ''}/j/${m[2]}/apply/` : url;
  }

  // The form page renders from a JSON spec it fetches after load, so this
  // waits for the rendered form (the background run starts at the load
  // event) and then asks for the same spec. Labels the spec leaves out (the
  // privacy consent) are taken from the page. Self-contained because
  // executeScript serialises it.
  async function pageData() {
    const code = (/\/j\/([0-9A-Z]+)/i.exec(location.pathname) || [])[1];
    if (!code) return null;
    const ready = () => document.querySelector('form[data-ui="application-form"] button[type="submit"]');
    // Bounded by the clock, not a count: a background tab's timers fire at most once a second.
    for (const until = Date.now() + 15000; !ready() && Date.now() < until;) await new Promise((r) => setTimeout(r, 100));
    if (!ready()) return null;
    const res = await fetch(`/api/v1/jobs/${code}/form`, { credentials: 'same-origin' });
    if (!res.ok) return null;
    const form = await res.json();
    const labels = {};
    for (const s of form) {
      for (const f of s.fields || []) {
        if (f.label) continue;
        const box = document.querySelector(`[data-ui="${CSS.escape(f.id)}"]`);
        const text = box && (box.querySelector('[id^="checkbox_label_"]') || box).textContent;
        if (text) labels[f.id] = text.replace(/\s+/g, ' ').trim();
      }
    }
    return JSON.stringify({ form, labels });
  }

  const TYPES = {
    text: 'text', email: 'text', number: 'text', phone: 'text', date: 'text',
    paragraph: 'textarea', file: 'file', dropdown: 'select', boolean: 'select', group: 'group',
  };

  // data: what pageData() returns. Fields keep Workable's own type as kind,
  // which fill() needs (a phone, a date and a text box all plan as text).
  function fromSpec(data) {
    let spec;
    try { spec = JSON.parse(data); } catch { return null; }
    if (!spec || !Array.isArray(spec.form)) return null;
    const fields = [];
    for (const s of spec.form) {
      for (const f of s.fields || []) {
        const required = !!f.required;
        // Avatars, portfolios and certificates: only the CV is attached, and
        // an optional section (education, experience) is left empty.
        if (!required && ((f.type === 'file' && f.id !== 'resume') || f.type === 'group')) continue;
        let type = f.type === 'multiple' ? (f.singleOption ? 'select' : 'multiselect') : TYPES[f.type];
        if (!type) type = 'text';
        const options = f.type === 'boolean' ? ['Yes', 'No'] : (f.options || []).map((o) => String(o.value).trim());
        fields.push({ name: f.id, label: String(f.label || (spec.labels || {})[f.id] || '').trim(), required, type, kind: f.type, options });
      }
    }
    return { fields, redirectTo: null };
  }

  function form() {
    return document.querySelector('form[data-ui="application-form"]');
  }

  function read(data) {
    const page = data && fromSpec(data);
    if (!page || !form()) return { error: 'application form not found' };
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

  // numeric: the box formats what it is given (7700900123 shows as
  // 7700 900123, 50000 as 50,000), so only the digits must survive.
  function typeInto(el, value, numeric) {
    el.focus();
    setValue(el, value);
    el.dispatchEvent(new FocusEvent('blur'));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    const digits = (v) => v.replace(/[^\d.]/g, '');
    const same = numeric ? digits(el.value) === digits(value) : el.value === value;
    return same ? null : `the field did not take "${value}"`;
  }

  // A radio or checkbox is a div wrapping a hidden input, named by the
  // last id in its aria-labelledby (the first is the question).
  function optionText(el) {
    const id = (el.getAttribute('aria-labelledby') || '').split(' ').pop();
    const text = ((id && document.getElementById(id)) || el).textContent.trim();
    return text === 'YES' ? 'Yes' : text === 'NO' ? 'No' : text;
  }

  // The hidden input is what React listens to, not the div around it.
  async function clickChoice(boxes, labels, value) {
    const i = root.oojMatch.pickOption(labels, value);
    if (i < 0) return `no option matches "${value}"`;
    const on = () => boxes[i].getAttribute('aria-checked') === 'true';
    if (!on()) (boxes[i].querySelector('input') || boxes[i]).click();
    return (await waitFor(on, 1500)) ? null : 'the choice did not stick';
  }

  async function choose(box, value) {
    const input = box.querySelector('input[role="combobox"]');
    if (!input) return 'no dropdown on the page';
    const listbox = () => document.getElementById(input.getAttribute('aria-controls'));
    const options = () => { const l = listbox(); return l && l.querySelectorAll('[role="option"]').length && [...l.querySelectorAll('[role="option"]')]; };
    input.click();
    const opts = await waitFor(options, 2000);
    if (!opts) return 'no options to pick from';
    const i = root.oojMatch.pickOption(opts.map((o) => o.textContent), value);
    if (i < 0) { input.click(); return `no option matches "${value}"`; }
    opts[i].click();
    const hidden = box.querySelector(`input[name="${CSS.escape(box.dataset.ui)}"]`);
    return (await waitFor(() => !hidden || hidden.value, 1500)) ? null : 'the choice did not stick';
  }

  // Countries sharing a dial code, and the one a number with it most likely
  // belongs to. The picker lists the rest first when they sort earlier
  // (Guernsey before the United Kingdom).
  const MAIN_COUNTRY = { 1: 'us', 7: 'ru', 39: 'it', 44: 'gb', 47: 'no', 61: 'au', 212: 'ma', 262: 're', 358: 'fi', 590: 'gp', 599: 'cw' };

  // intl-tel-input with the dial code in its own picker: pick the country
  // whose code starts the number, then type the rest.
  async function fillPhone(box, value) {
    const input = box.querySelector('input[type="tel"]');
    if (!input) return 'no phone box on the page';
    let digits = value.replace(/[^\d+]/g, '');
    if (digits.startsWith('00')) digits = '+' + digits.slice(2);
    if (digits.startsWith('+')) {
      const fits = [...box.querySelectorAll('li[data-dial-code]')].filter((li) => digits.slice(1).startsWith(li.dataset.dialCode));
      const longest = Math.max(...fits.map((li) => li.dataset.dialCode.length));
      const same = fits.filter((li) => li.dataset.dialCode.length === longest);
      const pick = same.find((li) => MAIN_COUNTRY[li.dataset.dialCode] === li.dataset.iso2) || same[0];
      if (!pick) return `no country has the dial code of "${value}"`;
      const button = box.querySelector('button[aria-haspopup]');
      const picked = () => button && button.getAttribute('aria-label').endsWith(pick.textContent.trim());
      if (!picked()) {
        if (button) button.click();
        pick.click();
        if (!(await waitFor(picked, 1500))) return 'the phone country did not stick';
      }
      digits = digits.slice(1 + pick.dataset.dialCode.length);
    }
    return typeInto(input, digits, true);
  }

  // The picker's format, from its placeholder: MM/DD/YYYY or DD/MM/YYYY.
  // Its box is masked and drops a value set in one go, so the date goes in
  // a key at a time, every event a real key press makes.
  function fillDate(input, value) {
    const d = /^\d{4}-\d{2}-\d{2}/.test(value) ? new Date(value.slice(0, 10) + 'T00:00:00') : null;
    if (!d || isNaN(d)) return `"${value}" is not a date`;
    const parts = { DD: String(d.getDate()).padStart(2, '0'), MM: String(d.getMonth() + 1).padStart(2, '0'), YYYY: String(d.getFullYear()) };
    const text = (input.placeholder || 'MM/DD/YYYY').replace(/DD|MM|YYYY/g, (k) => parts[k]);
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    input.focus();
    for (const key of text) {
      input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      input.dispatchEvent(new KeyboardEvent('keypress', { key, charCode: key.charCodeAt(0), bubbles: true, cancelable: true }));
      input.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: key, bubbles: true, cancelable: true }));
      set.call(input, input.value + key);
      input.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: key, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
    }
    // Closes the calendar the typing opened.
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    input.dispatchEvent(new FocusEvent('blur'));
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    return input.value === text ? null : `the field did not take "${text}"`;
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
    const box = form().querySelector(`[data-ui="${CSS.escape(f.name)}"]`);
    if (!box) return 'not on the page';
    if (f.kind === 'file') return f.key === 'resume' ? attachCv(box, cv) : 'only the CV can be attached';
    if (f.kind === 'group') return 'sections like this one are not filled';
    if (f.kind === 'phone') return fillPhone(box, f.value);
    if (f.kind === 'date') return fillDate(box, f.value);
    if (f.kind === 'dropdown') return choose(box, f.value);
    const radios = [...box.querySelectorAll('[role="radio"]')];
    if (radios.length) return clickChoice(radios, radios.map(optionText), f.value);
    const checks = [...box.querySelectorAll('[role="checkbox"]')];
    // A lone checkbox is a consent: ticked for a yes, left alone otherwise.
    if (checks.length === 1 && f.kind === 'boolean') return root.oojMatch.pickOption(['Yes'], f.value) === 0 ? clickChoice(checks, ['Yes'], 'Yes') : null;
    if (checks.length) return clickChoice(checks, checks.map(optionText), f.value);
    if (box.matches('input, textarea')) return typeInto(box, f.value, f.kind === 'number');
    const input = box.querySelector('input:not([type="hidden"]), textarea');
    return input ? typeInto(input, f.value) : 'not a field that can be typed into';
  }

  async function fill(fills, cv) {
    const errors = [];
    // The CV first: a later upload must not race the typing.
    const ordered = [...fills.filter((f) => f.kind === 'file'), ...fills.filter((f) => f.kind !== 'file')];
    for (const f of ordered) {
      const err = await fillOne(f, cv);
      if (err) errors.push(`${f.label}: ${err}`);
    }
    // An upload in flight would be cut off by the submit.
    const busy = () => form().querySelector('[data-ui="resume"]')?.closest('[data-role="dropzone"]')?.querySelector('[role="progressbar"], [aria-busy="true"]');
    await waitFor(() => !busy(), 15000);
    // What Workable itself rejected as it was typed, a phone number say.
    return { errors: [...errors, ...fieldErrors()] };
  }

  function submit() {
    const f = form();
    const button = f && f.querySelector('button[type="submit"]');
    if (!button) return false;
    button.click();
    return true;
  }

  // A field Workable rejects gets a message with the id <field>_error.
  function fieldErrors() {
    return [...document.querySelectorAll('form [id$="_error"]')].filter((el) => el.textContent.trim()).map((el) => {
      const label = document.getElementById(el.id.replace(/_error$/, '_label'));
      return (label ? label.textContent.trim() + ': ' : '') + el.textContent.trim();
    });
  }

  // signals: {success, captcha, alert, errors}. Kept apart from the DOM so
  // the tests can feed it.
  function decide(s) {
    if (s.success) return 'submitted';
    if (s.captcha) return { failed: 'captcha' };
    if (s.errors && s.errors.length) return { failed: 'form errors: ' + s.errors.slice(0, 3).join(', ') };
    if (s.alert) return { failed: s.alert };
    return null;
  }

  function visible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 50 && r.height > 50 && el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  }

  const TURNSTILE_ERROR = /couldn.t process your request|from a different browser/i;

  function outcome() {
    // A rejected submit shows as a flash message, its text apart from the dismiss icon.
    const alert = [...document.querySelectorAll('[data-ui="flash-container"]')]
      .map((el) => (document.getElementById(el.getAttribute('aria-describedby')) || el).textContent.replace(/\s+/g, ' ').trim())
      .filter(Boolean).join(' ');
    return decide({
      // After a submit Workable shows either its thank-you panel or, for US
      // employers that ask, the optional EEO survey.
      success: !!document.querySelector('[data-ui="successful-submit"], [data-ui="eeoc-form"]'),
      captcha: TURNSTILE_ERROR.test(alert)
        || [...document.querySelectorAll('iframe')].some((f) => /challenges\.cloudflare|recaptcha|hcaptcha/.test(f.src) && visible(f)),
      alert,
      errors: fieldErrors(),
    });
  }

  root.oojAts = root.oojAts || {};
  root.oojAts.workable = { matches, onSite, formUrl, pageData, read, fill, submit, outcome };
  if (typeof module === 'object' && module.exports) module.exports = { matches, onSite, formUrl, pageData, fromSpec, decide };
})(globalThis);
