// A warning badge while a service this site runs on reports a problem
// (GitHub, Cloudflare, AWS; read by api/handler.py's upstream_status),
// saying what it means here. Nothing at all while they are fine. A tap
// hides it for the rest of the visit.
(function () {
  var KEY = "upstream_dismissed";
  try { if (sessionStorage.getItem(KEY)) return; } catch (e) {}
  fetch("/api/pipeline-status", { cache: "no-store" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      var items = (d && d.upstream) || [];
      if (!items.length) return;
      var box = document.createElement("div");
      box.className = "upstream";
      box.setAttribute("role", "status");
      items.forEach(function (i) {
        var text = (i.level === "outage" ? "Service outage: " : "Service degraded: ") + i.service + " - " + i.effect;
        var badge = document.createElement("button");
        badge.type = "button";
        badge.className = "upstream-badge";
        badge.setAttribute("aria-label", text + ". Dismiss");
        badge.textContent = text;
        var x = document.createElement("span");
        x.className = "upstream-x";
        x.setAttribute("aria-hidden", "true");
        x.textContent = "×";
        badge.appendChild(x);
        badge.addEventListener("click", function () {
          box.remove();
          try { sessionStorage.setItem(KEY, "1"); } catch (e) {}
        });
        box.appendChild(badge);
      });
      document.body.appendChild(box);
    })
    .catch(function () {});
})();
