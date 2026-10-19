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

  // Links the MCP server hands to AI assistants carry ?ref=mcp. The page
  // they land on counts one mcp_view per browser, so a refresh or a second
  // visit is not a second referral. Then the parameter comes off the
  // address bar, so a link copied from here does not pass it on, and this
  // tab remembers the page was referred, so an apply click after a refresh
  // still counts. Only the landing page: a click through to the board or
  // another listing is not attributed.
  var mcpPage = "";
  try {
    var params = new URLSearchParams(location.search);
    if (params.get("ref") === "mcp") {
      mcpPage = location.pathname;
      if (!localStorage.getItem("oj-mcp-view:" + mcpPage)) {
        localStorage.setItem("oj-mcp-view:" + mcpPage, "1");
        send("mcp_view");
      }
      sessionStorage.setItem("oj-mcp-page:" + mcpPage, "1");
      params.delete("ref");
      var rest = params.toString();
      history.replaceState(history.state, "", mcpPage + (rest ? "?" + rest : "") + location.hash);
    } else if (sessionStorage.getItem("oj-mcp-page:" + location.pathname)) {
      mcpPage = location.pathname;
    }
  } catch (e) { /* storage blocked: no MCP counts rather than one per refresh */ }

  // Every way out to an employer's posting: the board's rows and detail
  // pane, and the listing pages' buttons. On an MCP-referred page the
  // first one also counts as an MCP apply, once per page per browser.
  document.addEventListener("click", function (ev) {
    var a = ev.target && ev.target.closest &&
      ev.target.closest("a.apply-link, a.job-detail-apply, a.job-detail-source, a.pg-apply:not(.pg-apply-off)");
    if (!a) return;
    send("apply");
    try {
      if (mcpPage && !localStorage.getItem("oj-mcp-apply:" + mcpPage)) {
        localStorage.setItem("oj-mcp-apply:" + mcpPage, "1");
        send("mcp_apply");
      }
    } catch (e) { /* as above */ }
  }, true);
})();
