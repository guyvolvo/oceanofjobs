// Every "Log in" goes to the sign-in page, /login (apply/src/login), which
// brings the reader back to this page once signed in. It used to open a
// dialog here; the name stays because every page's head loads this file
// and calls window.openSignIn().
(function () {
  window.openSignIn = function () {
    if (location.pathname === "/login") return;
    location.assign("/login?next=" + encodeURIComponent(location.pathname + location.search + location.hash));
  };
})();
