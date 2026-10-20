// Fill assist for any application form no dedicated ATS file knows. Same
// shape as ats/greenhouse.js, read from the DOM alone. matches() is always
// false: a page is never offered or applied to on its own, only filled when
// the user asks from the popup, and the user presses submit.
(function (root) {
  const onSite = () => true;
  const matches = () => false;

  const CONTROLS = 'input, textarea, select, [role="combobox"]:not(input)';
  const SKIP = new Set(['hidden', 'submit', 'button', 'image', 'reset', 'password', 'search']);
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, ms) {
    for (const until = Date.now() + ms; Date.now() < until; await sleep(200)) {
      const v = fn();
      if (v) return v;
    }
    return fn();
  }

  // The page plus any same-origin iframe it embeds the form in.
  function docs() {
    const out = [document];
    for (const f of document.querySelectorAll('iframe')) {
      try { if (f.contentDocument && f.contentDocument.body) out.push(f.contentDocument); } catch { /* cross-origin */ }
    }
    return out;
  }

  function shown(el) {
    return el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : el.getClientRects().length > 0;
  }

  const kind = (el) => (el.tagName === 'INPUT' ? (el.getAttribute('role') === 'combobox' ? 'combobox' : el.type)
    : el.tagName === 'TEXTAREA' ? 'textarea' : el.tagName === 'SELECT' ? (el.multiple ? 'multiselect' : 'select') : 'combobox');

  // Radios and checkboxes are often hidden behind a styled label, so those
  // count when something around them shows. A file input is nearly always
  // hidden behind a drop zone or an upload menu, so it always counts.
  // A text input the user cannot see (zero opacity, a pixel wide) is a
  // honeypot or the value store behind a custom dropdown, never a question.
  function usable(el) {
    if (el.type === 'file') return !el.disabled;
    if (el.disabled || el.readOnly && el.getAttribute('role') !== 'combobox' || SKIP.has(el.type) && el.tagName === 'INPUT') return false;
    if (el.closest('[aria-hidden="true"]') || el.tabIndex < 0 && el.type !== 'radio' && el.type !== 'checkbox' && el.tagName !== 'SELECT') return false;
    const r = el.getBoundingClientRect();
    if (shown(el) && el.checkVisibility({ opacityProperty: true }) && r.width > 2 && r.height > 2) return true;
    if (!['radio', 'checkbox'].includes(el.type) && el.tagName !== 'SELECT') return false;
    const around = el.closest('label') || el.parentElement;
    return !!around && shown(around);
  }

  const controls = (container) => [...container.querySelectorAll(CONTROLS)].filter(usable);

  // Login, search, newsletter and comment forms are never the application.
  const UNRELATED = /search|login|log-in|signin|sign-in|newsletter|subscribe|comment/i;
  function unrelated(form) {
    return !!form.querySelector('input[type="password"]') || form.matches('[role="search"]')
      || UNRELATED.test(`${form.id} ${form.className} ${form.getAttribute('action') || ''}`);
  }

  // File inputs count even when hidden, so they cannot make a form on their
  // own: a closed "Apply" tab still holds its upload fields.
  function score(els) {
    if (els.length < 3 || els.filter((el) => el.type !== 'file').length < 2) return 0;
    const strong = els.some((el) => ['file', 'email', 'tel'].includes(el.type) || el.tagName === 'TEXTAREA');
    return strong ? els.length + (els.some((el) => el.type === 'file') ? 5 : 0) : 0;
  }

  function common(els) {
    let box = els[0].parentElement;
    while (box && !els.every((el) => box.contains(el))) box = box.parentElement;
    return box;
  }

  // The form with the most fields, or the fields outside any form when a
  // page builds its form from divs.
  function findForm() {
    let best = null, top = 0;
    for (const doc of docs()) {
      for (const form of doc.querySelectorAll('form')) {
        if (unrelated(form)) continue;
        const s = score(controls(form));
        if (s > top) { best = form; top = s; }
      }
      const loose = controls(doc.body).filter((el) => !el.closest('form'));
      const s = score(loose);
      if (s > top) { best = common(loose); top = s; }
    }
    return best;
  }

  // The text a user sees in node: not hidden status messages, not the
  // options of a select inside it, not button captions.
  const OWN = 'select, option, textarea, script, style, button, svg, [aria-hidden="true"], [role="listbox"], [role="option"]';
  function textOf(node) {
    const parts = [];
    const walk = node.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let t = walk.nextNode(); t; t = walk.nextNode()) {
      const p = t.parentElement;
      // A hidden asterisk still says the field is required.
      const star = /^\s*[*✱]\s*$/.test(t.textContent);
      if (p && (star || !p.closest(OWN)) && shown(p)) parts.push(t.textContent);
    }
    return clean(parts.join(' '));
  }

  function byIds(doc, ids) {
    return clean((ids || '').split(/\s+/).map((id) => { const x = id && doc.getElementById(id); return x ? x.textContent : ''; }).join(' '));
  }

  // What the page itself says the control is called.
  function ownLabel(el) {
    const doc = el.ownerDocument;
    const by = byIds(doc, el.getAttribute('aria-labelledby'));
    if (by) return by;
    if (el.id) {
      const l = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      const t = l && textOf(l);
      if (t) return t;
    }
    const wrap = el.closest('label');
    const t = wrap && textOf(wrap);
    if (t) return t;
    // Some widgets set an identifier there ("file-input"), not words.
    const aria = clean(el.getAttribute('aria-label'));
    return /^[a-z0-9]+([-_][a-z0-9]+)+$/i.test(aria) ? '' : aria;
  }

  // The nearest text before el that no other field sits between.
  function textBefore(el, stop) {
    for (let node = el, depth = 0; node && node !== stop && depth < 5; node = node.parentElement, depth++) {
      for (let s = node.previousSibling; s; s = s.previousSibling) {
        if (s.nodeType === 1 && (s.matches(CONTROLS) || s.querySelector(CONTROLS))) return '';
        const t = s.nodeType === 1 ? textOf(s) : s.nodeType === 3 ? clean(s.textContent) : '';
        if (t) return t.slice(0, 300);
      }
    }
    return '';
  }

  const GENERIC_HINT = /^(type|enter|select|choose|start typing|search|your answer|e\.?g\.?|\.\.\.)/i;
  function labelOf(el, stop) {
    const own = ownLabel(el);
    if (own) return own;
    // A file input sits in an upload widget ("Choose file", "No file
    // selected"): the text above the widget names it, else the widget's own.
    if (el.type === 'file') {
      let box = el;
      while (box.parentElement && box.parentElement !== stop
        && box.parentElement.querySelectorAll('input:not([type="hidden"]), textarea, select').length === 1) box = box.parentElement;
      const t = textBefore(box, stop) || textOf(box).slice(0, 150);
      if (t) return t;
    }
    const hint = clean(el.getAttribute('placeholder'));
    if (hint && !GENERIC_HINT.test(hint)) return hint;
    return textBefore(el, stop) || hint || clean(el.getAttribute('title'))
      || clean((el.name || el.id || '').replace(/[_\-[\]]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2'));
  }

  // An asterisk or "(required)" in a few languages marks a required field.
  const MUST = '\\((required|erforderlich|pflichtfeld|obligatoire|obligatorio|obrigatório|obbligatorio|verplicht|påkrævet|påkrevd|obligatoriskt)\\)';
  const STAR = new RegExp(`[*✱]|${MUST}`, 'i');
  const tidy = (label) => clean(label.replace(/[*✱]/g, ' ').replace(new RegExp(MUST, 'gi'), ' ')
    .replace(/\((optional|optionnel|opcional|facoltativo)\)/gi, ' ').replace(/\s+required$/i, ''));

  // A radio or checkbox group's question: the legend, the group's own
  // label, or the text above the group.
  function groupLabel(members, box, stop) {
    const set = box.closest('fieldset');
    const legend = set && members.every((m) => set.contains(m)) && set.querySelector('legend');
    if (legend && textOf(legend)) return textOf(legend);
    const group = members[0].closest('[role="radiogroup"], [role="group"]');
    if (group && members.every((m) => group.contains(m))) {
      const t = byIds(group.ownerDocument, group.getAttribute('aria-labelledby')) || clean(group.getAttribute('aria-label'));
      if (t) return t;
    }
    return textBefore(box, stop);
  }

  function selectOptions(el) {
    return [...el.options].filter((o, i) => !o.disabled && !(i === 0 && (o.value === '' || /^(select|choose|please|--)/i.test(clean(o.textContent)))))
      .map((o) => clean(o.textContent));
  }

  // The nearest box the user can see, for the red and amber outlines.
  function mark(el, id) {
    let box = el;
    while (box && !shown(box)) box = box.parentElement;
    if (box) box.setAttribute('data-ooj-box', id);
  }

  let form = null;

  function fieldsOf(container) {
    for (const old of container.querySelectorAll('[data-ooj], [data-ooj-box]')) { old.removeAttribute('data-ooj'); old.removeAttribute('data-ooj-box'); }
    const fields = [], groups = new Map();
    for (const el of controls(container)) {
      if (el.type === 'radio' || el.type === 'checkbox') {
        const key = el.name ? 'n:' + el.name : el.closest('fieldset, [role="radiogroup"], [role="group"]') || el;
        if (!groups.has(key)) { groups.set(key, []); fields.push(groups.get(key)); }
        groups.get(key).push(el);
      } else fields.push(el);
    }
    return fields.map((x, i) => {
      const name = 'ooj-' + i;
      if (!Array.isArray(x)) {
        x.setAttribute('data-ooj', name);
        mark(x, name);
        const raw = labelOf(x, container);
        const type = kind(x);
        return { name, label: tidy(raw), type, options: type === 'select' || type === 'multiselect' ? selectOptions(x) : [],
          required: x.required || x.getAttribute('aria-required') === 'true' || STAR.test(raw), autocomplete: x.getAttribute('autocomplete') || '' };
      }
      const box = x.length > 1 ? common(x) : x[0];
      for (const m of x) m.setAttribute('data-ooj', name);
      mark(box, name);
      const type = x[0].type;
      const required = x.some((m) => m.required || m.getAttribute('aria-required') === 'true')
        || (box.closest('[aria-required="true"]') !== null);
      if (type === 'checkbox' && x.length === 1) {
        const raw = ownLabel(x[0]) || textBefore(x[0], container);
        return { name, label: tidy(raw), type, options: [], required: required || STAR.test(raw) };
      }
      const raw = groupLabel(x, box, container);
      return { name, label: tidy(raw), type, options: x.map((m) => tidy(ownLabel(m) || m.value)), required: required || STAR.test(raw) };
    }).filter((f) => f.label);
  }

  // "Apply", "Apply for this job", "Auf diese Stelle bewerben", "I'm interested".
  const APPLY = /(?<!\p{L})(apply|bewerben|postuler|postular|postularme|inscribirme|aplicar|candidatar|candidatura|candidati|solliciteer|solliciteren|søk|sök|ansök|hae|aplikuj|jelentkezem|i['’]?m interested)(?!\p{L})/iu;
  const NOT_APPLY = /linkedin|indeed|seek|xing|google|facebook|filter|later|share|save|how to/i;

  // An "Apply" link or button that leads to the form. Never a form's own
  // submit button: that would send an application.
  function applyControl() {
    const ok = (el) => !(el.form && el.type === 'submit') && !el.disabled && shown(el);
    for (const el of document.querySelectorAll('a, button, [role="button"], input[type="button"]')) {
      const t = clean(el.textContent || el.value);
      if (t.length < 40 && APPLY.test(t) && !NOT_APPLY.test(t) && ok(el)) return el;
    }
    // A button with its own wording ("Join our Kingdom!") still says what
    // it does in its markup.
    const marked = 'a[href*="/apply"], a[href*="/applications/new"], button[class*="apply" i], button[id*="apply" i], [data-action*="apply" i], [data-action*="form-overlay" i]';
    return [...document.querySelectorAll(marked)].find((el) => ok(el) && !NOT_APPLY.test(el.textContent)) || null;
  }

  // A careers page that embeds the ATS form from another site: the caller
  // loads it in the tab, since a page cannot reach into it.
  function formFrame() {
    const frames = [...document.querySelectorAll('iframe[src]')].filter((f) => f.getBoundingClientRect().height > 300 && shown(f)
      && new URL(f.src, location.href).origin !== location.origin && /job|career|apply|recruit|greenhouse|lever|ashby|workable|bamboo|breezy|personio|comeet|jobvite|teamtailor/i.test(f.src));
    return frames.find((f) => /apply|application|form/i.test(f.src)) || frames[0] || null;
  }

  const captcha = () => [...document.querySelectorAll('iframe')].some((f) => /captcha|challenges\.cloudflare/.test(f.src)
    && !/recaptcha\/(api2|enterprise)\/anchor/.test(f.src) && f.getBoundingClientRect().width > 50 && shown(f));

  // {fields} once the form is there. {openUrl} asks the caller to load the
  // page an Apply link or a form frame points at; an Apply button is
  // clicked here.
  async function read() {
    form = await waitFor(() => findForm() || formFrame(), 6000);
    if (!form) {
      const apply = applyControl();
      if (apply) {
        const href = apply.tagName === 'A' && apply.getAttribute('href');
        if (href && !/^(#|javascript:)/i.test(href) && apply.href.split('#')[0] !== location.href.split('#')[0]) return { openUrl: apply.href };
        apply.click();
        form = await waitFor(() => findForm() || formFrame(), 10000);
      }
    }
    if (form && form.tagName === 'IFRAME') return { openUrl: form.src, frame: true };
    if (!form && captcha()) return { error: 'A CAPTCHA stands in front of the form. Solve it, then try again.' };
    if (!form) return { error: 'No application form on this page.' };
    const fields = fieldsOf(form);
    for (const f of fields) if (f.type === 'combobox') f.options = await peekOptions(find(f.name)[0]);
    return { fields };
  }

  function find(name) {
    for (const doc of docs()) {
      const els = [...doc.querySelectorAll(`[data-ooj="${CSS.escape(name)}"]`)];
      if (els.length) return els;
    }
    return [];
  }

  // React, Vue and Angular keep their own copy of a value; the prototype
  // setter plus input and change events is what makes them see a new one.
  function setValue(el, value) {
    const win = el.ownerDocument.defaultView;
    const proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? win.HTMLSelectElement.prototype : win.HTMLInputElement.prototype;
    el.focus();
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function leave(el) {
    el.dispatchEvent(new FocusEvent('blur'));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  }

  function attachCv(el, cv) {
    if (!cv || !cv.data) return 'no CV saved in the extension';
    const win = el.ownerDocument.defaultView;
    const bytes = Uint8Array.from(atob(cv.data), (c) => c.charCodeAt(0));
    const dt = new win.DataTransfer();
    dt.items.add(new win.File([bytes], cv.name, { type: cv.type }));
    el.files = dt.files;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return null;
  }

  const YES = /^(yes|y|true|1|agree|i agree|accept|i accept|checked|on)\b/i;

  function choose(els, value) {
    const labels = els.map((m) => ownLabel(m) || m.value);
    const i = root.oojMatch.pickOption(labels, value);
    if (i < 0) return `no option matches "${value}"`;
    if (!els[i].checked) els[i].click();
    return els[i].checked ? null : 'the choice did not stick';
  }

  function press(el) {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    el.click();
  }

  const typeable = (el) => el.tagName === 'INPUT' && !el.readOnly;

  // The options a custom dropdown shows once open: in the list it points
  // at, else anywhere on the page.
  function listOf(el) {
    const input = el.tagName === 'INPUT' ? el : el.querySelector('input');
    const doc = el.ownerDocument;
    const lists = [...new Set([el.getAttribute('aria-controls'), el.getAttribute('aria-owns'), input && input.getAttribute('aria-controls')])]
      .map((id) => id && doc.getElementById(id)).filter(Boolean);
    const opts = (lists.length ? lists : [doc]).flatMap((l) => [...l.querySelectorAll('[role="option"]')]).filter(shown);
    return opts.length && opts;
  }

  // A dropdown you cannot type in lists every choice when opened, so read
  // them for the planner and close it again. A typeahead's first list is
  // only a sample, so it is left alone.
  async function peekOptions(el) {
    if (typeable(el)) return [];
    press(el);
    const opts = await waitFor(() => listOf(el), 800);
    const texts = opts ? opts.map((o) => clean(o.textContent)).filter(Boolean) : [];
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    leave(el);
    return texts;
  }

  // Typeahead and custom dropdowns: type, then pick from what the list shows.
  async function chooseOption(el, value, key) {
    const input = el.tagName === 'INPUT' ? el : el.querySelector('input');
    const listed = () => listOf(el);
    press(el);
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    let opts = await waitFor(listed, 1000);
    if (input && typeable(input) && (!opts || root.oojMatch.pickOption(opts.map((o) => o.textContent), value) < 0)) {
      setValue(input, key === 'location' ? value.split(',')[0] : value);
      opts = await waitFor(listed, 5000);
    }
    if (!opts) return input && input.value ? null : 'no options to pick from';
    let i = root.oojMatch.pickOption(opts.map((o) => o.textContent), value);
    if (i < 0 && key === 'location') i = 0;
    if (i < 0) return `no option matches "${value}"`;
    press(opts[i]);
    if (input) leave(input);
    return null;
  }

  async function fillOne(f, cv) {
    const els = find(f.name);
    if (!els.length) return 'not on the page';
    const el = els[0];
    if (f.type === 'file') return attachCv(el, cv);
    if (f.type === 'radio' || f.type === 'checkbox' && f.options.length) return choose(els, f.value);
    if (f.type === 'checkbox') {
      if (el.checked !== YES.test(String(f.value).trim())) el.click();
      return null;
    }
    if (f.type === 'select' || f.type === 'multiselect') {
      const opts = [...el.options];
      const i = root.oojMatch.pickOption(opts.map((o) => o.textContent), f.value);
      if (i < 0) return `no option matches "${f.value}"`;
      setValue(el, opts[i].value);
      leave(el);
      return null;
    }
    if (f.type === 'combobox') return chooseOption(el, f.value, f.key);
    if (el.type === 'date' && !/^\d{4}-\d\d-\d\d$/.test(f.value)) return 'needs a date';
    setValue(el, f.value);
    leave(el);
    return null;
  }

  async function fill(fills, cv) {
    const errors = [];
    for (const f of fills) {
      const err = await fillOne(f, cv);
      if (err) errors.push(`${f.label}: ${err}`);
    }
    return { errors };
  }

  function submit() {
    const f = form || findForm();
    const button = f && (f.querySelector('button[type="submit"], input[type="submit"]')
      || [...f.querySelectorAll('button')].reverse().find((b) => /submit|apply|send/i.test(b.textContent)));
    if (!button) return false;
    button.click();
    return true;
  }

  const SENT = /thank you for (applying|your application|your interest)|application (was |has been )?(received|submitted|sent)|we('ve| have) received your application/i;

  function outcome() {
    if (!findForm() && SENT.test(document.body.innerText)) return 'submitted';
    const captcha = [...document.querySelectorAll('iframe')].some((f) => /recaptcha\/(api2|enterprise)\/bframe|hcaptcha|challenges\.cloudflare/.test(f.src)
      && f.getBoundingClientRect().width > 50 && shown(f));
    if (captcha) return { failed: 'captcha' };
    const errored = [...document.querySelectorAll('[aria-invalid="true"]')].filter(shown).map((el) => tidy(labelOf(el)));
    return errored.length ? { failed: 'form errors: ' + errored.slice(0, 3).join(', ') } : null;
  }

  // For the fill button and for picking the frame to fill: how strongly
  // this document looks like an application form, 0 for not at all.
  function formHere() {
    if (!document.body || document.querySelectorAll('input:not([type="hidden"]), textarea, select').length < 3) return { score: 0 };
    const f = findForm();
    return f ? { score: score(controls(f)), file: !!f.querySelector('input[type="file"]') } : { score: 0 };
  }

  root.oojAts = root.oojAts || {};
  root.oojAts.generic = { matches, onSite, read, fill, submit, outcome, formHere };
})(globalThis);
