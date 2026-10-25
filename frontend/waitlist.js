// The paid plans' waitlist (the pricing section of index.html, which
// scripts/build_pages.py also makes /pricing from). A member joins with one
// click; signed out, the click opens the sign-in window and the join
// happens once they are back signed in, here or after Google's redirect.
// Joining also subscribes them to the newsletter (api/consent.py).
(function () {
  const buttons = [...document.querySelectorAll("[data-waitlist]")];
  if (!buttons.length) return;
  const KEY = "ooj_waitlist_wanted";
  const signedIn = () => { const t = getAuthTokens(); return !!(t && t.id_token); };

  function mark(plans) {
    for (const b of buttons) {
      if (!plans.includes(b.dataset.waitlist)) continue;
      b.textContent = "You've joined the waitlist";
      b.disabled = true;
    }
  }
  async function join(plan) {
    const mine = buttons.filter((b) => b.dataset.waitlist === plan);
    mine.forEach((b) => { b.disabled = true; });
    try {
      const state = await authedFetch("/me/waitlist", { method: "POST", body: JSON.stringify({ plan }) });
      mark(state.waitlist || [plan]);
    } catch {
      mine.forEach((b) => { b.disabled = false; b.textContent = "Couldn't join. Try again"; });
    }
  }
  function wanted() {
    try { return sessionStorage.getItem(KEY); } catch { return null; }
  }
  function want(plan) {
    try { plan ? sessionStorage.setItem(KEY, plan) : sessionStorage.removeItem(KEY); } catch {}
  }

  for (const b of buttons) {
    b.addEventListener("click", () => {
      if (signedIn()) return join(b.dataset.waitlist);
      want(b.dataset.waitlist);
      window.openSignIn();
      // Signing in with an email code stays on this page.
      const wait = setInterval(() => {
        if (!document.getElementById("signin-scrim") && !signedIn()) { clearInterval(wait); return; }
        if (signedIn()) { clearInterval(wait); finish(); }
      }, 500);
    });
  }
  function finish() {
    const plan = wanted();
    want(null);
    if (plan) join(plan);
  }

  if (signedIn()) {
    if (wanted()) finish();
    else authedFetch("/me/consent").then((s) => mark(s.waitlist || []), () => {});
  }
})();
