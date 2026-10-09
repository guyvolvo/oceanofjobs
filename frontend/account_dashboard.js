// The account page's overview: a greeting with what is new, four
// numbers, the weekly trend of the reader's matches, the newest fits,
// the skills against demand, and the alerts. Every number is the
// reader's own, from /api/me/dashboard (computed on the box once a day,
// api/dashboard.py) and the alert and saved lists account.js loads.
// Called by account.js's bootAccount once the profile, alerts and saved
// lists are in.
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString();
  const DAY = 864e5;
  const MIN_MATCH = 3;

  // What the reader's skills are matched with: at least three of them,
  // or all of them when there are fewer, in the one country they set
  // in Preferences, or everywhere.
  function matchScope() {
    const skills = draft.skills || [];
    const country = (draft.country || []).length === 1 ? draft.country[0] : "";
    return { skills, country, min: Math.min(MIN_MATCH, skills.length) };
  }

  function greeting() {
    const h = new Date().getHours();
    const part = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
    const tokens = getAuthTokens();
    const name = tokens?.id_token ? (decodeJwtName(tokens.id_token) || "").split(" ")[0] : "";
    return name ? `${part}, ${name}` : part;
  }

  const dayLabel = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric" });

  function ago(iso) {
    const h = (Date.now() - new Date(iso).getTime()) / 36e5;
    if (h < 1) return "just now";
    if (h < 24) return `${Math.floor(h)}h ago`;
    const d = Math.floor(h / 24);
    return d === 1 ? "yesterday" : `${d}d ago`;
  }

  const svg = (path, size = 17, width = 1.7) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  const ICON = {
    active: svg('<path d="M4 12l5 5L20 6"/>', 12, 2.2),
    paused: svg('<path d="M9 5v14M15 5v14"/>', 12, 2.2),
    x: '<svg viewBox="0 0 10 10" width="9" height="9" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M1 1l8 8M9 1L1 9"/></svg>',
  };
  const ARROW = {
    up: '<svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 9l6-6M4.5 3H9v4.5"/></svg>',
    down: '<svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 3l6 6M9 4.5V9H4.5"/></svg>',
  };

  // How a number moved against the period before, in percent. Nothing
  // when there was nothing before to measure against.
  function change(now, prev) {
    if (now == null || prev == null || !prev) return null;
    // The record only reaches back as far as the scrapers' first sight
    // of each role, so a month-ago figure a fraction of today's means
    // the record was thin then, not that the market grew tenfold.
    if (prev < now / 4) return null;
    return Math.round(((now - prev) / prev) * 100);
  }
  function pill(pct) {
    if (pct == null) return "";
    const dir = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
    const shown = Math.abs(pct) >= 1000 ? `${Math.round(Math.abs(pct) / 100) / 10}k` : Math.abs(pct);
    return `<span class="acct-pill ${dir}" title="${pct > 0 ? "+" : ""}${pct}% against the period before">${ARROW[dir] || ""}${shown}%</span>`;
  }

  // The 90 days of history as whole weeks ending today, at most eight:
  // the new matches in each, and the roles open on its last day.
  function weekly(days) {
    const out = [];
    for (let w = Math.min(8, Math.floor(days.length / 7)) - 1; w >= 0; w--) {
      const end = days.length - 1 - 7 * w;
      out.push({ day: days[end].day, matches: days.slice(end - 6, end + 1).reduce((s, d) => s + d.new, 0), roles: days[end].open });
    }
    return out;
  }

  // Pay, from the matches' own estimates: the median, the middle half,
  // and 13 bins of 5K from 20K (the ends hold everything past them).
  const k = (n) => `₪${Math.round(n / 1000)}K`;
  function parseShekels(text) {
    if (!text || !/₪|ILS|NIS/.test(text)) return null;
    const nums = [...text.matchAll(/(\d[\d,.]*)\s*([kK])?/g)].map((m) => parseFloat(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1)).filter((n) => n > 1000);
    if (!nums.length) return null;
    return nums.length >= 2 ? (nums[0] + nums[1]) / 2 : nums[0];
  }
  function pay(matches) {
    const pays = matches.map((j) => parseShekels(j.salary_text)).filter((n) => n).sort((a, b) => a - b);
    if (pays.length < 5) return null;
    const q = (f) => pays[Math.min(pays.length - 1, Math.floor(f * (pays.length - 1)))];
    const bins = Array(13).fill(0);
    for (const p of pays) bins[Math.max(0, Math.min(12, Math.floor((p - 20000) / 5000)))] += 1;
    return { med: q(0.5), lo: q(0.25), hi: q(0.75), n: pays.length, bins };
  }
  function payBins(p) {
    const top = Math.max(...p.bins);
    return `<span class="acct-bins" aria-hidden="true">${p.bins.map((n, i) => {
      const x0 = 20000 + i * 5000;
      const mid = (i === 0 || x0 <= p.hi) && (i === 12 || x0 + 5000 > p.lo);
      return `<i class="${mid ? "mid" : ""}" style="height:${n ? Math.max(8, (n / top) * 100) : 0}%"></i>`;
    }).join("")}</span>`;
  }

  // The history behind the tiles and the chart; it comes with the dashboard.
  let history = null;
  let weeks = [];
  let series = "matches";

  // The number first with its trend beside it, then what it counts.
  function stat({ trend = "", extra = "", label, value, aside = "", title = "" }) {
    // A phone shows only the tiles with a number in them.
    const empty = value === "0" || value === "–" || value === "" || value == null;
    return `<div class="acct-card acct-stat${empty ? " acct-stat-empty" : ""}"${title ? ` title="${esc(title)}"` : ""}>
      <div class="acct-stat-head"><span class="acct-stat-value">${value}</span>${trend}<span class="acct-stat-extra">${extra}</span></div>
      <div class="acct-stat-row"><span class="acct-stat-label">${label}</span><span class="acct-stat-aside">${aside}</span></div>
    </div>`;
  }

  function figures() {
    const days = history?.days || [];
    const n = days.length;
    return {
      week: weeks.length ? weeks[weeks.length - 1].matches : 0,
      before: weeks.length > 1 ? weeks[weeks.length - 2].matches : null,
      open: n ? days[n - 1].open : null,
      monthAgo: n >= 31 ? days[n - 31].open : null,
    };
  }

  // The tiles and the greeting line.
  function paintStats(savedJobs, matches) {
    const host = document.getElementById("acct-stats");
    if (!host) return;
    const { week, before, open, monthAgo } = figures();
    const stillOpen = savedJobs.filter((j) => !j.closed_at).length;
    const noSkills = !draft.skills.length;
    const p = pay(matches);
    host.innerHTML = [
      stat({ trend: noSkills ? "" : pill(change(week, before)), label: "New matches this week",
        value: noSkills ? "–" : fmt(week), aside: noSkills ? '<a href="#skills">Add your skills</a>' : before == null ? "" : `Prev: ${fmt(before)}` }),
      stat({ trend: pill(change(open, monthAgo)), label: "Open roles that fit you",
        value: open == null ? "–" : fmt(open), aside: monthAgo == null ? "" : `Prev: ${fmt(monthAgo)} / mo` }),
      stat({ extra: p ? payBins(p) : "", label: "Median salary / mo",
        value: p ? k(p.med) : "–", aside: p ? `Mid: ${k(p.lo)}–${k(p.hi).slice(1)}` : noSkills ? "" : "Too few estimates yet",
        title: p ? `Estimated from ${p.n} of your matches. The middle half pays ${k(p.lo)} to ${k(p.hi)} a month.` : "" }),
      stat({ extra: savedJobs.length ? '<a class="btn ghost acct-corner" href="#saved">View</a>' : "", label: "Saved jobs",
        value: fmt(savedJobs.length), aside: savedJobs.length ? `${stillOpen} still open` : '<a href="/board">Save one from the board</a>' }),
    ].join("");
    const all = document.getElementById("acct-matches-all");
    if (all) all.textContent = week ? `View all ${fmt(week)}` : "View all";
    const g = document.getElementById("acct-greeting");
    if (g) g.textContent = greeting();
    const { country } = matchScope();
    const ds = document.getElementById("acct-demand-sub");
    if (ds) ds.textContent = typeof placeSummary === "function" ? placeSummary() : (country ? countryLabel(country) : "Anywhere");
    const openLink = document.getElementById("acct-open-matches");
    if (openLink && draft.skills.length) openLink.href = `/board?view=matches&skills=${encodeURIComponent(draft.skills.join(","))}${country ? `&country=${country}` : ""}`;
  }

  // The weekly chart: an area over eight weeks, the latest point marked
  // and labelled, any other point labelled under the pointer.
  function niceStep(v) {
    if (v <= 1) return 1;
    const p = 10 ** Math.floor(Math.log10(v));
    return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= v);
  }
  const short = (n) => (n >= 1000 ? `${+(n / 1000).toFixed(n % 1000 ? 1 : 0)}k` : String(Math.round(n)));

  function paintTrend() {
    const host = document.getElementById("acct-chart");
    if (!host) return;
    const title = document.getElementById("acct-trend-title");
    const valueEl = document.getElementById("acct-trend-value");
    const pillEl = document.getElementById("acct-trend-pill");
    document.querySelectorAll("[data-series]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.series === series)));
    const isM = series === "matches";
    title.textContent = isM ? "New matches per week" : "Open roles that fit you, weekly";
    if (weeks.length < 2) {
      valueEl.textContent = "";
      pillEl.innerHTML = "";
      host.innerHTML = `<p class="acct-empty">${draft.skills.length ? "Not enough history yet. The weeks fill in as the board watches your matches." : 'Add <a href="#skills">your skills</a> to see your matches week by week.'}</p>`;
      return;
    }
    const v = weeks.map((w) => w[series]);
    const last = v.length - 1;
    const { open, monthAgo } = figures();
    valueEl.textContent = fmt(v[last]);
    pillEl.innerHTML = isM ? pill(change(v[last], v[last - 1])) : pill(change(open, monthAgo));
    const step = niceStep((Math.max(...v) * 1.1) / 4);
    const max = step * 4;
    const W = 700, H = 200;
    const x = (i) => (i * W) / last;
    const y = (val) => H - (val / max) * H;
    const line = v.map((val, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(val).toFixed(1)}`).join(" ");
    const dots = v.map((val, i) => `<span class="acct-dot${i === last ? " on" : ""}" style="left:${(x(i) / W) * 100}%;top:${(y(val) / H) * 100}%"></span>`).join("");
    const label = isM ? "New matches" : "Open roles";
    host.innerHTML = `
      <div class="acct-yaxis" aria-hidden="true">${[4, 3, 2, 1, 0].map((i) => `<span>${short(step * i)}</span>`).join("")}</div>
      <div class="acct-plot">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
          <defs><linearGradient id="acct-area-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="acct-area-top"/><stop offset="1" class="acct-area-bottom"/></linearGradient></defs>
          <path class="acct-gridline" d="M0 0H${W}M0 50H${W}M0 100H${W}M0 150H${W}"/>
          <path class="acct-baseline" d="M0 ${H}H${W}"/>
          <path class="acct-area" d="${line} L${W} ${H} L0 ${H} Z"/>
          <path class="acct-line" d="${line}"/>
          <path class="acct-drop" id="acct-drop" d=""/>
        </svg>
        ${dots}
        <div class="acct-tip" id="acct-tip" aria-hidden="true"></div>
      </div>
      <span></span>
      <div class="acct-xaxis" aria-hidden="true">${weeks.map((w) => `<span>${esc(dayLabel(w.day))}</span>`).join("")}</div>
      <table class="visually-hidden"><caption>${esc(title.textContent)}</caption><tr><th scope="col">Week to</th><th scope="col">${label}</th></tr>${weeks.map((w, i) => `<tr><td>${esc(dayLabel(w.day))}</td><td>${fmt(v[i])}</td></tr>`).join("")}</table>`;
    const plot = host.querySelector(".acct-plot");
    const tip = host.querySelector("#acct-tip");
    const drop = host.querySelector("#acct-drop");
    const dotEls = [...plot.querySelectorAll(".acct-dot")];
    const show = (i) => {
      tip.innerHTML = `<span class="acct-tip-when">Week to ${esc(dayLabel(weeks[i].day))}</span><span class="acct-tip-n">${fmt(v[i])}</span>`;
      tip.style.left = `${(x(i) / W) * 100}%`;
      tip.style.top = `${(y(v[i]) / H) * 100}%`;
      tip.dataset.edge = i === last ? "end" : i === 0 ? "start" : "";
      // Near the top the label would cover the card head; it hangs under the point instead.
      tip.dataset.below = String(y(v[i]) / H < 0.3);
      drop.setAttribute("d", `M${x(i).toFixed(1)} ${y(v[i]).toFixed(1)} V${H}`);
      dotEls.forEach((d, j) => d.classList.toggle("hover", j === i && i !== last));
    };
    show(last);
    plot.addEventListener("pointermove", (e) => {
      const r = plot.getBoundingClientRect();
      show(Math.max(0, Math.min(last, Math.round(((e.clientX - r.left) / r.width) * last))));
    });
    plot.addEventListener("pointerleave", () => show(last));
  }

  // The skills against demand. Gaps first: skills the reader does not
  // list that at least a fifth of their matches name, dashed, with Add.
  // Then the listed skills, capped so the card stays inside its row.
  async function paintDemand(matches, counts = {}) {
    const host = document.getElementById("acct-demand");
    if (!host) return;
    const { skills } = matchScope();
    if (!skills.length) { host.innerHTML = '<p class="acct-empty">Add skills to see demand for them.</p>'; return; }
    const have = new Set(skills);
    const seen = new Map();
    for (const j of matches) for (const sk of (j.skills || "").split(",").filter(Boolean)) if (!have.has(sk)) seen.set(sk, (seen.get(sk) || 0) + 1);
    const gaps = [...seen.entries()].filter(([sk, n]) => matches.length && n / matches.length >= 0.2 && counts[sk] != null)
      .sort((a, b) => b[1] - a[1]).slice(0, 2).map(([sk, n]) => ({ sk, n: counts[sk], share: Math.round((n / matches.length) * 100) }));
    const mine = skills.slice(0, 10).filter((sk) => counts[sk] != null).map((sk) => ({ sk, n: counts[sk] })).sort((a, b) => b.n - a.n);
    const max = Math.max(1, ...gaps.map((r) => r.n), ...mine.map((r) => r.n));
    const w = (n) => `${Math.max(1, Math.round((100 * n) / max))}%`;
    const cap = gaps.length ? 6 : 8;
    const more = mine.length - cap;
    let html = "";
    if (gaps.length) {
      const shares = gaps.map((g) => `${g.share}%`).join(" and ");
      html += `<div class="acct-th">Gaps · in ${shares} of your matches</div>`;
      html += gaps.map((g) => `<div class="acct-demand-row gap" title="${esc(g.sk)} is named by ${g.share}% of your matches; ${fmt(g.n)} open roles ask for it">
        <span class="acct-demand-name">${esc(g.sk)}</span>
        <span class="acct-demand-track"><span class="acct-demand-fill" style="width:${w(g.n)}"></span></span>
        <span class="acct-demand-n">${fmt(g.n)}</span>
        <button type="button" class="btn acct-small" data-add="${esc(g.sk)}" aria-label="Add ${esc(g.sk)} to your skills">Add</button>
      </div>`).join("");
      html += '<div class="acct-rule"></div>';
    }
    html += '<div class="acct-th">On your profile</div>';
    html += mine.slice(0, cap).map((r) => `<div class="acct-demand-row">
        <span class="acct-demand-name">${esc(r.sk)}</span>
        <span class="acct-demand-track"><span class="acct-demand-fill" style="width:${w(r.n)}"></span></span>
        <span class="acct-demand-n">${fmt(r.n)}</span>
      </div>`).join("");
    if (more > 0) html += `<a class="acct-more" href="#skills">Show ${more} more →</a>`;
    host.innerHTML = html;
    const note = document.getElementById("acct-demand-note");
    if (note) note.hidden = true;
    host.querySelectorAll("[data-add]").forEach((b) => b.addEventListener("click", async () => {
      if (draft.skills.length >= MAX_SKILLS) {
        note.hidden = false;
        note.innerHTML = `Your profile holds its full ${MAX_SKILLS} skills. Take one out in <a href="#skills">Skills</a> to add <b>${esc(b.dataset.add)}</b>.`;
        return;
      }
      b.disabled = true;
      draft.skills = [...new Set([...draft.skills, b.dataset.add])];
      try {
        const res = await authedFetch("/me/profile", { method: "PUT", body: JSON.stringify(draft) });
        paintProfile(res.profile || res);
        setCount("skills", draft.skills.length);
        paintDashboard();
      } catch {
        draft.skills = draft.skills.filter((sk) => sk !== b.dataset.add);
        b.disabled = false;
      }
    }));
  }

  // The alerts, as a table with Pause and delete. The create form is the
  // Alerts section's own, moved in while it is open.
  let alertFormOpen = false;
  let alertCount = null;
  const alertsNow = () => ((typeof myAlerts !== "undefined" ? myAlerts : []) || []);

  function alertParts(filter) {
    const kw = filter.search || filter.q || "";
    const rest = describeAlertFilter(Object.assign({}, filter, { search: "", q: "" }));
    return { kw, rest: kw && rest === "All jobs" ? "" : rest };
  }

  function paintAlerts() {
    const host = document.getElementById("acct-alerts");
    if (!host) return;
    const list = alertsNow();
    // A create that went through closes the form it came from.
    if (alertFormOpen && alertCount != null && list.length > alertCount) setAlertForm(false);
    alertCount = list.length;
    const sent = list.map((a) => a.last_notified_at).filter(Boolean).sort().pop();
    const sentEl = document.getElementById("acct-alerts-sent");
    if (sentEl) sentEl.textContent = sent ? `· sent ${ago(sent)}` : "";
    const toggle = document.getElementById("acct-alert-toggle");
    if (toggle) { toggle.textContent = alertFormOpen ? "Cancel" : "New alert"; toggle.setAttribute("aria-expanded", String(alertFormOpen)); }
    host.hidden = alertFormOpen;
    if (!list.length) {
      host.innerHTML = '<p class="acct-empty">No alerts yet. Create one and new listings that match it are emailed to you.</p>';
      return;
    }
    host.innerHTML = `<div class="acct-th acct-alert-cols" aria-hidden="true"><span>Alert</span><span>Status</span><span></span><span></span></div>
      <div class="acct-list">${list.map((a) => {
        const { kw, rest } = alertParts(a.filter || {});
        const name = describeAlertFilter(a.filter || {});
        return `<div class="acct-trow acct-alert-cols${a.active ? "" : " paused"}">
          <span class="acct-alert-text">${kw ? `<span class="acct-kw">"${esc(kw)}"</span> ` : ""}${esc(rest)}</span>
          <span class="acct-alert-status">${a.active ? ICON.active + "Active" : ICON.paused + "Paused"}</span>
          <button type="button" class="btn acct-small" data-alert-pause="${esc(a.alert_id)}" data-active="${a.active}">${a.active ? "Pause" : "Resume"}</button>
          <button type="button" class="acct-x" data-alert-delete="${esc(a.alert_id)}" aria-label="Delete alert ${esc(name)}" title="Delete alert">${ICON.x}</button>
        </div>`;
      }).join("")}</div>`;
  }

  async function reloadAlerts() {
    renderAlertsList((await authedFetch("/me/alerts")).alerts || []);
  }

  function setAlertForm(open) {
    const form = document.getElementById("alert-create");
    const slot = document.getElementById("acct-alert-slot");
    const home = document.getElementById("alerts");
    if (!form || !slot || !home) return;
    alertFormOpen = open;
    (open ? slot : home).appendChild(form);
    paintAlerts();
    if (open) document.getElementById("alert-f-search")?.focus();
  }
  window.closeOverviewAlertForm = () => { if (alertFormOpen) setAlertForm(false); };
  window.paintOverviewAlerts = paintAlerts;

  function wireOverview() {
    document.getElementById("acct-alerts")?.addEventListener("click", async (e) => {
      const pause = e.target.closest("[data-alert-pause]");
      const del = e.target.closest("[data-alert-delete]");
      const btn = pause || del;
      if (!btn) return;
      if (del && !confirm("Delete this alert? Its emails stop at once.")) return;
      btn.disabled = true;
      try {
        if (pause) await authedFetch(`/me/alerts/${pause.dataset.alertPause}`, { method: "PATCH", body: JSON.stringify({ active: pause.dataset.active !== "true" }) });
        else await authedFetch(`/me/alerts/${del.dataset.alertDelete}`, { method: "DELETE" });
        await reloadAlerts();
      } catch {
        btn.disabled = false;
      }
    });
    // The card's button toggles the form; the header's opens it, here on
    // the overview or in the Alerts section from anywhere else.
    document.getElementById("acct-alert-toggle")?.addEventListener("click", () => setAlertForm(!alertFormOpen));
    document.querySelector(".acct-hero [data-alert-form]")?.addEventListener("click", () => {
      if (document.getElementById("overview")?.classList.contains("is-active")) {
        if (!alertFormOpen) setAlertForm(true);
        document.getElementById("acct-alert-slot")?.scrollIntoView({ block: "nearest" });
      } else {
        document.querySelector('.account-nav-link[href="#alerts"]')?.click();
        document.getElementById("alert-f-search")?.focus();
      }
    });
    // Upload CV opens the Skills section (the link does that) and its picker.
    document.querySelector("[data-cv-upload]")?.addEventListener("click", () => document.getElementById("cv-file")?.click());
    document.querySelectorAll("[data-series]").forEach((b) => b.addEventListener("click", () => { series = b.dataset.series; paintTrend(); }));
  }

  // One call: the overview's numbers, computed on the box on the first
  // visit of the day and stored with the profile (api/dashboard.py).
  async function loadDashboard() {
    const { skills } = matchScope();
    if (!skills.length) return null;
    try { return await authedFetch("/me/dashboard"); } catch { return null; }
  }

  // The last answer, kept in this browser for half an hour, so the page
  // paints at once on the next visit and the fresh numbers replace it
  // quietly when they arrive.
  // The same cap the API applies (api/profile.py MAX_SKILLS): it keeps
  // the first forty and drops the rest without a word.
  const MAX_SKILLS = 40;
  const CACHE_KEY = "iljobs_dash_v1";
  const CACHE_TTL = 30 * 60 * 1000;
  const cacheKey = () => { const { skills, country, min } = matchScope(); return `${skills.join(",")}|${country}|${min}`; };
  function readCache() {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      return c && c.key === cacheKey() && Date.now() - c.at < CACHE_TTL ? c : null;
    } catch { return null; }
  }
  function writeCache(h, matches, counts, computedAt) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ key: cacheKey(), at: Date.now(), history: h, matches: matches.slice(0, 100), counts, computedAt })); } catch { /* per-browser nicety only */ }
  }

  let inflight = null;
  let historyRetries = 0;
  let pendingPolls = 0;

  // The frame at once: greeting, the four tiles and bones in every
  // card, before any answer is in. The numbers can take seconds on a
  // busy box, and a blank page for that long reads as broken.
  function paintSkeleton() {
    const g = document.getElementById("acct-greeting");
    if (g && !/,/.test(g.textContent)) g.textContent = greeting();
    const bone = (w, h) => `<span class="skeleton sk-line" style="width:${w}px;height:${h}px;display:inline-block"></span>`;
    const stats = document.getElementById("acct-stats");
    if (stats && !stats.children.length) {
      stats.innerHTML = ["New matches this week", "Open roles that fit you", "Median salary / mo", "Saved jobs"]
        .map((label) => stat({ label, value: bone(64, 26), aside: bone(60, 11) })).join("");
    }
    const chart = document.getElementById("acct-chart");
    if (chart && !chart.children.length) chart.innerHTML = `<div class="acct-bones acct-chart-bones">${bone(999, 160)}</div>`;
    const demand = document.getElementById("acct-demand");
    if (demand && !demand.children.length) demand.innerHTML = Array.from({ length: 5 }, () => `<div class="acct-demand-row"><span class="acct-demand-name">${bone(70, 11)}</span><span class="acct-demand-track"></span><span class="acct-demand-n">${bone(28, 11)}</span></div>`).join("");
    const matches = document.getElementById("acct-matches");
    if (matches && !matches.children.length) matches.innerHTML = Array.from({ length: 3 }, () => `<div class="acct-trow acct-match-cols acct-match">${bone(180, 12)}</div>`).join("");
  }

  let painted = "";
  function paintAll(matches, counts = {}) {
    const savedJobs = (typeof dashSavedJobs !== "undefined" ? dashSavedJobs : []) || [];
    weeks = weekly(history?.days || []);
    paintStats(savedJobs, matches);
    paintTrend();
    paintDemand(matches, counts);
    paintAlerts();
    // No matches: one card with the two ways out (style.css shows it on
    // a phone, where empty cards were the whole screen).
    const none = !matches.length;
    document.getElementById("overview")?.classList.toggle("acct-nomatch", none);
    const card = document.getElementById("acct-getmatched");
    if (card) {
      card.hidden = !none;
      const text = document.getElementById("acct-getmatched-text");
      const n = (draft.skills || []).length;
      if (text) text.textContent = n
        ? `Your ${n} skill${n === 1 ? "" : "s"} don't match any open roles yet. Upload a newer CV or widen your locations to see matches and salary estimates.`
        : "Add your skills from a CV, or widen your locations, to see matches and salary estimates.";
    }
    // The best-matches list reads the same answer, so the page does not
    // ask the box for three rows it already has sixty of.
    window.dashMatches = { key: (draft.skills || []).join(","), jobs: matches };
    if (typeof paintMatches === "function") paintMatches(matches.slice(0, 3), draft.skills || []);
  }

  // Called when the profile is in (the skills are what everything here
  // hangs on) and again when the alerts and saved lists are, so the
  // tiles that read those can fill. The fetches run once per skill
  // set; a second call while they are in flight only repaints.
  let wired = false;
  async function paintDashboard() {
    if (!wired) { wired = true; wireOverview(); }
    paintSkeleton();
    const key = cacheKey();
    const cached = readCache();
    if (cached && painted !== key) {
      history = cached.history;
      painted = key;
      paintAll(cached.matches || [], cached.counts || {});
    }
    if (inflight && inflight.key === key) {
      const { matches, counts } = await inflight.promise;
      paintAll(matches, counts);
      return;
    }
    const promise = loadDashboard().then((d) => ({
      h: d?.history || null, matches: d?.matches || [], counts: d?.counts || {}, at: d?.computed_at || null,
      // The box answers at once from the stored copy and refreshes it in
      // the background (updating), or has none yet (computing).
      pending: !!(d && (d.computing || d.updating)), missing: !d,
    }));
    inflight = { key, promise };
    const { h, matches, counts, at, pending, missing } = await promise;
    if (cacheKey() !== key) return; // the skills changed meanwhile
    // Still being computed on the box: ask again every few seconds for a
    // couple of minutes. A failed request gets two slower tries.
    if (pending && pendingPolls < 40) {
      pendingPolls++;
      setTimeout(() => { inflight = null; paintDashboard(); }, 4000);
    } else if (missing && historyRetries < 2) {
      historyRetries++;
      setTimeout(() => { inflight = null; paintDashboard(); }, 20000);
    }
    if (!pending) pendingPolls = 0;
    // Nothing stored yet: keep the bones up rather than paint empty cards.
    if (pending && !at) return;
    history = h;
    painted = key;
    if (h) writeCache(h, matches, counts, at);
    paintAll(matches, counts);
  }

  window.paintDashboard = paintDashboard;
})();
