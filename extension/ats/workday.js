// Workday: a company's careers site on *.myworkdayjobs.com or
// *.myworkdaysite.com. Applying takes a candidate account on that
// company's own site, so a run first opens the form (Apply, then Apply
// Manually) and signs in with the user's email and the Workday password
// set in the extension's options, creating the account when there is
// none. The pages after that (My Information, My Experience, the
// company's questions, Voluntary Disclosures, Review) are read, filled and
// stepped through by ats/generic.js, loaded next to this file; what is
// Workday's own is here: getting in, and knowing the application went in.
// Every control is found by its data-automation-id, which Workday keeps
// the same on every company's site.
(function (root) {
  const HOST = /\.(myworkdayjobs|myworkdaysite)\.com$/;

  function onSite(url) {
    try { return HOST.test(new URL(url).hostname); } catch { return false; }
  }

  // One posting: .../job/<location>/<title>_<requisition id>, or a step of
  // its application (.../apply/...).
  function matches(url) {
    try { return onSite(url) && /\/job\/[^/]+\/[^/]+_[A-Za-z0-9-]+/.test(new URL(url).pathname); } catch { return false; }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(fn, ms) {
    for (const until = Date.now() + ms; Date.now() < until; await sleep(250)) {
      const v = fn();
      if (v) return v;
    }
    return fn();
  }
  const shown = (el) => el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : el.getClientRects().length > 0;
  const $ = (id) => [...document.querySelectorAll(`[data-automation-id="${id}"]`)].find(shown) || null;
  const text = () => (document.body ? document.body.innerText : '');

  function press(el) {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    el.click();
  }

  // Workday lays a transparent "click_filter" over its form buttons and
  // listens there; a press on the button alone can go unheard.
  function pressButton(el) {
    const filter = el.parentElement && el.parentElement.querySelector('[data-automation-id="click_filter"]');
    press(filter || el);
  }

  function type(el, value) {
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('blur'));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  }

  // The application's pages, pinned for generic.js so it reads the form
  // and not the site's header or the similar jobs.
  function pin() {
    const page = $('applyFlowPage');
    if (page && !page.hasAttribute('data-ooj-root')) page.setAttribute('data-ooj-root', '');
    return !!page;
  }

  const CLOSED = /no longer (accepting|available|open)|(job|position|posting) (is |has been )?(closed|filled|expired)|page you are looking for (doesn't|does not) exist/i;

  // Opens the application from the posting. {at: 'account'} on the sign-in
  // page, {at: 'form'} on a step of the form, {error} when there is no way
  // in. Runs again after a navigation, so it starts wherever the tab is.
  async function enter() {
    // The progress bar draws before the sign-in box, and its first step is
    // the sign-in: on that step it's the account, never the form.
    const step = () => ($('progressBarActiveStep') || {}).innerText || '';
    const inside = () => (pin() && ($('signInContent') || /sign in|create account/i.test(step()) ? 'account'
      : $('progressBar') || $('pageFooterNextButton') || $('bottom-navigation-next-button') ? 'form' : null));
    let at = await waitFor(inside, 3000);
    if (at) return { at };
    const apply = await waitFor(() => $('adventureButton'), 15000);
    if (!apply) return { error: CLOSED.test(text()) ? 'job closed' : 'application form not found' };
    press(apply);
    const manual = await waitFor(() => $('applyManually'), 10000);
    // A site with no choice to make goes straight to the form.
    if (manual) press(manual);
    at = await waitFor(inside, 20000);
    return at ? { at } : { error: 'application form not found' };
  }

  const problem = () => {
    const el = $('errorMessage') || [...document.querySelectorAll('[role="alert"]')].find((e) => shown(e) && e.innerText.trim());
    return el ? el.innerText.trim().slice(0, 200) : '';
  };
  const VERIFY = /verify (your )?(email|account)|verification (email|link|code)|check your (email|inbox)|we (have )?sent (you )?an email/i;

  // Signs in, or creates the account when Workday has none for the email.
  // 'in' once past it, {verify: true} when Workday emailed a link to click
  // first, {failed: reason} otherwise. Never fills the "beecatcher" trap.
  async function account(email, password) {
    if (!(await waitFor(() => $('signInContent'), 10000))) return 'in';
    const byEmail = $('SignInWithEmailButton');
    if (byEmail) press(byEmail);
    if (await waitFor(() => $('createAccountSubmitButton'), 1500) && $('signInLink')) press($('signInLink'));
    const signIn = await waitFor(() => $('signInSubmitButton') && $('email') && $('password'), 8000);
    if (!signIn) return { failed: 'Workday sign-in form not found' };
    type($('email'), email);
    type($('password'), password);
    // Workday reads the fields once React has re-rendered; a press in the
    // same moment goes out with the form still empty, or not at all.
    await sleep(600);
    pressButton($('signInSubmitButton'));
    const tried = await waitFor(() => (!$('signInContent') ? 'in' : problem() || VERIFY.test(text()) && 'verify'), 15000);
    if (tried === 'in') { pin(); return 'in'; }
    if (tried === 'verify') return { verify: true };
    // No account with this email: make one. A wrong password for an
    // account that does exist is refused again here, with Workday's words.
    const create = $('createAccountLink');
    if (!create) return { failed: 'Workday sign-in: ' + (tried || 'no answer') };
    press(create);
    const form = await waitFor(() => $('createAccountSubmitButton') && $('verifyPassword'), 8000);
    if (!form) return { failed: 'Workday account form not found' };
    type($('email'), email);
    type($('password'), password);
    type($('verifyPassword'), password);
    await sleep(400);
    const agree = $('createAccountCheckbox');
    if (agree && !agree.checked) press(agree);
    await sleep(600);
    pressButton($('createAccountSubmitButton'));
    const made = await waitFor(() => (!$('signInContent') ? 'in' : VERIFY.test(text()) ? 'verify' : problem()), 20000);
    if (made === 'in') { pin(); return 'in'; }
    if (made === 'verify') return { verify: true };
    return { failed: 'Workday account: ' + (made || 'no answer') };
  }

  // Workday's own sign-in page, outside any application: where some sites
  // send a new account. Signs in there; the caller goes back to the job.
  // 'in', {verify: true} when the account isn't confirmed yet, or {failed}.
  async function signInPage(email, password) {
    const byEmail = await waitFor(() => $('SignInWithEmailButton') || $('signInSubmitButton'), 10000);
    if (!byEmail) return { failed: 'Workday sign-in form not found' };
    if (byEmail === $('SignInWithEmailButton')) press(byEmail);
    if (!(await waitFor(() => $('signInSubmitButton') && $('email') && $('password'), 8000))) return { failed: 'Workday sign-in form not found' };
    type($('email'), email);
    type($('password'), password);
    await sleep(600);
    pressButton($('signInSubmitButton'));
    const r = await waitFor(() => (!$('signInSubmitButton') ? 'in' : VERIFY.test(text()) ? 'verify' : problem()), 15000);
    if (r === 'in') return 'in';
    if (r === 'verify' || /verif|confirm/i.test(r || '')) return { verify: true };
    return { failed: 'Workday sign-in: ' + (r || 'no answer') };
  }

  // After the Review page's Submit: Workday's own confirmation, then the
  // general check in its strict mode (a form that only went away is
  // unconfirmed).
  const DONE = /application (has been |was )?(successfully )?submitted|thank(s| you) for (applying|your application|submitting)|congratulations/i;
  async function outcome(before = {}, ms = 20000) {
    const until = Date.now() + ms;
    for (;;) {
      if (!$('pageFooterNextButton') && !$('bottom-navigation-next-button') && DONE.test(text())) return 'submitted';
      const fresh = problem();
      if (fresh && !(before.errors || []).includes(fresh)) return { failed: 'form errors: ' + fresh };
      if (Date.now() >= until) return root.oojAts.generic.outcome(before, 1000, true);
      await sleep(500);
    }
  }

  root.oojAts = root.oojAts || {};
  root.oojAts.workday = { matches, onSite, enter, account, signInPage, outcome };
  if (typeof module === 'object' && module.exports) module.exports = { matches, onSite, DONE, VERIFY };
})(globalThis);
