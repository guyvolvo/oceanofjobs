// Ashby filler, same shape as ats/greenhouse.js (see the notes there).
// Ashby's job page and its form are two routes of one app: the posting at
// /<board>/<job id>, the form at .../application. formUrl() gives the
// second, which is where the tab opens.
(function (root) {
  const HOST = 'jobs.ashbyhq.com';
  const POSTING = /^\/([^/]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/application)?\/?$/i;

  function onSite(url) {
    try { return new URL(url).hostname === HOST; } catch { return false; }
  }

  function matches(url) {
    let u;
    try { u = new URL(url); } catch { return false; }
    return u.protocol === 'https:' && u.hostname === HOST && POSTING.test(u.pathname);
  }

  function formUrl(url) {
    const u = new URL(url);
    const [, board, id] = u.pathname.match(POSTING);
    u.pathname = `/${board}/${id}/application`;
    return u.href;
  }

  const TYPES = {
    String: 'text', LongText: 'textarea', Email: 'text', Url: 'text', Phone: 'phone', Number: 'number',
    Date: 'date', Boolean: 'boolean', ValueSelect: 'select', MultiValueSelect: 'multiselect',
    Location: 'location', File: 'file',
  };

  // The form definition, options included, is what the page itself asks
  // Ashby's GraphQL for. Asked again here with the same read-only query
  // rather than scraped, since a select's options are only in the DOM once
  // its menu is open. It also waits for the form to render: the background
  // run starts at the load event, before the app has fetched anything.
  // Self-contained because executeScript serialises it.
  async function pageData() {
    const m = location.pathname.match(/^\/([^/]+)\/([0-9a-f-]{36})/i);
    if (!m) return null;
    const ready = () => document.querySelector('.ashby-application-form-container [data-field-path], .ashby-application-form-blocked-application-container');
    for (const until = Date.now() + 15000; !ready() && Date.now() < until;) await new Promise((r) => setTimeout(r, 100));
    const query = `query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) {
      jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) {
        id applicationForm { sections { isHidden fieldEntries { field isRequired isHidden } } } } }`;
    try {
      const res = await fetch('/api/non-user-graphql?op=ApiJobPosting', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operationName: 'ApiJobPosting', query,
          variables: { organizationHostedJobsPageName: decodeURIComponent(m[1]), jobPostingId: m[2] } }),
      });
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    }
  }

  // The GraphQL answer as [{name, label, required, type, options}], name
  // being the field's path, which the DOM carries as data-field-path.
  function fromGraphql(text) {
    let data;
    try { data = JSON.parse(text); } catch { return null; }
    const post = data && data.data && data.data.jobPosting;
    if (!post || !post.applicationForm) return null;
    const fields = [];
    for (const s of post.applicationForm.sections || []) {
      if (s.isHidden) continue;
      for (const e of s.fieldEntries || []) {
        const f = e.field || {};
        if (e.isHidden || !TYPES[f.type]) continue;
        fields.push({
          name: f.path,
          label: String(f.title || '').trim(),
          required: !!e.isRequired,
          type: TYPES[f.type],
          options: f.type === 'Boolean' ? ['Yes', 'No'] : (f.selectableValues || []).map((v) => String(v.label)),
        });
      }
    }
    return { fields, redirectTo: null };
  }

  const entry = (name) => document.querySelector(`.ashby-application-form-container [data-field-path="${CSS.escape(name)}"]`);

  function read(data) {
    const blocked = document.querySelector('.ashby-application-form-blocked-application-container');
    if (blocked) return { error: 'Ashby will not take this application: ' + blocked.textContent.trim().slice(0, 160) };
    const page = data && fromGraphql(data);
    if (!page) return { error: 'application form not found' };
    // Questions Ashby shows only after another answer are not on the page yet.
    page.fields = page.fields.filter((f) => entry(f.name));
    if (!page.fields.length) return { error: 'application form not found' };
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

  function typeInto(box, value) {
    const el = box.querySelector('textarea, input:not([type="file"]):not([type="checkbox"]):not([type="radio"])');
    if (!el) return 'no input to type into';
    setValue(el, value);
    el.dispatchEvent(new FocusEvent('blur'));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    return null;
  }

  // Ashby's date picker parses what is typed in its own format.
  function typeDate(box, value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return `"${value}" is not a date`;
    const el = box.querySelector('input');
    if (!el) return 'no input to type into';
    // A bare yyyy-mm-dd parses as UTC midnight; the UTC parts keep its day.
    const p = (n) => String(n).padStart(2, '0');
    el.focus();
    setValue(el, `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${d.getUTCFullYear()}`);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    return el.value ? null : 'the date did not stick';
  }

  async function chooseYesNo(box, value) {
    const want = root.oojMatch.pickOption(['Yes', 'No'], value);
    const button = want >= 0 && box.querySelector(`[data-option="${want === 0 ? 'yes' : 'no'}"]`);
    if (!button) return `no option matches "${value}"`;
    if (button.getAttribute('aria-pressed') !== 'true') button.click();
    // Pressed shows a moment after the click, not straight away.
    return (await waitFor(() => button.getAttribute('aria-pressed') === 'true', 3000)) ? null : 'the choice did not stick';
  }

  // Radios and checkboxes each sit next to their own label.
  function chooseBox(box, value, type) {
    const inputs = [...box.querySelectorAll(`input[type="${type}"]`)];
    const labels = inputs.map((i) => (box.querySelector(`label[for="${CSS.escape(i.id)}"]`) || i.closest('label') || i.parentElement.parentElement).textContent);
    const i = root.oojMatch.pickOption(labels, value);
    if (i < 0) return `no option matches "${value}"`;
    if (!inputs[i].checked) inputs[i].click();
    return inputs[i].checked ? null : 'the choice did not stick';
  }

  function listed(input) {
    const id = input.getAttribute('aria-controls');
    const list = id && document.getElementById(id);
    return list ? [...list.querySelectorAll('[role="option"]')] : [];
  }

  // Ashby's autocomplete opens and filters on input events, and the
  // location one asks Ashby for places as you type.
  async function chooseOption(input, value, key) {
    input.focus();
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    const typed = key === 'location' ? value.split(',')[0].trim() : value;
    setValue(input, typed);
    let opts = await waitFor(() => listed(input).length && listed(input), key === 'location' ? 8000 : 2000);
    if (!opts && key !== 'location') {
      // The typed text filtered everything out: open the whole list instead.
      setValue(input, '');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, bubbles: true }));
      opts = await waitFor(() => listed(input).length && listed(input), 2000);
    }
    if (!opts) return 'no options to pick from';
    let i = root.oojMatch.pickOption(opts.map((o) => o.textContent), value);
    if (i < 0 && key === 'location') i = 0;
    if (i < 0) return `no option matches "${value}"`;
    const text = opts[i].textContent.trim();
    opts[i].click();
    const stuck = await waitFor(() => input.value.trim() === text, 1500);
    return stuck ? null : 'the choice did not stick';
  }

  function chooseNative(select, value) {
    const i = root.oojMatch.pickOption([...select.options].map((o) => o.textContent), value);
    if (i < 0) return `no option matches "${value}"`;
    select.selectedIndex = i;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return null;
  }

  async function attachCv(box, cv) {
    if (!cv || !cv.data) return 'no CV saved in the extension';
    const input = box.querySelector('input[type="file"]');
    if (!input) return 'no file input';
    const bytes = Uint8Array.from(atob(cv.data), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], cv.name, { type: cv.type }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    // The file's name shows once Ashby has taken it; the upload goes on from there.
    return (await waitFor(() => box.textContent.includes(cv.name), 5000)) ? null : 'the file was not taken';
  }

  async function fillOne(f, cv) {
    const box = entry(f.name);
    if (!box) return 'not on the page';
    if (f.type === 'file') return f.key === 'resume' ? attachCv(box, cv) : 'only the resume can be uploaded';
    if (f.type === 'boolean') return chooseYesNo(box, f.value);
    if (f.type === 'date') return typeDate(box, f.value);
    if (f.type === 'select' || f.type === 'multiselect' || f.type === 'location') {
      const combo = box.querySelector('input[role="combobox"]');
      if (combo) return chooseOption(combo, f.value, f.key);
      const select = box.querySelector('select');
      if (select) return chooseNative(select, f.value);
      if (box.querySelector('input[type="radio"]')) return chooseBox(box, f.value, 'radio');
      if (box.querySelector('input[type="checkbox"]')) return chooseBox(box, f.value, 'checkbox');
      return 'no options to pick from';
    }
    return typeInto(box, f.value);
  }

  async function fill(fills, cv) {
    const errors = [];
    for (const f of fills) {
      const err = await fillOne(f, cv);
      if (err) errors.push(`${f.label}: ${err}`);
    }
    return { errors };
  }

  // The button stays disabled while Ashby saves an answer or uploads a file.
  async function submit() {
    const button = await waitFor(() => {
      const b = document.querySelector('.ashby-application-form-submit-button');
      return b && !b.disabled && b;
    }, 20000);
    if (!button) return false;
    button.click();
    return true;
  }

  // signals: {success, failure, captcha, errors}. Kept apart from the DOM
  // so the tests can feed it.
  function decide(s) {
    if (s.success) return 'submitted';
    if (s.captcha) return { failed: 'captcha' };
    if (s.failure) return { failed: s.failure };
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

  const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();

  function outcome() {
    const failure = document.querySelector('.ashby-application-form-failure-container, .ashby-application-form-blocked-application-container');
    // shortcut: the error classes are CSS-module names with a build hash
    // suffix, matched by prefix; if Ashby renames them a rejected form
    // shows up as "no confirmation" after 45 s instead.
    const errors = [...document.querySelectorAll('.ashby-application-form-container [class*="_validationError_"], .ashby-application-form-container [class*="_errorsContainer_"]')]
      .map(text).filter(Boolean);
    // Real submits (Wayve, monday, Enclave, PointFive on 2026-10-20) went
    // through but showed no success container, so a gone form plus Ashby's
    // thank-you text also counts.
    const formGone = !document.querySelector('.ashby-application-form-container input, .ashby-application-form-container textarea');
    const thanks = /thank(s| you) for (applying|your (application|interest))|application (has been |was )?(submitted|received)|we('ve| have) received your application/i
      .test(document.body ? document.body.innerText : '');
    return decide({
      success: !!document.querySelector('.ashby-application-form-success-container') || (formGone && thanks),
      failure: failure && failure.innerText.replace(/\s+/g, ' ').trim().slice(0, 200),
      captcha: [...document.querySelectorAll('iframe')].some((f) => /recaptcha\/(api2|enterprise)\/bframe|hcaptcha|challenges\.cloudflare/.test(f.src) && visible(f)),
      errors,
    });
  }

  root.oojAts = root.oojAts || {};
  root.oojAts.ashby = { matches, onSite, formUrl, pageData, read, fill, submit, outcome };
  if (typeof module === 'object' && module.exports) module.exports = { matches, onSite, formUrl, fromGraphql, decide };
})(globalThis);
