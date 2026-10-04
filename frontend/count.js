// Anonymous counts for the growth dashboard: visits, searches, job views
// and apply clicks, as daily totals (api/events.py). A count is a POST to
// /api/event carrying the event's name, and for a search its words. No
// cookie, no id. Two flags stay in this browser and are never sent: one
// says this tab's visit was already counted, the other that this browser
// has been here before.
//
// Crawlers and automated browsers count nothing, which also keeps the
// end-to-end tests out of the numbers.
(function () {
  var ua = navigator.userAgent || "";
  var robot = navigator.webdriver || /bot|crawl|spider|slurp|headless|lighthouse|preview|pingdom|uptime/i.test(ua);

  // A search also sends what was searched (q), which the dashboard lists
  // as top searches. Nothing else goes with it.
  function send(name, term) {
    if (robot) return;
    var url = "/api/event?e=" + encodeURIComponent(name);
    if (term) url += "&q=" + encodeURIComponent(String(term).slice(0, 100));
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(url)) return;
      fetch(url, { method: "POST", keepalive: true }).catch(function () {});
    } catch (e) { /* a lost count is fine */ }
  }
  window.ojCount = send;

  try {
    if (!sessionStorage.getItem("oj-counted")) {
      sessionStorage.setItem("oj-counted", "1");
      send("visit");
      if (!localStorage.getItem("oj-seen")) {
        localStorage.setItem("oj-seen", "1");
        send("new_visitor");
      }
    }
  } catch (e) { /* storage blocked: count nothing rather than every page */ }

  // A listing's own page is a job view. On the board, opening a listing
  // reports its own (app.js openJobDetail).
  if (location.pathname.indexOf("/job/") === 0) send("job_view");

  // Every way out to an employer's posting: the board's rows and detail
  // pane, and the listing pages' buttons.
  document.addEventListener("click", function (ev) {
    var a = ev.target && ev.target.closest &&
      ev.target.closest("a.apply-link, a.job-detail-apply, a.job-detail-source, a.pg-apply:not(.pg-apply-off)");
    if (a) send("apply");
  }, true);
})();
