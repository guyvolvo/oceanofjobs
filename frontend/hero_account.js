// The account corner of the landing and contact pages. Signed out it is
// two words, "Log in", opening the sign-in dialog. Signed in it is "My account"
// with the reader's initial, opening a short menu: the account page, the
// saved listings, alerts, the contact page, and log out. The tokens are
// the same localStorage entry the board and account page keep
// (iljobs_auth_tokens), read only for the address to show; nothing here
// verifies them, the API does that on every request that needs them.
(function () {
  const KEY = "iljobs_auth_tokens";
  const host = document.getElementById("hero-account");
  if (!host) return;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function tokens() {
    try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; }
  }
  function email(idToken) {
    try {
      const payload = JSON.parse(atob(idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      return payload.email || payload["cognito:username"] || "";
    } catch { return ""; }
  }

  const isDark = () => document.documentElement.getAttribute("data-theme") === "dark";
  function toggleTheme() {
    if (isDark()) document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", "dark");
    try { localStorage.setItem("iljobs_theme", isDark() ? "dark" : "light"); } catch {}
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", isDark() ? "#17181c" : "#f2f0ef");
  }

  const icons = {
    person: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="8" cy="5" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M2.5 14c.6-3 2.7-4.5 5.5-4.5s4.9 1.5 5.5 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    bookmark: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M4 2h8v12l-4-3-4 3z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
    send: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M14 2 7 9M14 2l-4.5 12L7 9 2 6.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
    chart: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M2 13.5h12M4 13V8M7.3 13V4.5M10.6 13V9.5M13.9 13V6.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    bell: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M6.5 14a1.5 1.5 0 0 0 3 0" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
    chat: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M2.5 3h11v8h-6l-3 2.5V11h-2z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
    sun: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="8" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3 3l1.1 1.1M11.9 11.9L13 13M13 3l-1.1 1.1M4.1 11.9L3 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    moon: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M13.5 9.5A5.6 5.6 0 0 1 6.5 2.5a5.6 5.6 0 1 0 7 7z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
    close: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
    out: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M6 2.5H3v11h3M10 5l3 3-3 3M13 8H6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  function render() {
    const t = tokens();
    const who = t && t.id_token ? email(t.id_token) : "";
    // The bar's own theme button only exists for the signed-out state,
    // where there is no menu to carry the row.
    const barTheme = document.getElementById("hero-theme");
    if (barTheme) barTheme.hidden = !!who;
    if (!who) {
      host.innerHTML = '<button type="button" class="hero-account-btn" id="hero-signin">Log in</button>';
      // The dialog lives in signin_dialog.js, which every page loads,
      // so the board opens the same one rather than its own panel.
      document.getElementById("hero-signin").addEventListener("click", () => window.openSignIn());
      return;
    }
    checkConsent();
    // Their Google photo when they signed in that way, the first letter
    // of the address otherwise. avatarHtml in auth.js decides which.
    const avatar = avatarHtml(who, t.id_token);
    host.innerHTML = `
      <button type="button" class="hero-account-btn" id="hero-account-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="hero-menu">
        ${avatar}My account
      </button>
      <div class="hero-menu" id="hero-menu" role="menu" hidden>
        <div class="hero-menu-head">${avatar}<span class="hero-menu-email" title="${esc(who)}">${esc(who)}</span></div>
        <a role="menuitem" href="/account">${icons.person}Account</a>
        <a role="menuitem" href="/board?starred=1">${icons.bookmark}Saved jobs</a>
        <a role="menuitem" href="/apply">${icons.send}Auto apply</a>
        <a role="menuitem" href="/account#alerts">${icons.bell}Alerts</a>
        <a role="menuitem" href="/contact">${icons.chat}Contact</a>
        <button type="button" role="menuitem" id="hero-menu-theme">${isDark() ? icons.sun : icons.moon}<span>${isDark() ? "Light mode" : "Dark mode"}</span></button>
        <button type="button" role="menuitem" class="hero-menu-out" id="hero-logout">${icons.out}Log out</button>
      </div>`;
    const btn = document.getElementById("hero-account-btn");
    const menu = document.getElementById("hero-menu");
    const open = (on) => { menu.hidden = !on; btn.setAttribute("aria-expanded", String(on)); };
    btn.addEventListener("click", () => open(menu.hidden));
    document.addEventListener("click", (e) => { if (!host.contains(e.target)) open(false); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") open(false); });
    // The theme row. Repaints itself rather than re-rendering the whole
    // menu, which would shut it on the click that opened the change.
    const themeRow = document.getElementById("hero-menu-theme");
    themeRow.addEventListener("click", () => {
      toggleTheme();
      themeRow.innerHTML = `${isDark() ? icons.sun : icons.moon}<span>${isDark() ? "Light mode" : "Dark mode"}</span>`;
      paintThemeBtn();
    });
    document.getElementById("hero-logout").addEventListener("click", () => {
      // auth.js's signOut, not a second copy of it: signing out also has
      // to forget the CV skills the board keeps in its saved filters,
      // and that lives in one place. It calls render itself, through the
      // sink registered at the bottom of this file.
      signOut();
    });
  }

  // The theme. Written to the same key the board's own toggle writes,
  // so the choice follows a reader between pages.
  //
  // Signed in, it is a row in the account menu. Signed out there is no
  // menu to put it in, so the bar keeps its own button; hiding it in
  // that state would leave a reader no way to change the theme at all.
  const themeBtn = document.getElementById("hero-theme");
  const paintThemeBtn = () => { if (themeBtn) themeBtn.textContent = isDark() ? "Light" : "Dark"; };
  if (themeBtn) {
    themeBtn.addEventListener("click", () => { toggleTheme(); paintThemeBtn(); });
    paintThemeBtn();
  }

  // The terms. The sign-in window's choices go to the account here, on the
  // first page that loads signed in; a member who signed up before it asked
  // gets a banner, and once api/consent.py's lock date passes, a window that
  // stays until they agree or log out (their account can't start anything
  // new until then). Once per page load.
  let consentChecked = false;
  async function checkConsent() {
    if (consentChecked) return;
    consentChecked = true;
    try {
      const state = await syncConsent();
      if (state && !state.agreed) askConsent(state);
    } catch {}
  }
  function lockDate(state) {
    const d = new Date(state.lock_from + "T00:00:00Z");
    return d.getUTCFullYear() > 3000 ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  }
  function askConsent(state) {
    const locked = new Date().toISOString().slice(0, 10) >= state.lock_from;
    if (locked) return openConsent(state, true);
    if (document.getElementById("consent-banner")) return;
    const by = lockDate(state);
    const banner = document.createElement("div");
    banner.id = "consent-banner";
    banner.className = "consent-banner";
    banner.setAttribute("role", "region");
    banner.setAttribute("aria-label", "Updated terms");
    banner.innerHTML = `<span>We've updated our Terms of Service and Privacy Policy.${by ? ` Agree by ${esc(by)} to keep using your account.` : ""}</span>
      <button type="button" class="consent-banner-go">Review and agree</button>
      <button type="button" class="consent-banner-x" aria-label="Hide until the next page">${icons.close}</button>`;
    document.body.appendChild(banner);
    banner.querySelector(".consent-banner-go").addEventListener("click", () => openConsent(state, false));
    banner.querySelector(".consent-banner-x").addEventListener("click", () => banner.remove());
  }
  function openConsent(state, locked) {
    if (document.getElementById("consent-scrim")) return;
    const wrap = document.createElement("div");
    wrap.id = "consent-scrim";
    wrap.className = "signin-scrim";
    wrap.innerHTML = `
      <div class="signin-dialog" role="dialog" aria-modal="true" aria-labelledby="consent-title" aria-describedby="consent-sub">
        <img class="signin-mark" src="/favicon.svg?v=3" width="44" height="44" alt="" />
        <div class="signin-head">
          <h2 id="consent-title">We've updated our terms</h2>
          <p id="consent-sub">Agree to the updated Terms of Service and Privacy Policy to keep using your account.</p>
        </div>
        <div class="signin-consent">
          <label class="signin-check"><input type="checkbox" id="consent-terms"> <span>I agree to the <a href="/terms" target="_blank" rel="noopener">Terms of Service</a> and <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a></span></label>
          <label class="signin-check"><input type="checkbox" id="consent-news"${state.newsletter ? " checked" : ""}> <span>Email me about new features and product updates</span></label>
        </div>
        <p class="auth-error" id="consent-error" role="alert" hidden></p>
        <button class="signin-primary" type="button" id="consent-go">Continue</button>
        <button class="signin-back" type="button" id="consent-out">Log out</button>
        ${locked ? "" : `<button type="button" class="signin-close" id="consent-close" aria-label="Close">${icons.close}</button>`}
      </div>`;
    document.body.appendChild(wrap);
    const $ = (id) => document.getElementById(id);
    const close = () => { wrap.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape" && !locked) close(); };
    document.addEventListener("keydown", onKey);
    if (!locked) $("consent-close").addEventListener("click", close);
    $("consent-out").addEventListener("click", () => { close(); signOut(); });
    $("consent-terms").addEventListener("change", () => { if ($("consent-terms").checked) $("consent-error").hidden = true; });
    $("consent-go").addEventListener("click", async () => {
      const err = $("consent-error");
      if (!$("consent-terms").checked) {
        err.textContent = "Agree to the Terms of Service and Privacy Policy to continue.";
        err.hidden = false;
        $("consent-terms").focus();
        return;
      }
      $("consent-go").disabled = true;
      try {
        await authedFetch("/me/consent", { method: "POST", body: JSON.stringify({ newsletter: $("consent-news").checked, via: "prompt" }) });
        try { localStorage.setItem(CONSENT_AGREED_KEY, CONSENT_VERSION); } catch {}
        document.getElementById("consent-banner")?.remove();
        close();
      } catch {
        err.textContent = "Couldn't save that. Try again.";
        err.hidden = false;
        $("consent-go").disabled = false;
      }
    });
    $("consent-terms").focus();
  }

  setAuthRenderSink(render);
  render();
})();
