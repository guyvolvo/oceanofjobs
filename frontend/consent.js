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

  function get() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
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
