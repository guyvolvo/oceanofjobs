// The phone's bottom tab bar: Jobs, Companies, Saved, Alerts, Account.
// One tap to anywhere, in place of the hamburger and the drawer that
// held the desktop sidebar. Mounted on every app page; style.css shows
// it only up to 800px wide, and the pages leave room for it there.
(function () {
  const ICONS = {
    jobs: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>',
    companies: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16"/><path d="M16 9h3a1 1 0 0 1 1 1v11"/><path d="M8 7h4M8 11h4M8 15h4"/></svg>',
    saved: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg>',
    alerts: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10 21h4"/></svg>',
    account: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  };
  const TABS = [
    ["jobs", "Jobs", "/board"],
    ["companies", "Companies", "/companies"],
    ["saved", "Saved", "/board?starred=1"],
    ["alerts", "Alerts", "/account#alerts"],
    ["account", "Account", "/account"],
  ];

  function current() {
    const path = location.pathname.replace(/\/$/, "") || "/";
    const q = new URLSearchParams(location.search);
    if (path === "/board" && q.get("starred") === "1") return "saved";
    if (path === "/board" || path === "/") return "jobs";
    if (path === "/companies" || path.startsWith("/company/")) return "companies";
    if (path === "/account") return location.hash === "#alerts" ? "alerts" : "account";
    return "";
  }

  function mount() {
    if (document.querySelector(".tabbar")) return;
    const now = current();
    const nav = document.createElement("nav");
    nav.className = "tabbar";
    nav.setAttribute("aria-label", "Main");
    nav.innerHTML = TABS.map(([key, label, href]) =>
      `<a class="tabbar-item${key === now ? " on" : ""}" href="${href}"${key === now ? ' aria-current="page"' : ""}>${ICONS[key]}<span>${label}</span></a>`).join("");
    document.body.appendChild(nav);
    document.body.classList.add("has-tabbar");
  }

  // The Saved tab is the board with its own filter; a tap on it while
  // already on the board switches the view in place, without a reload.
  document.addEventListener("click", (e) => {
    const a = e.target.closest(".tabbar-item");
    if (!a) return;
    if (a.getAttribute("aria-current") === "page") { e.preventDefault(); return; }
    if (typeof setView === "function" && location.pathname.replace(/\/$/, "") === "/board") {
      const href = a.getAttribute("href");
      if (href === "/board?starred=1" || href === "/board") {
        e.preventDefault();
        setView(href === "/board" ? (typeof state !== "undefined" && state.roles) || "tech" : "saved");
        document.querySelectorAll(".tabbar-item").forEach((x) => { x.classList.toggle("on", x === a); x.toggleAttribute("aria-current", x === a); });
      }
    }
  });

  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", mount) : mount();
  window.addEventListener("hashchange", () => {
    const now = current();
    document.querySelectorAll(".tabbar-item").forEach((x) => { const on = x.getAttribute("href").endsWith(now === "alerts" ? "#alerts" : now === "account" ? "/account" : "\u0000"); if (now === "alerts" || now === "account") { x.classList.toggle("on", on); x.toggleAttribute("aria-current", on); } });
  });
})();
