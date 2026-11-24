// One menu for every page, on a phone only.
//
// The top bar was four or five controls in a row: the site's name, the
// repository, the theme, the account, and on the board a status light
// and a ticker as well. At 390px that reads as a wall before a reader
// has seen a single word of the page.
//
// So on a phone the bar is three stepped rules at the left edge, and
// everything it held opens downward as one list.
//
// Nothing here owns any behaviour. The theme button, the sign-in
// dialog and the account state all live where they already lived; this
// builds a list that points at them, so there is one implementation of
// each and this cannot drift from it. The only thing it reads for
// itself is the address to show at the top of the list, and it reads
// that the same way every other surface does.
(function () {
  const BREAKPOINT = 640;
  const KEY = "iljobs_auth_tokens";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // The bar this page happens to have. The landing and contact pages
  // carry the display-face header; everything else carries the board's
  // dense topbar, whose controls sit in .topnav.
  const hero = document.querySelector("header.hero-bar-head");
  const topbar = document.querySelector(".topbar > .container");
  const host = hero || topbar;
  if (!host) return;
  // The panel hangs off the bar rather than sitting inside its row, so
  // it covers the page instead of shoving it down. On the board that
  // means the sticky .topbar, which is the element with the background
  // and the stacking context; on the hero pages the header is both.
  const outer = hero || document.querySelector(".topbar");

  // Google's Material Symbols (Outlined, weight 400, 24px); github is GitHub's own mark.


  const icons = {
    person: '<svg viewBox="0 -960 960 960" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M367-527q-47-47-47-113t47-113q47-47 113-47t113 47q47 47 47 113t-47 113q-47 47-113 47t-113-47ZM160-160v-112q0-34 17.5-62.5T224-378q62-31 126-46.5T480-440q66 0 130 15.5T736-378q29 15 46.5 43.5T800-272v112H160Zm80-80h480v-32q0-11-5.5-20T700-306q-54-27-109-40.5T480-360q-56 0-111 13.5T260-306q-9 5-14.5 14t-5.5 20v32Zm296.5-343.5Q560-607 560-640t-23.5-56.5Q513-720 480-720t-56.5 23.5Q400-673 400-640t23.5 56.5Q447-560 480-560t56.5-23.5ZM480-640Zm0 400Z"/></svg>',
    bookmark: '<svg viewBox="0 -960 960 960" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M200-120v-640q0-33 23.5-56.5T280-840h400q33 0 56.5 23.5T760-760v640L480-240 200-120Zm80-122 200-86 200 86v-518H280v518Zm0-518h400-400Z"/></svg>',
    send: '<svg viewBox="0 -960 960 960" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M120-160v-640l760 320-760 320Zm80-120 474-200-474-200v140l240 60-240 60v140Zm0 0v-400 400Z"/></svg>',
    chart: '<svg viewBox="0 -960 960 960" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M640-160v-280h160v280H640Zm-240 0v-640h160v640H400Zm-240 0v-440h160v440H160Z"/></svg>',
    bell: '<svg viewBox="0 -960 960 960" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M160-200v-80h80v-280q0-83 50-147.5T420-792v-28q0-25 17.5-42.5T480-880q25 0 42.5 17.5T540-820v28q80 20 130 84.5T720-560v280h80v80H160Zm320-300Zm0 420q-33 0-56.5-23.5T400-160h160q0 33-23.5 56.5T480-80ZM320-280h320v-280q0-66-47-113t-113-47q-66 0-113 47t-47 113v280Z"/></svg>',
    chat: '<svg viewBox="0 -960 960 960" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M240-400h320v-80H240v80Zm0-120h480v-80H240v80Zm0-120h480v-80H240v80ZM80-80v-720q0-33 23.5-56.5T160-880h640q33 0 56.5 23.5T880-800v480q0 33-23.5 56.5T800-240H240L80-80Zm126-240h594v-480H160v525l46-45Zm-46 0v-480 480Z"/></svg>',
    building: '<svg viewBox="0 -960 960 960" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M120-120v-560h160v-160h400v320h160v400H520v-160h-80v160H120Zm80-80h80v-80h-80v80Zm0-160h80v-80h-80v80Zm0-160h80v-80h-80v80Zm160 160h80v-80h-80v80Zm0-160h80v-80h-80v80Zm0-160h80v-80h-80v80Zm160 320h80v-80h-80v80Zm0-160h80v-80h-80v80Zm0-160h80v-80h-80v80Zm160 480h80v-80h-80v80Zm0-160h80v-80h-80v80Z"/></svg>',
    tag: '<svg viewBox="0 -960 960 960" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M856-390 570-104q-12 12-27 18t-30 6q-15 0-30-6t-27-18L103-457q-11-11-17-25.5T80-513v-287q0-33 23.5-56.5T160-880h287q16 0 31 6.5t26 17.5l352 353q12 12 17.5 27t5.5 30q0 15-5.5 29.5T856-390ZM513-160l286-286-353-354H160v286l353 354ZM260-640q25 0 42.5-17.5T320-700q0-25-17.5-42.5T260-760q-25 0-42.5 17.5T200-700q0 25 17.5 42.5T260-640Zm220 160Z"/></svg>',
    book: '<svg viewBox="0 -960 960 960" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M560-564v-68q33-14 67.5-21t72.5-7q26 0 51 4t49 10v64q-24-9-48.5-13.5T700-600q-38 0-73 9.5T560-564Zm0 220v-68q33-14 67.5-21t72.5-7q26 0 51 4t49 10v64q-24-9-48.5-13.5T700-380q-38 0-73 9t-67 27Zm0-110v-68q33-14 67.5-21t72.5-7q26 0 51 4t49 10v64q-24-9-48.5-13.5T700-490q-38 0-73 9.5T560-454ZM260-320q47 0 91.5 10.5T440-278v-394q-41-24-87-36t-93-12q-36 0-71.5 7T120-692v396q35-12 69.5-18t70.5-6Zm260 42q44-21 88.5-31.5T700-320q36 0 70.5 6t69.5 18v-396q-33-14-68.5-21t-71.5-7q-47 0-93 12t-87 36v394Zm-40 118q-48-38-104-59t-116-21q-42 0-82.5 11T100-198q-21 11-40.5-1T40-234v-482q0-11 5.5-21T62-752q46-24 96-36t102-12q58 0 113.5 15T480-740q51-30 106.5-45T700-800q52 0 102 12t96 36q11 5 16.5 15t5.5 21v482q0 23-19.5 35t-40.5 1q-37-20-77.5-31T700-240q-60 0-116 21t-104 59ZM280-494Z"/></svg>',
    board: '<svg viewBox="0 -960 960 960" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M520-600v-240h320v240H520ZM120-440v-400h320v400H120Zm400 320v-400h320v400H520Zm-400 0v-240h320v240H120Zm80-400h160v-240H200v240Zm400 320h160v-240H600v240Zm0-480h160v-80H600v80ZM200-200h160v-80H200v80Zm160-320Zm240-160Zm0 240ZM360-280Z"/></svg>',
    github: '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>',
    sun: '<svg viewBox="0 -960 960 960" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M565-395q35-35 35-85t-35-85q-35-35-85-35t-85 35q-35 35-35 85t35 85q35 35 85 35t85-35Zm-226.5 56.5Q280-397 280-480t58.5-141.5Q397-680 480-680t141.5 58.5Q680-563 680-480t-58.5 141.5Q563-280 480-280t-141.5-58.5ZM200-440H40v-80h160v80Zm720 0H760v-80h160v80ZM440-760v-160h80v160h-80Zm0 720v-160h80v160h-80ZM256-650l-101-97 57-59 96 100-52 56Zm492 496-97-101 53-55 101 97-57 59Zm-98-550 97-101 59 57-100 96-56-52ZM154-212l101-97 55 53-97 101-59-57Zm326-268Z"/></svg>',
    moon: '<svg viewBox="0 -960 960 960" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M480-120q-150 0-255-105T120-480q0-150 105-255t255-105q14 0 27.5 1t26.5 3q-41 29-65.5 75.5T444-660q0 90 63 153t153 63q55 0 101-24.5t75-65.5q2 13 3 26.5t1 27.5q0 150-105 255T480-120Zm0-80q88 0 158-48.5T740-375q-20 5-40 8t-40 3q-123 0-209.5-86.5T364-660q0-20 3-40t8-40q-78 32-126.5 102T200-480q0 116 82 198t198 82Zm-10-270Z"/></svg>',
    out: '<svg viewBox="0 -960 960 960" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h280v80H200v560h280v80H200Zm440-160-55-58 102-102H360v-80h327L585-622l55-58 200 200-200 200Z"/></svg>',
  };

  function email() {
    try {
      const t = JSON.parse(localStorage.getItem(KEY) || "null");
      if (!t || !t.id_token) return "";
      const p = JSON.parse(atob(t.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      return p.email || p["cognito:username"] || "";
    } catch { return ""; }
  }

  // The page's own theme button, wherever it lives. Forwarding a click
  // to it keeps one implementation of the theme rather than a second
  // one here that has to remember the same storage key.
  const themeBtn = () => document.getElementById("hero-theme") || document.getElementById("theme-toggle");
  const isDark = () => document.documentElement.getAttribute("data-theme") === "dark";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "hero-nav-toggle";
  toggle.id = "mobile-nav-toggle";
  toggle.setAttribute("aria-label", "Menu");
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", "mobile-nav-panel");
  toggle.innerHTML = '<span class="hero-nav-bars" aria-hidden="true"><i></i><i></i><i></i></span>';

  const panel = document.createElement("nav");
  panel.className = "hero-nav-panel";
  panel.id = "mobile-nav-panel";
  panel.setAttribute("aria-label", "Menu");
  // Not [hidden]: it has to be in the layout to be measured and to
  // animate. visibility in the stylesheet keeps it out of the tab order
  // and off a screen reader while it is closed.
  panel.setAttribute("aria-hidden", "true");

  // First child, so it is the left edge of the bar and the first thing
  // a keyboard reaches.
  host.insertBefore(toggle, host.firstChild);
  outer.appendChild(panel);

  // The board itself, not merely a page that borrows the board's bar.
  // The first version asked whether this page had that bar, which is
  // true of the account, stats and privacy pages too, so the one link
  // most of them needed was the one they did not get.
  const onBoard = () => !!document.getElementById("jobs-body");

  function build() {
    const who = email();
    const rows = [];
    if (who) {
      rows.push(`<div class="hero-nav-who"><span class="hero-avatar" aria-hidden="true">${esc(who[0].toUpperCase())}</span><span class="hero-nav-email">${esc(who)}</span></div>`);
    } else {
      rows.push(`<button type="button" class="hero-nav-item hero-nav-signin" data-act="signin">${icons.person}Log in</button>`);
    }
    // The shared header (every page but the homepage): its own sections,
    // read from the bar, so the phone list is the same site map.
    const shared = document.querySelector(".site-header .site-menus");
    if (shared) {
      for (const el of shared.children) {
        if (el.matches(".site-menu-link")) {
          rows.push(`<a class="hero-nav-item" href="${esc(el.getAttribute("href"))}">${esc(el.textContent)}</a>`);
          continue;
        }
        rows.push(`<div class="hero-nav-group">${esc(el.querySelector(".site-menu-btn").textContent)}</div>`);
        for (const a of el.querySelectorAll(".site-menu-item")) {
          rows.push(`<a class="hero-nav-item" href="${esc(a.getAttribute("href"))}">${esc(a.textContent)}</a>`);
        }
      }
      if (who) {
        rows.push(`<div class="hero-nav-group">Account</div>`);
        rows.push(`<a class="hero-nav-item" href="/account">${icons.person}Account</a>`);
        rows.push(`<a class="hero-nav-item" href="/account#alerts">${icons.bell}Alerts</a>`);
      }
      rows.push(`<button type="button" class="hero-nav-item" data-act="theme">${isDark() ? icons.sun : icons.moon}${isDark() ? "Light mode" : "Dark mode"}</button>`);
      if (who) rows.push(`<button type="button" class="hero-nav-item hero-nav-out" data-act="signout">${icons.out}Log out</button>`);
      panel.innerHTML = '<div class="hero-nav-list">' + rows.join("") + "</div>";
      return;
    }
    // The desktop header's menus, in its order: Jobs, Companies, Docs, Pricing, then Contact below.
    if (!onBoard()) rows.push(`<a class="hero-nav-item" href="/board">${icons.board}Jobs</a>`);
    if (location.pathname !== "/companies") rows.push(`<a class="hero-nav-item" href="/companies">${icons.building}Companies</a>`);
    rows.push(`<a class="hero-nav-item" href="/docs">${icons.book}Docs</a>`);
    if (location.pathname !== "/pricing") rows.push(`<a class="hero-nav-item" href="/pricing">${icons.tag}Pricing</a>`);
    if (who) {
      rows.push(`<a class="hero-nav-item" href="/account">${icons.person}Account</a>`);
      rows.push(`<a class="hero-nav-item" href="/board?starred=1">${icons.bookmark}Saved jobs</a>`);
      rows.push(`<a class="hero-nav-item" href="/apply">${icons.send}Auto apply</a>`);
      rows.push(`<a class="hero-nav-item" href="/account#alerts">${icons.bell}Alerts</a>`);
    }
    rows.push(`<a class="hero-nav-item" href="/contact">${icons.chat}Contact</a>`);
    rows.push(`<a class="hero-nav-item" href="https://github.com/guyvolvo/oceanofjobs" target="_blank" rel="noopener">${icons.github}GitHub</a>`);
    rows.push(`<button type="button" class="hero-nav-item" data-act="theme">${isDark() ? icons.sun : icons.moon}${isDark() ? "Light mode" : "Dark mode"}</button>`);
    if (who) rows.push(`<button type="button" class="hero-nav-item hero-nav-out" data-act="signout">${icons.out}Log out</button>`);
    // Wrapped, because the slide is a transform on the list and the
    // clipping is on the panel around it. See .hero-nav-list in
    // style.css for why it is done that way rather than on a height.
    panel.innerHTML = '<div class="hero-nav-list">' + rows.join("") + "</div>";
  }

  let open = false;

  function setOpen(on) {
    if (on) {
      build();
      // The list is a brand new element every time it is built, and a
      // new element with the open class already on its ancestor paints
      // straight at its final position: there is no earlier state to
      // ease from. Reading a layout value here forces the browser to
      // settle it parked above the window first, so the class below has
      // something to move it from. Without this the menu appears rather
      // than arrives, which is what the first version of it did.
      void panel.offsetHeight;
    }
    panel.setAttribute("aria-hidden", String(!on));
    outer.classList.toggle("nav-open", on);
    host.classList.toggle("nav-open", on);
    toggle.setAttribute("aria-expanded", String(on));
    open = on;
    // Focus follows: into the first item on open, back to the button
    // on close, so a keyboard is never left behind the menu.
    if (on) panel.querySelector("a, button")?.focus();
    else if (document.activeElement && panel.contains(document.activeElement)) toggle.focus();
  }

  toggle.addEventListener("click", () => setOpen(!open));
  document.addEventListener("click", (e) => {
    if (open && !panel.contains(e.target) && !toggle.contains(e.target)) setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    // The sign-in dialog opens from this menu and closes on Escape too.
    // Without this guard one press shut both, and dismissing the dialog
    // left the menu gone as well.
    if (e.key === "Escape" && !document.getElementById("signin-scrim")) setOpen(false);
  });

  panel.addEventListener("click", (e) => {
    const item = e.target.closest("[data-act]");
    if (!item) return;
    const act = item.getAttribute("data-act");
    if (act === "theme") {
      const b = themeBtn();
      if (b) b.click();
      build();       // the row now offers the other direction
      return;
    }
    if (act === "signout") {
      // auth.js's signOut, so the CV skills go with the token. Removing
      // the key here was a second implementation that forgot half of it.
      signOut();
      setOpen(false);
      // Each page draws its own signed-out bar; reloading is the one
      // move that is correct on all of them.
      location.reload();
      return;
    }
    if (act === "signin") {
      setOpen(false);
      // openSignIn is the in-page dialog on the landing and contact
      // pages. The board and the rest have no such dialog, so they go
      // to the account page, which is where their sign-in has always
      // lived.
      if (typeof window.openSignIn === "function") window.openSignIn();
      else location.href = "/account";
    }
  });

  // Rebuilt after a sign-in, so the menu names the reader without a
  // reload. auth.js calls every render sink it has been given.
  document.addEventListener("iljobs:auth", () => { if (open) build(); });

  // Widened past the breakpoint with the menu open, it would stay in
  // the DOM doing nothing visible until the next phone-width visit.
  if (window.matchMedia) {
    const wide = window.matchMedia(`(min-width: ${BREAKPOINT + 1}px)`);
    const sync = () => { if (wide.matches) setOpen(false); };
    if (wide.addEventListener) wide.addEventListener("change", sync);
    else wide.addListener(sync);
  }
})();
