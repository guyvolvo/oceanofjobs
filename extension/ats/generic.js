// Fill assist for any application form no dedicated ATS file knows. Same
// shape as ats/greenhouse.js, read from the DOM alone. matches() is always
// false: a run never applies through it. A form is filled when the user
// asks, and sent only when the user presses Submit application on the card.
(function (root) {
  const onSite = () => true;
  const matches = () => false;

  // A button that opens a list of choices (Workday's dropdowns) is a
  // dropdown too.
  const CONTROLS = 'input, textarea, select, [role="combobox"]:not(input), button[aria-haspopup="listbox"]';
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

  // Web components (SmartRecruiters' spl-input) keep their fields in open
  // shadow roots, where querySelectorAll does not look. deep() does, in
  // page order; up() steps out of a shadow root to the element that holds
  // it; scope() is where an id or a label[for] is looked up.
  function deep(root, sel) {
    const out = [];
    const visit = (node) => {
      for (const el of node.children) {
        if (el.matches(sel)) out.push(el);
        if (el.shadowRoot) visit(el.shadowRoot);
        visit(el);
      }
    };
    if (root.shadowRoot) visit(root.shadowRoot);
    visit(root);
    return out;
  }
  const up = (el) => el.parentElement || (el.parentNode && el.parentNode.host) || null;
  const scope = (el) => el.getRootNode();
  // What a button says. A web component's button shows its host's words
  // through a slot (<spl-button>Envoyer</spl-button>), so it has none of its own.
  const caption = (b) => clean(b.textContent || b.value || b.getAttribute('aria-label'))
    || (scope(b).host ? clean(scope(b).host.textContent || scope(b).host.getAttribute('aria-label')) : '');
  const within = (box, el) => { for (let n = el; n; n = up(n)) if (n === box) return true; return false; };
  const inForm = (el) => { for (let n = el; n; n = up(n)) if (n.tagName === 'FORM') return true; return false; };

  // Workday's search prompts ("Country Phone Code") are plain inputs that only take a choice from their list.
  const kind = (el) => (el.tagName === 'INPUT' ? (el.getAttribute('role') === 'combobox' || el.getAttribute('data-uxi-widget-type') === 'selectinput' ? 'combobox' : el.type)
    : el.tagName === 'TEXTAREA' ? 'textarea' : el.tagName === 'SELECT' ? (el.multiple ? 'multiselect' : 'select') : 'combobox');

  // Radios and checkboxes are often hidden behind a styled label, so those
  // count when something around them shows. A file input is nearly always
  // hidden behind a drop zone or an upload menu, so it always counts.
  // A text input the user cannot see (zero opacity, a pixel wide) is a
  // honeypot or the value store behind a custom dropdown, never a question.
  // A field set out for bots to fill: a person never sees it, and filling
  // it gets the application dropped. Workday's is "beecatcher".
  const TRAP = /beecatcher|honeypot|hp_|bot.?trap/i;
  function usable(el) {
    if (TRAP.test(`${el.name} ${el.id} ${el.getAttribute('data-automation-id') || ''}`)) return false;
    if (el.type === 'file') return !el.disabled;
    if (el.disabled || el.readOnly && el.getAttribute('role') !== 'combobox' || SKIP.has(el.type) && el.tagName === 'INPUT') return false;
    if (el.closest('[aria-hidden="true"]') || el.tabIndex < 0 && el.type !== 'radio' && el.type !== 'checkbox' && el.tagName !== 'SELECT') return false;
    const r = el.getBoundingClientRect();
    if (shown(el) && el.checkVisibility({ opacityProperty: true }) && r.width > 2 && r.height > 2) return true;
    if (!['radio', 'checkbox'].includes(el.type) && el.tagName !== 'SELECT') return false;
    const around = el.closest('label') || up(el);
    return !!around && shown(around);
  }

  const controls = (container) => deep(container, CONTROLS).filter(usable);

  // Login, search, newsletter and comment forms are never the application.
  const UNRELATED = /search|login|log-in|signin|sign-in|newsletter|subscribe|comment/i;
  function unrelated(form) {
    return deep(form, 'input[type="password"]').length > 0 || form.matches('[role="search"]')
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
    let box = up(els[0]);
    while (box && !els.every((el) => within(box, el))) box = up(box);
    return box;
  }

  // The form with the most fields, or the fields outside any form when a
  // page builds its form from divs.
  function findForm() {
    // A site's script may pin the form's area (ats/workday.js).
    const pinned = docs().map((d) => d.querySelector('[data-ooj-root]')).find((el) => el && controls(el).length);
    if (pinned) return pinned;
    let best = null, top = 0;
    for (const doc of docs()) {
      for (const form of deep(doc, 'form')) {
        if (unrelated(form)) continue;
        const s = score(controls(form));
        if (s > top) { best = form; top = s; }
      }
      const loose = controls(doc.body).filter((el) => !inForm(el));
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
    // As the page shows it: a web component's shadow root, and in it each
    // <slot> with the content it shows (SmartRecruiters' question text sits
    // in <spl-input> and appears through its label's slot).
    const one = (c) => {
      if (c.nodeType === 3) {
        const p = c.parentElement || (c.parentNode && c.parentNode.host);
        // A hidden asterisk still says the field is required.
        const star = /^\s*[*✱]\s*$/.test(c.textContent);
        if (p && (star || !p.closest(OWN)) && shown(p)) parts.push(c.textContent);
      } else if (c.nodeType === 1) {
        if (c.tagName === 'SLOT') c.assignedNodes({ flatten: true }).forEach(one);
        else all(c.shadowRoot || c);
      }
    };
    const all = (n) => n.childNodes.forEach(one);
    all(node.shadowRoot || node);
    return clean(parts.join(' '));
  }

  function byIds(doc, ids) {
    return clean((ids || '').split(/\s+/).map((id) => { const x = id && doc.getElementById(id); return x ? x.textContent : ''; }).join(' '));
  }

  // What the page itself says the control is called.
  function ownLabel(el) {
    const doc = scope(el);
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
    if (aria && !/^[a-z0-9]+([-_][a-z0-9]+)+$/i.test(aria)) return aria;
    // A web component may carry the words on itself: <spl-input label="First name">.
    const host = doc.host;
    return host ? clean(host.getAttribute('label') || host.getAttribute('aria-label')) : '';
  }

  const MARKER_ONLY = /^(\*|required|optional|this field is required|obligatoire|pflichtfeld|erforderlich|obligatorio|requerido|obbligatorio|verplicht|חובה|שדה חובה)[.:]?$/i;
  // The nearest text before el that no other field sits between.
  function textBefore(el, stop) {
    // Eight levels: web components wrap a field deeply (SmartRecruiters puts
    // the question six levels above its input); a level holding another
    // field ends the walk, so no other question's text is taken.
    for (let node = el, depth = 0; node && node !== stop && depth < 8; node = up(node), depth++) {
      for (let s = node.previousSibling; s; s = s.previousSibling) {
        // Only a field someone can use ends it, not a component's hidden helper input.
        if (s.nodeType === 1 && (s.matches(CONTROLS) && usable(s) || controls(s).length)) return '';
        const t = s.nodeType === 1 ? textOf(s) : s.nodeType === 3 ? clean(s.textContent) : '';
        // "Required" under a question (Comeet) names nothing; the question is further up.
        if (t && !MARKER_ONLY.test(t)) return t.slice(0, 300);
      }
    }
    return '';
  }

  const UPLOAD_ONLY = /^(choose|select|browse|attach|upload|drag|drop|choisissez|sélectionnez|déposez|glissez|datei|archivo|selecciona|arrastra|carica|scegli|bestand|kies|העל|בחר)/i;
  // "Choose a file" says nothing about which; "Upload your CV" does, as
  // the planner reads it (lib/match.js, loaded next to this file).
  const uploadOnly = (t) => UPLOAD_ONLY.test(t) && /file|fichier|datei|archivo|bestand|קובץ/i.test(t)
    && !(root.oojMatch && root.oojMatch.classify({ label: t, type: 'file', name: '' }));

  // The nearest heading above el, its section's name. Headings may be web
  // components too (SmartRecruiters' <spl-typography-title data-test="section-title">).
  const HEADING = 'h1, h2, h3, h4, h5, h6, legend, [role="heading"], [data-test*="section-title" i], [class*="section-title" i]';
  function headingBefore(el) {
    for (let node = el, depth = 0; node && depth < 8; node = up(node), depth++) {
      for (let s = node.previousElementSibling; s; s = s.previousElementSibling) {
        const h = s.matches(HEADING) ? s : deep(s, HEADING).pop();
        if (h && textOf(h)) return textOf(h).slice(0, 150);
      }
    }
    return '';
  }

  const GENERIC_HINT = /^(type|enter|select|choose|start typing|search|your answer|e\.?g\.?|\.\.\.)/i;
  function labelOf(el, stop) {
    const own = ownLabel(el);
    if (own && !(el.type === 'file' && uploadOnly(own))) return own;
    if (own) return headingBefore(el) || own;
    // A file input sits in an upload widget ("Choose file", "No file
    // selected"): the text above the widget names it, else the widget's own.
    if (el.type === 'file') {
      let box = el;
      while (up(box) && up(box) !== stop
        && deep(up(box), 'input:not([type="hidden"]), textarea, select').length === 1) box = up(box);
      const t = textBefore(box, stop) || textOf(box).slice(0, 150);
      // "Choose a file or drop it here" names no file: the section's heading
      // does ("CV", "Cover letter"), as on SmartRecruiters.
      if (t && !uploadOnly(t)) return t;
      return headingBefore(box) || t;
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
      const t = byIds(scope(group), group.getAttribute('aria-labelledby')) || clean(group.getAttribute('aria-label'));
      if (t) return t;
    }
    return textBefore(box, stop);
  }

  function selectOptions(el) {
    return [...el.options].filter((o, i) => !o.disabled && !(i === 0 && (o.value === '' || /^(select|choose|please|--)/i.test(clean(o.textContent)))))
      .map((o) => clean(o.textContent)).filter(Boolean);
  }

  // The nearest box the user can see, for the red and amber outlines.
  function mark(el, id) {
    let box = el;
    while (box && !shown(box)) box = up(box);
    if (box) box.setAttribute('data-ooj-box', id);
  }

  let form = null;
  const BARE_YES = /^(yes|i agree|agree|i accept|accept|i understand|i confirm|confirm|ok|ja|oui|sí|si|כן|מסכים|מסכימה|אני מסכים|אני מסכימה|מאשר|מאשרת|אני מאשר|אני מאשרת)[.!]?\s*\*?$/i;

  function fieldsOf(container) {
    for (const old of deep(container, '[data-ooj], [data-ooj-box]')) { old.removeAttribute('data-ooj'); old.removeAttribute('data-ooj-box'); }
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
        // A box that only says "Yes" or "I agree" answers the question above it.
        const own = ownLabel(x[0]);
        const raw = own && !BARE_YES.test(tidy(own)) ? own : [textBefore(x[0], container), own].filter(Boolean).join(' ');
        return { name, label: tidy(raw), type, options: [], required: required || STAR.test(raw) };
      }
      const raw = groupLabel(x, box, container);
      return { name, label: tidy(raw), type, options: x.map((m) => tidy(ownLabel(m) || m.value)), required: required || STAR.test(raw), checked: x.some((m) => m.checked) };
    }).filter((f) => f.label);
  }

  // "Apply", "Apply for this job", "Auf diese Stelle bewerben", "I'm interested",
  // "שליחת קו"ח" (Experis). Not "שלח": Hebrew forms send with that.
  const APPLY = /(?<!\p{L})(apply|bewerben|postuler|postular|postularme|inscribirme|aplicar|candidatar|candidatura|candidati|solliciteer|solliciteren|søk|sök|ansök|hae|aplikuj|jelentkezem|i['’]?m interested|je suis intéressée?(\(e\))?|ich bin interessiert|estoy interesad[oa]|sono interessat[oa]|ik ben geïnteresseerd|tenho interesse|(ל?הגשת|הגש|שליחת) (מועמדות|קו["״”']?ח|קורות חיים))(?!\p{L})/iu;
  const NOT_APPLY = /linkedin|indeed|seek|xing|google|facebook|filter|later|share|save|how to/i;

  // "Apply" links and buttons that lead to the form. Never a form's own
  // submit button: that would send an application.
  const canApply = (el) => !(el.form && el.type === 'submit') && !el.disabled && shown(el);
  function applyControls() {
    return deep(document, 'a, button, [role="button"], input[type="button"]').filter((el) => {
      const t = caption(el);
      return t.length < 40 && APPLY.test(t) && !NOT_APPLY.test(t) && canApply(el);
    });
  }

  function applyControl() {
    const first = applyControls()[0];
    if (first) return first;
    // A button with its own wording ("Join our Kingdom!") still says what
    // it does in its markup.
    const marked = 'a[href*="/apply"], a[href*="/applications/new"], a[data-sr-track="apply"], button[class*="apply" i], button[id*="apply" i], [data-action*="apply" i], [data-action*="form-overlay" i]';
    return [...document.querySelectorAll(marked)].find((el) => canApply(el) && !NOT_APPLY.test(el.textContent)) || null;
  }

  // A single job posting: its Apply controls (one at the top, one at the
  // bottom) all lead to one place. A list of jobs has one per job.
  function postingHere() {
    const els = applyControls();
    const here = location.href.split('#')[0];
    const to = new Set(els.map((el) => (el.href && el.href.split('#')[0] !== here ? el.href.split('#')[0] : 'here')));
    return els.length > 0 && els.length <= 3 && to.size === 1;
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
    // A posting shows its Apply control at once; a form page may still be rendering.
    form = await waitFor(() => findForm() || formFrame(), postingHere() ? 1500 : 6000);
    if (!form) {
      const apply = applyControl();
      if (apply) {
        const href = apply.tagName === 'A' && apply.getAttribute('href');
        if (href && !/^(#|javascript:)/i.test(href) && apply.href.split('#')[0] !== location.href.split('#')[0]) return { openUrl: apply.href };
        // The whole press: a tab (Radix, on Recruitee) switches on mousedown, not on click.
        press(apply);
        form = await waitFor(() => findForm() || formFrame(), 10000);
      }
    }
    if (form && form.tagName === 'IFRAME') return { openUrl: form.src, frame: true };
    if (!form && captcha()) return { error: 'A CAPTCHA stands in front of the form. Solve it, then try again.' };
    if (!form) return { error: 'No application form on this page.' };
    // Each call injects this file again and starts with no form, so the page keeps it.
    for (const doc of docs()) for (const old of doc.querySelectorAll('[data-ooj-form]')) old.removeAttribute('data-ooj-form');
    form.setAttribute('data-ooj-form', '');
    // Web components can draw a label a moment after its field: read until
    // two reads agree.
    let fields = fieldsOf(form);
    for (let i = 0; i < 4; i++) {
      await sleep(700);
      const again = fieldsOf(form);
      const same = again.length === fields.length && again.every((f, j) => f.label === fields[j].label);
      fields = again;
      if (same) break;
    }
    for (const f of fields) if (f.type === 'combobox') f.options = await peekOptions(find(f.name)[0], f);
    return { fields };
  }

  function find(name) {
    for (const doc of docs()) {
      const els = deep(doc, `[data-ooj="${CSS.escape(name)}"]`);
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
    // composed, so a web component's own listeners outside its shadow root hear it too.
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  function leave(el) {
    el.dispatchEvent(new FocusEvent('blur'));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
  }

  function attachCv(el, cv) {
    if (!cv || !cv.data) return 'no CV saved in the extension';
    const win = el.ownerDocument.defaultView;
    const bytes = Uint8Array.from(atob(cv.data), (c) => c.charCodeAt(0));
    const dt = new win.DataTransfer();
    dt.items.add(new win.File([bytes], cv.name, { type: cv.type }));
    el.files = dt.files;
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
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
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true }));
    el.click();
  }

  const typeable = (el) => el.tagName === 'INPUT' && !el.readOnly;

  // The options a custom dropdown shows once open: in the list it points
  // at, else anywhere on the page.
  function listOf(el) {
    const input = el.tagName === 'INPUT' ? el : deep(el, 'input')[0];
    const doc = scope(el);
    const lists = [...new Set([el.getAttribute('aria-controls'), el.getAttribute('aria-owns'), input && input.getAttribute('aria-controls')])]
      .map((id) => id && (doc.getElementById(id) || el.ownerDocument.getElementById(id))).filter(Boolean)
      // Downshift (Recruitee) names its list after the button instead, and keeps closed ones on the page.
      .concat(el.id ? deep(doc, '[role="listbox"][aria-labelledby]').filter((l) => l.getAttribute('aria-labelledby').split(/\s+/).includes(el.id)) : []);
    // Not Workday's chosen-value pills: they are options too, and on show beside every closed dropdown.
    const opts = (lists.length ? lists : [el.ownerDocument]).flatMap((l) => deep(l, '[role="option"]'))
      .filter((o) => shown(o) && !o.closest('[data-automation-id="selectedItemList"]'));
    return opts.length && opts;
  }

  // What a dropdown shows as chosen: Workday's pills in a search prompt, or
  // a list button's caption ("Mobile", "Select One").
  function chosen(el) {
    const box = el.closest('[data-automation-id="multiSelectContainer"]');
    if (box) return deep(box, '[data-automation-id="selectedItem"]').map((p) => clean(p.textContent));
    return el.tagName === 'BUTTON' ? [caption(el)] : [];
  }

  async function close(el) {
    const esc = (t) => t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    esc(el);
    await sleep(100);
    const active = el.ownerDocument.activeElement;
    // Downshift (Recruitee) moves focus into its open list and hears Escape only there.
    if (active && active !== el && active !== el.ownerDocument.body && listOf(el)) esc(active);
    leave(el);
  }

  // A dropdown you cannot type in lists every choice when opened, so read
  // them for the planner and close it again. One you can type in may show
  // only a sample (the first 20 of a thousand schools), so its list counts
  // only when it is short, like a question's answers (SmartRecruiters'
  // searchable dropdowns), and never for a place, which is looked up as typed.
  const PLACE = new Set(['location', 'country', 'phone_country', 'phone_code']);
  async function peekOptions(el, field) {
    const search = typeable(el);
    if (search && root.oojMatch && PLACE.has(root.oojMatch.classify(field))) return [];
    press(el);
    const opts = await waitFor(() => listOf(el), 800);
    const texts = opts ? opts.map((o) => clean(o.textContent)).filter(Boolean) : [];
    await close(el);
    return search && !(texts.length >= 2 && texts.length <= 25) ? [] : texts;
  }

  // Typeahead and custom dropdowns: type, then pick from what the list shows.
  async function chooseOption(el, value, key) {
    const input = el.tagName === 'INPUT' ? el : deep(el, 'input')[0];
    const listed = () => listOf(el);
    const prompt = !!input && input.getAttribute('data-uxi-widget-type') === 'selectinput';
    // Already showing it (Workday sets Country Phone Code from Country): left alone, never reopened.
    if (chosen(el).some((t) => root.oojMatch.pickOption([t], value) === 0)) return null;
    press(el);
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    // "decline" is picked from the list ("Prefer not to say"), never typed
    // into it: typed, it filters every choice away.
    let opts = await waitFor(listed, value === 'decline' ? 3000 : 1000);
    if (input && typeable(input) && value !== 'decline' && (!opts || root.oojMatch.pickOption(opts.map((o) => o.textContent), value) < 0)) {
      setValue(input, key === 'location' ? value.split(',')[0] : value);
      // Workday's prompts search on Enter. shortcut: not yet seen on a live Workday page, check there.
      if (prompt) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      opts = await waitFor(() => { const o = listed(); return o && (root.oojMatch.pickOption(o.map((x) => x.textContent), value) >= 0 || key === 'location') && o; }, 5000) || listed();
    }
    // A typed place with no list keeps what was typed; a Workday prompt's search text is no answer.
    if (!opts && input && input.value && !prompt) return null;
    let i = opts ? root.oojMatch.pickOption(opts.map((o) => o.textContent), value) : -1;
    if (i < 0 && opts && key === 'location') i = 0;
    // Closed again, so the user isn't left with an open list.
    if (i < 0) {
      if (prompt) setValue(input, '');
      await close(input || el);
      return opts ? `no option matches "${value}"` : 'no options to pick from';
    }
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

  // A site that uploads the CV the moment it is attached shows it doing
  // so ("Uploading Resume" on Breezy), and holds the form invalid until it
  // is done: Next or Submit pressed before then is refused.
  const UPLOADING = /^(uploading|upload in progress|subiendo|cargando|téléchargement en cours|envoi en cours|wird hochgeladen|hochladen|caricamento|carregando|enviando|bezig met uploaden|uploaden|מעלה)/i;
  const uploading = (f) => deep(f, 'button, [role="button"], [role="status"], [class*="upload" i], [aria-busy="true"]')
    .some((el) => shown(el) && (el.getAttribute('aria-busy') === 'true' || UPLOADING.test(clean(el.innerText || caption(el)))));

  // The CV goes in first. A site that reads it on arrival (Breezy) fills
  // the form from it when the upload is done, over anything typed before,
  // so the rest waits for that.
  async function fill(fills, cv) {
    const errors = [];
    const files = fills.filter((x) => x.type === 'file');
    for (const f of [...files, ...fills.filter((x) => x.type !== 'file')]) {
      const err = await fillOne(f, cv);
      if (err) errors.push(`${f.label}: ${err}`);
      if (f === files[files.length - 1] && markedForm()) {
        await sleep(500);
        await waitFor(() => !uploading(markedForm()), 30000);
        await sleep(1500);
      }
    }
    // A page that resets its own state late (Breezy, as it reads the CV)
    // can keep a typed value yet still count the field as empty. Telling
    // it once more, with the value as it stands, makes it check again.
    if (files.length) {
      await sleep(1000);
      for (const f of fills) {
        const el = find(f.name)[0];
        if (!el || !/^(INPUT|TEXTAREA)$/.test(el.tagName) || /^(file|radio|checkbox)$/.test(el.type) || !el.value) continue;
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        leave(el);
      }
    }
    return { errors };
  }

  // What a final submit button says, whole: "Submit", "Send application",
  // "Bewerbung absenden", "Envoyer ma candidature", "שלח מועמדות".
  const FINAL = new RegExp(`^(${[
    '(submit|send)( (my|your|the))?( application| candidacy)?( now)?', 'apply( now| for (this|the) (job|position|role))?',
    '(bewerbung )?(absenden|abschicken|senden)', '(jetzt )?bewerben',
    '(sollicitatie )?(versturen|verzenden|indienen)', 'verstuur( je)?( sollicitatie)?', 'solliciteer( nu)?', 'solliciteren',
    '(envoyer|soumettre|valider)( (ma|la|votre) candidature)?', 'postuler( maintenant)?',
    'enviar( (mi |la |tu )?(solicitud|candidatura|postulación))?', 'postular(me)?', 'aplicar',
    '(שלח|שליחה|הגש|הגשת|שליחת)( מועמדות| קורות חיים)?', 'הגשה',
  ].join('|')})$`, 'iu');
  // A button that leads to more questions, not to sending.
  const STEP = /^(next|continue|save and continue|weiter|fortfahren|suivant|continuer|siguiente|continuar|volgende|verder|הבא|המשך)/iu;
  const SOCIAL = /linkedin|indeed|google|facebook|xing|seek|github/i;
  const words = (s) => clean(String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' '));
  const buttonKind = (text) => (STEP.test(words(text)) ? 'step' : FINAL.test(words(text)) ? 'final' : 'other');

  const markedForm = () => docs().map((d) => d.querySelector('[data-ooj-form]')).find(Boolean) || null;

  const captchaIn = (f) => [...f.ownerDocument.querySelectorAll('iframe')].some((x) => /captcha|challenges\.cloudflare/.test(x.src)
    && !/size=invisible/.test(x.src) && x.getBoundingClientRect().width > 50 && shown(x));

  // The buttons that belong to form f, each with its kind. Only buttons
  // inside the form, so never a cookie banner, a link or "Apply with LinkedIn".
  function formButtons(f) {
    // A div form's button often sits just outside its fields' box.
    let box = f;
    const n = controls(f).length;
    for (let i = 0; f.tagName !== 'FORM' && i < 3 && up(box) && up(box) !== f.ownerDocument.body
      && controls(up(box)).length === n; i++) box = up(box);
    const buttons = deep(box, 'button, input[type="submit"], [role="button"]:not(a)')
      .filter((b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true' && shown(b) && !SOCIAL.test(caption(b)));
    return { buttons, kinds: buttons.map((b) => buttonKind(caption(b))) };
  }

  // The form's own button that sends it, or null when that is not clear:
  // none, two of equal weight, a step button (a wizard has more pages), or
  // a CAPTCHA the user has to solve.
  function submitButton() {
    const f = markedForm() || findForm();
    if (!f || captchaIn(f)) return null;
    const { buttons, kinds } = formButtons(f);
    if (kinds.includes('step')) return null;
    // A final wording beats a plain submit type ("Save draft", "Upload").
    const weight = buttons.map((b, i) => (kinds[i] === 'final' ? 2 : f.tagName === 'FORM' && b.type === 'submit' && b.form === f ? 1 : 0));
    const top = Math.max(0, ...weight);
    const best = buttons.filter((b, i) => weight[i] === top);
    return top && best.length === 1 ? best[0] : null;
  }

  // An invisible bot check (reCAPTCHA v3, hCaptcha, Turnstile) scores the
  // click that sends the form, and a click from the extension fails it:
  // "session verification failed due to a human check error" (Comeet,
  // 2026-10-20). Those forms are sent with the site's own button.
  const botCheck = (d) => !!d.querySelector('script[src*="recaptcha"], script[src*="hcaptcha"], script[src*="turnstile"], '
    + 'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare"], .grecaptcha-badge, .h-captcha, .cf-turnstile');

  // The button for the card and the logs, not the element.
  function submitInfo() {
    const f = markedForm() || findForm();
    const bot = !!f && botCheck(f.ownerDocument);
    const b = submitButton();
    if (!b) return bot ? { botCheck: true } : null;
    const sel = b.tagName.toLowerCase() + (b.id ? '#' + CSS.escape(b.id) : '') + (b.getAttribute('type') ? `[type="${b.getAttribute('type')}"]` : '')
      + [...b.classList].slice(0, 2).map((c) => '.' + CSS.escape(c)).join('');
    return { text: caption(b).slice(0, 60), selector: sel, ...(bot ? { botCheck: true } : {}) };
  }

  // A wizard's way to its next page: the form's one button with step
  // wording ("Next", "Continue"). Pressed only by next(), and never when the
  // form also has a final button.
  function stepButton() {
    const f = markedForm() || findForm();
    if (!f || captchaIn(f)) return null;
    const { buttons, kinds } = formButtons(f);
    const steps = buttons.filter((b, i) => kinds[i] === 'step');
    return steps.length === 1 && !kinds.includes('final') ? steps[0] : null;
  }

  // What the form's page is, for telling whether a step moved on: the
  // labels of its fields.
  const pageKey = (f) => controls(f).map((el) => labelOf(el, f)).join('|').slice(0, 2000);

  // Presses the step button; what it returns is what nextOutcome() compares with.
  function next() {
    const b = stepButton();
    if (!b) return null;
    const f = markedForm() || findForm();
    const before = { url: f.ownerDocument.defaultView.location.href, page: pageKey(f), errors: fieldErrors(f) };
    press(b);
    return before;
  }

  // After next(): 'moved' once a new page of questions shows (or the page
  // navigates, which ends this script and leaves the caller with null),
  // {failed} when the form flags something new, null when ms pass.
  async function nextOutcome(before, ms = 15000) {
    for (const until = Date.now() + ms; Date.now() < until;) {
      await sleep(500);
      const f = findForm();
      if (!f) continue;
      if (f.ownerDocument.defaultView.location.href !== before.url || pageKey(f) !== before.page) return 'moved';
      const fresh = fieldErrors(f).filter((e) => !(before.errors || []).includes(e));
      if (fresh.length) return { failed: 'form errors: ' + fresh.slice(0, 3).join(', ') };
    }
    return null;
  }

  // What stops an automatic run before anything is filled: a sign-in or
  // sign-up wall (a password field on show) or a CAPTCHA to solve.
  function wall() {
    const pw = docs().some((d) => deep(d, 'input[type="password"]').some((el) => shown(el) && el.getBoundingClientRect().width > 2));
    return { signIn: pw, captcha: captcha() };
  }

  // A confirmation, in a few languages. Counted, since a posting can say
  // "thank you for your interest" before anything is sent.
  const SENT = /thank(s| you)( so much)? for (applying|your application|your interest|submitting)|application (was |has been )?(successfully )?(received|submitted|sent)|we('ve| have) received your application|we.?ll be in touch|vielen dank für ihre bewerbung|ihre bewerbung (wurde|ist) (erfolgreich )?(eingegangen|versendet|übermittelt|gesendet)|bedankt voor (je|uw) sollicitatie|(je|uw) sollicitatie is (verzonden|ontvangen)|merci (pour|de) votre candidature|votre candidature a (bien )?été (envoyée|reçue|transmise)|gracias por (tu|su) (postulación|candidatura|solicitud)|(tu|su) (candidatura|solicitud|postulación) (ha sido|fue) (enviada|recibida)|תודה על (פנייתך|הגשת|מועמדותך|ההגשה)|מועמדותך (נשלחה|התקבלה)|קורות החיים (נשלחו|התקבלו)/giu;
  const sentCount = (text) => (String(text || '').match(SENT) || []).length;
  // A human check refusing the click: "session verification failed due to
  // a human check error" (Comeet, 2026-10-20).
  const REFUSED = /human check|verification failed|captcha (error|failed)|(confirm|verify) (that )?you('re| are) (a )?human|are you a robot/gi;
  const refusedCount = (text) => (String(text || '').match(REFUSED) || []).length;
  const SENT_URL = /thank|success|confirm|submitted|applied/i;

  // Presses submitButton(); what it returns is what outcome() compares with.
  function submit() {
    const b = submitButton();
    if (!b) return null;
    const doc = b.ownerDocument;
    const f = markedForm() || findForm();
    // The browser itself holds back a form with an empty required field.
    const checked = b.type === 'submit' && b.form && !b.form.noValidate && !b.formNoValidate;
    const held = checked ? [...b.form.querySelectorAll(':invalid')].filter((el) => el.matches(CONTROLS) && usable(el)).map((el) => tidy(labelOf(el, b.form))) : [];
    const before = { url: doc.defaultView.location.href, sent: sentCount(doc.body.innerText), refused: refusedCount(doc.body.innerText), errors: fieldErrors(f), held };
    b.click();
    return before;
  }

  // What the form flags: fields marked invalid, else visible error text.
  function fieldErrors(f) {
    const bad = deep(f, '[aria-invalid="true"]').filter(shown).map((el) => tidy(labelOf(el, f)));
    if (!bad.length) {
      bad.push(...deep(f, '[role="alert"], [class*="error" i], [class*="invalid" i]')
        .filter((el) => shown(el) && !deep(el, CONTROLS).length).map((el) => clean(el.innerText)).filter((t) => t.length < 200));
    }
    return [...new Set(bad.filter(Boolean))];
  }

  // After submit(): 'submitted' when the form went away for good, the
  // address moved to a thank-you page or a confirmation appeared; {failed}
  // when the browser held it back or the form flags something new; null
  // when ms pass with neither. An error already showing before the click
  // ("Unable to fetch address suggestions") says nothing about the send.
  // After a navigation it runs again on the new page with the same before.
  // strict (an automatic run): a form that only went away is not enough,
  // the site has to say so, so that one comes back as unconfirmed.
  async function outcome(before = {}, ms = 20000, strict = false) {
    const failed = (errors) => ({ failed: 'form errors: ' + errors.slice(0, 3).join(', ') });
    if (before.held && before.held.length) return failed(before.held);
    const f = markedForm();
    const until = Date.now() + ms;
    let goneSince = 0;
    for (;;) {
      await sleep(500);
      const doc = f ? f.ownerDocument : document;
      const href = doc.defaultView.location.href;
      const u = new URL(href);
      if (before.url && href !== before.url && SENT_URL.test(u.pathname + u.hash)) return 'submitted';
      if (sentCount(doc.body ? doc.body.innerText : '') > (before.sent || 0)) return 'submitted';
      if (refusedCount(doc.body ? doc.body.innerText : '') > (before.refused || 0)) return { failed: 'captcha: human check refused the click' };
      // A form can hide while it sends and come back; a sent one stays gone.
      const there = f && f.isConnected && shown(f);
      if (f && !there) {
        goneSince = goneSince || Date.now();
        if (Date.now() - goneSince >= 2000 && !strict) return 'submitted';
        if (Date.now() - goneSince >= 8000) return { failed: 'unconfirmed: the form closed without a confirmation' };
      } else goneSince = 0;
      const fresh = there ? fieldErrors(f).filter((e) => !(before.errors || []).includes(e)) : [];
      if (fresh.length) return failed(fresh);
      if (Date.now() >= until) return null;
    }
  }

  // After a fill the user sends the form with the site's own button. Tell
  // the extension when they press it, and when this page then confirms it.
  function watchSend() {
    if (root.oojWatchingSend) return true;
    root.oojWatchingSend = true;
    const note = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);
    const text = () => (document.body ? document.body.innerText : '');
    const pressed = () => {
      const before = { url: location.href, sent: sentCount(text()) };
      note({ type: 'sendClick' });
      const until = Date.now() + 30000;
      const tick = () => {
        const u = new URL(location.href);
        // Ashby's and Workable's own thank-you panels count as well.
        if ((location.href !== before.url && SENT_URL.test(u.pathname + u.hash)) || sentCount(text()) > before.sent
          || document.querySelector('.ashby-application-form-success-container, [data-ui="successful-submit"]')) {
          note({ type: 'sentPage' });
        } else if (Date.now() < until) setTimeout(tick, 1000);
      };
      setTimeout(tick, 1000);
    };
    document.addEventListener('click', (e) => {
      const b = e.composedPath().find((el) => el instanceof Element && el.matches('button, input[type="submit"], [role="button"]'));
      if (b && buttonKind(caption(b)) === 'final') pressed();
    }, true);
    // Enter in a field sends a form with no button pressed.
    document.addEventListener('submit', (e) => { if (!e.submitter) pressed(); }, true);
    return true;
  }

  // On the page a send led to: whether it says the application went through.
  function sentHere(fromUrl) {
    const u = new URL(location.href);
    if (location.href.split('#')[0] === String(fromUrl || '').split('#')[0]) return false;
    return (SENT_URL.test(u.pathname + u.hash) || sentCount(document.body ? document.body.innerText : '') > 0) && formHere().score === 0;
  }

  // For the fill button and for picking the frame to fill: how strongly
  // this document looks like an application form, 0 for not at all.
  // Fields every sign-up, contact and checkout form has: by autocomplete
  // token, or else by label. A form of only these (and tick boxes) asks
  // nothing an application asks, so detect.js offers no fill there.
  const CONTACT_AUTOCOMPLETE = /^(name|honorific-\w+|given-name|family-name|additional-name|nickname|email|tel(-[\w-]+)?|street-address|address-line\d|address-level\d|postal-code|country|country-name|organization|organization-title|cc-[\w-]+|username)$/;
  const CONTACT_LABEL = /^(your |full |first |last |given |family |sur|business |company )?name\b|e-?mail|phone|mobile|\btel\b|address|street|\bcity\b|\bstate\b|province|region|\bzip|postal|post ?code|country|company|business|organi[sz]ation|card|expir|\bcvc\b|\bcvv\b|security code|tax id|\bvat\b|coupon|promo|discount/;
  function contactOnly(fields) {
    const asked = fields.filter((f) => !['checkbox', 'radio'].includes(f.type));
    return asked.length > 0 && asked.every((f) => f.type !== 'file' && f.tag !== 'TEXTAREA' && (
      CONTACT_AUTOCOMPLETE.test(String(f.autocomplete || '').replace(/^(section-\S+ )?(shipping |billing )?/, ''))
      || ['email', 'tel'].includes(f.type) || CONTACT_LABEL.test(clean(f.label).toLowerCase())));
  }

  function formHere() {
    if (!document.body || deep(document, 'input:not([type="hidden"]), textarea, select').length < 3) return { score: 0 };
    const f = findForm();
    if (!f) return { score: 0 };
    const els = controls(f);
    const fields = els.map((el) => ({ type: el.type, tag: el.tagName, autocomplete: el.getAttribute('autocomplete'), label: labelOf(el, f) }));
    return { score: score(els), file: deep(f, 'input[type="file"]').length > 0, contactOnly: contactOnly(fields) };
  }

  root.oojAts = root.oojAts || {};
  root.oojAts.generic = { matches, onSite, read, fill, submit, outcome, formHere, postingHere, submitButton, submitInfo, next, nextOutcome, wall, watchSend, sentHere };
  if (typeof module === 'object' && module.exports) module.exports = { buttonKind, sentCount, contactOnly };
})(globalThis);
