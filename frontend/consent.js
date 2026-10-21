// Google Analytics only with consent. Until the reader accepts, Google's
// script is not loaded and nothing goes to Google; count.js, the site's
// own cookieless counter, runs either way. The choice is kept in
// localStorage, and any element with data-cookie-settings reopens the
// banner so it can be changed.
(function () {
  var KEY = "ooj_cookie_consent";
  var GA = "G-GXP63R1JP1";
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };

  // A browser that blocks this site's storage (Brave Shields blocking
  // cookies, some private windows) can't remember the choice, so the banner
  // came back on every page. Such a browser is treated as having declined:
  // Google Analytics stays off and nobody is asked again.
  function canStore() {
    try { localStorage.setItem(KEY + "_test", "1"); localStorage.removeItem(KEY + "_test"); return true; } catch (e) { return false; }
  }
  // Brave sends Global Privacy Control by default and can keep a site's
  // storage for one page only, so the banner came back on every load there.
  // GPC is the reader saying no already: Analytics stays off, nobody is asked.
  function get() { try { return localStorage.getItem(KEY) || (canStore() && !navigator.globalPrivacyControl ? null : "no"); } catch (e) { return "no"; } }
  function set(v) { try { localStorage.setItem(KEY, v); } catch (e) { /* the choice lasts this page only */ } }

  var loaded = false;
  function load() {
    if (loaded) return;
    loaded = true;
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + GA;
    document.head.appendChild(s);
    gtag("js", new Date());
    gtag("config", GA);
  }

  // A reader who declines after accepting gets Google's cookies removed.
  function clearGa() {
    document.cookie.split(";").forEach(function (c) {
      var name = c.split("=")[0].trim();
      if (name.indexOf("_ga") !== 0) return;
      var gone = name + "=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
      document.cookie = gone;
      document.cookie = gone + "; domain=." + location.hostname.replace(/^www\./, "");
    });
  }

  function banner() {
    if (document.getElementById("cookie-banner")) return;
    var el = document.createElement("div");
    el.id = "cookie-banner";
    el.className = "cookie-banner";
    el.setAttribute("role", "region");
    el.setAttribute("aria-label", "Cookie choice");
    el.innerHTML =
      '<p>We use Google Analytics cookies to see how the site is used. Nothing is sent to Google unless you accept. ' +
      '<a href="/privacy">Privacy</a></p>' +
      '<div class="cookie-actions"><button type="button" data-cookie="no">Decline</button>' +
      '<button type="button" data-cookie="yes" class="cookie-yes">Accept</button></div>';
    el.addEventListener("click", function (e) {
      var b = e.target.closest("[data-cookie]");
      if (!b) return;
      set(b.getAttribute("data-cookie"));
      if (b.getAttribute("data-cookie") === "yes") load();
      else clearGa();
      el.remove();
    });
    document.body.appendChild(el);
  }

  if (get() === "yes") load();
  var ready = function (fn) { document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", fn) : fn(); };
  ready(function () {
    if (!get()) banner();
    document.addEventListener("click", function (e) {
      if (!e.target.closest("[data-cookie-settings]")) return;
      e.preventDefault();
      banner();
    });
  });
})();
