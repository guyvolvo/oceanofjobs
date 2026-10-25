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
    } catch (e) {
      // The last Pro place went while the page was open: offer Basic, as a full count does.
      if (e && e.status === 409 && plan === "pro") return offerBasic(mine);
      mine.forEach((b) => { b.disabled = false; b.textContent = "Couldn't join. Try again"; });
    }
  }
  function offerBasic(pro) {
    for (const b of pro) {
      b.dataset.waitlist = "basic";
      b.disabled = false;
      const text = b.querySelector(":scope > span:first-child");
      if (text) {
        text.firstChild.textContent = "All Pro beta licenses are taken. Join the Basic waitlist instead";
        const left = text.querySelector("[data-waitlist-left]");
        if (left) left.hidden = true;
      } else b.textContent = "Join the Basic waitlist";
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

  // The homepage line says "Sign up" signed out and "Join" signed in.
  if (signedIn()) for (const el of document.querySelectorAll(".home-beta [data-signed-out]")) el.textContent = "Join";
  // Pro has a set number of beta licenses; Basic has no limit. The count
  // is public (GET /api/waitlist) and shown under every Pro button. Once
  // it's full, a Pro button offers the Basic waitlist instead, except to
  // someone already on Pro, so their own lists are read first.
  const joined = signedIn() && !wanted()
    ? authedFetch("/me/consent").then((s) => s.waitlist || [], () => [])
    : Promise.resolve([]);
  const counts = fetch("/api/waitlist").then((r) => (r.ok ? r.json() : null), () => null);
  Promise.all([joined, counts]).then(([plans, c]) => {
    const pro = c && c.pro;
    if (pro && pro.cap) {
      const left = Math.max(0, pro.cap - pro.taken);
      for (const el of document.querySelectorAll("[data-waitlist-left]")) {
        const bar = document.createElement("span");
        bar.className = "wl-bar";
        bar.appendChild(document.createElement("i")).style.width = `${Math.min(100, (pro.taken / pro.cap) * 100)}%`;
        el.replaceChildren(bar, left ? `${left} of ${pro.cap} beta licenses left` : `All ${pro.cap} beta licenses are taken`);
        el.hidden = false;
      }
      if (!left && !plans.includes("pro")) {
        offerBasic(buttons.filter((x) => x.dataset.waitlist === "pro"));
      }
    }
    mark(plans);
  });
  if (signedIn() && wanted()) finish();
})();
