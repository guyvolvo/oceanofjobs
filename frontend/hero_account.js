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

  // Google's Material Symbols (Outlined, weight 400, 24px); github is GitHub's own mark.


  const icons = {
    person: '<svg viewBox="0 -960 960 960" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M367-527q-47-47-47-113t47-113q47-47 113-47t113 47q47 47 47 113t-47 113q-47 47-113 47t-113-47ZM160-160v-112q0-34 17.5-62.5T224-378q62-31 126-46.5T480-440q66 0 130 15.5T736-378q29 15 46.5 43.5T800-272v112H160Zm80-80h480v-32q0-11-5.5-20T700-306q-54-27-109-40.5T480-360q-56 0-111 13.5T260-306q-9 5-14.5 14t-5.5 20v32Zm296.5-343.5Q560-607 560-640t-23.5-56.5Q513-720 480-720t-56.5 23.5Q400-673 400-640t23.5 56.5Q447-560 480-560t56.5-23.5ZM480-640Zm0 400Z"/></svg>',
    bookmark: '<svg viewBox="0 -960 960 960" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M200-120v-640q0-33 23.5-56.5T280-840h400q33 0 56.5 23.5T760-760v640L480-240 200-120Zm80-122 200-86 200 86v-518H280v518Zm0-518h400-400Z"/></svg>',
    send: '<svg viewBox="0 -960 960 960" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M120-160v-640l760 320-760 320Zm80-120 474-200-474-200v140l240 60-240 60v140Zm0 0v-400 400Z"/></svg>',
    chart: '<svg viewBox="0 -960 960 960" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M640-160v-280h160v280H640Zm-240 0v-640h160v640H400Zm-240 0v-440h160v440H160Z"/></svg>',
    bell: '<svg viewBox="0 -960 960 960" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M160-200v-80h80v-280q0-83 50-147.5T420-792v-28q0-25 17.5-42.5T480-880q25 0 42.5 17.5T540-820v28q80 20 130 84.5T720-560v280h80v80H160Zm320-300Zm0 420q-33 0-56.5-23.5T400-160h160q0 33-23.5 56.5T480-80ZM320-280h320v-280q0-66-47-113t-113-47q-66 0-113 47t-47 113v280Z"/></svg>',
    chat: '<svg viewBox="0 -960 960 960" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M240-400h320v-80H240v80Zm0-120h480v-80H240v80Zm0-120h480v-80H240v80ZM80-80v-720q0-33 23.5-56.5T160-880h640q33 0 56.5 23.5T880-800v480q0 33-23.5 56.5T800-240H240L80-80Zm126-240h594v-480H160v525l46-45Zm-46 0v-480 480Z"/></svg>',
    sun: '<svg viewBox="0 -960 960 960" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M565-395q35-35 35-85t-35-85q-35-35-85-35t-85 35q-35 35-35 85t35 85q35 35 85 35t85-35Zm-226.5 56.5Q280-397 280-480t58.5-141.5Q397-680 480-680t141.5 58.5Q680-563 680-480t-58.5 141.5Q563-280 480-280t-141.5-58.5ZM200-440H40v-80h160v80Zm720 0H760v-80h160v80ZM440-760v-160h80v160h-80Zm0 720v-160h80v160h-80ZM256-650l-101-97 57-59 96 100-52 56Zm492 496-97-101 53-55 101 97-57 59Zm-98-550 97-101 59 57-100 96-56-52ZM154-212l101-97 55 53-97 101-59-57Zm326-268Z"/></svg>',
    moon: '<svg viewBox="0 -960 960 960" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M480-120q-150 0-255-105T120-480q0-150 105-255t255-105q14 0 27.5 1t26.5 3q-41 29-65.5 75.5T444-660q0 90 63 153t153 63q55 0 101-24.5t75-65.5q2 13 3 26.5t1 27.5q0 150-105 255T480-120Zm0-80q88 0 158-48.5T740-375q-20 5-40 8t-40 3q-123 0-209.5-86.5T364-660q0-20 3-40t8-40q-78 32-126.5 102T200-480q0 116 82 198t198 82Zm-10-270Z"/></svg>',
    close: '<svg viewBox="0 -960 960 960" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="m256-200-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z"/></svg>',
    out: '<svg viewBox="0 -960 960 960" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h280v80H200v560h280v80H200Zm440-160-55-58 102-102H360v-80h327L585-622l55-58 200 200-200 200Z"/></svg>',
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

  // The sign-in window's choices (terms, product updates) go to the account
  // here, on the first page that loads signed in. Later changes to the terms
  // are announced by email, so nobody is asked again. Once per page load.
  let consentChecked = false;
  async function checkConsent() {
    if (consentChecked) return;
    consentChecked = true;
    try { await syncConsent(); } catch {}
  }

  setAuthRenderSink(render);
  render();
})();
