// The account page's overview: a greeting with what is new, four
// numbers with a fortnight behind each, the market the reader's skills
// are in, the skills themselves against demand, the newest fits, what
// they pay, and what the alerts have been doing. Every number is the
// reader's own, from the same endpoints the board uses, plus
// /api/jobs/history for the days. Called by account.js's bootAccount
// once the profile, alerts and saved lists are in.
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
  const weekdayOf = (d) => d.toLocaleDateString(undefined, { weekday: "long" });

  // One line as a polyline, in a 90x28 box, for the tiles.
  function spark(values, cls = "") {
    const pts = values.filter((v) => v != null);
    if (pts.length < 2) return "";
    const w = 90, h = 28, min = Math.min(...pts), max = Math.max(...pts), span = Math.max(1, max - min);
    const d = values.map((v, i) => `${i ? "L" : "M"}${(i / (values.length - 1) * w).toFixed(1)} ${(h - 3 - ((v - min) / span) * (h - 6)).toFixed(1)}`).join(" ");
    const area = `<path class="acct-spark-area" d="${d} L${w} ${h} L0 ${h} Z"/>`;
    return `<svg class="acct-spark ${cls}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${area}<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
  }

  function tile(label, value, sub, sparkHtml, cls = "", delta = "") {
    // A phone shows only the tiles with a number in them.
    if (value === "0" || value === "–" || value === "" || value == null) cls += " acct-stat-empty";
    return `<div class="acct-stat ${cls}"><span class="acct-stat-label">${label}</span><span class="acct-stat-value">${value}${delta}</span><span class="acct-stat-sub">${sub}</span>${sparkHtml}</div>`;
  }

  // How a number moved, the way the board's overview says it: an arrow
  // and a percentage against the period before. Nothing when there was
  // nothing before to measure against.
  function delta(now, prev) {
    if (now == null || prev == null || !prev) return "";
    // The record only reaches back as far as the scrapers' first sight
    // of each role, so a month-ago figure a fraction of today's means
    // the record was thin then, not that the market grew tenfold.
    if (prev < now / 4) return "";
    const pct = Math.round(((now - prev) / prev) * 100);
    const dir = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
    const arrow = dir === "up" ? "&#8599;" : dir === "down" ? "&#8600;" : "&#8594;";
    const shown = Math.abs(pct) >= 1000 ? `${Math.round(Math.abs(pct) / 100) / 10}k` : Math.abs(pct);
    return `<span class="acct-delta ${dir}" title="${pct > 0 ? "+" : ""}${pct}% against the period before"><span aria-hidden="true">${arrow}</span> ${shown}%</span>`;
  }

  // The history behind the tiles; it comes with the dashboard.
  let history = null;

  // ---- the tiles and the greeting line ----
  function paintStats(savedJobs) {
    const host = document.getElementById("acct-stats");
    if (!host) return;
    const days = history?.days || [];
    const sum = (arr) => arr.reduce((s, d) => s + d.new, 0);
    const week = sum(days.slice(-7)), before = sum(days.slice(-14, -7));
    const open = days.length ? days[days.length - 1].open : null;
    const monthAgo = days.length >= 31 ? days[days.length - 31].open : null;
    const alerts = (typeof myAlerts !== "undefined" ? myAlerts : []) || [];
    const on = alerts.filter((a) => a.active).length;
    const sent = alerts.map((a) => a.last_notified_at).filter(Boolean).sort().pop();
    const stillOpen = savedJobs.filter((j) => !j.closed_at).length;
    const noSkills = !draft.skills.length;
    host.innerHTML = [
      tile("New matches this week", noSkills ? "–" : fmt(week), noSkills ? '<a href="#skills">Add your skills</a>' : `${fmt(before)} the week before`, spark(days.slice(-14).map((d) => d.new)), "acct-stat-green", noSkills ? "" : delta(week, before)),
      tile("Open roles that fit you", open == null ? "–" : fmt(open), monthAgo == null ? "" : `${fmt(monthAgo)} a month ago`, spark(days.slice(-30).map((d) => d.open)), "", delta(open, monthAgo)),
      tile("Alerts", fmt(alerts.length), alerts.length ? `${on} on, ${alerts.length - on} paused${sent ? ` · last sent ${ago(sent)}` : ""}` : '<a href="#alerts">Create one</a>', ""),
      tile("Saved jobs", fmt(savedJobs.length), savedJobs.length ? `${stillOpen} still open` : '<a href="/board">Save one from the board</a>', ""),
    ].join("");
    const since = `last ${weekdayOf(new Date(Date.now() - 7 * DAY))}`;
    const summary = document.getElementById("acct-summary");
    if (summary) {
      summary.innerHTML = noSkills
        ? 'Read a CV in <a href="#skills">Skills</a> and this page fills with the roles that fit you.'
        : `<b>${fmt(week)}</b> new ${week === 1 ? "job matches" : "jobs match"} your background since ${since}${open != null ? `, out of <b>${fmt(open)}</b> open roles that fit you` : ""}.`;
    }
    const all = document.getElementById("acct-matches-all");
    if (all) all.textContent = week ? `See all ${fmt(week)}` : "See all";
    const sub = document.getElementById("acct-matches-sub");
    if (sub) sub.textContent = `Since ${since}`;
    const g = document.getElementById("acct-greeting");
    if (g) g.textContent = greeting();
    const { country, min } = matchScope();
    const where = country ? ` in ${countryLabel(country)}` : "";
    const ms = document.getElementById("acct-market-sub");
    if (ms) ms.textContent = draft.skills.length ? `Open roles${where} that share at least ${min} of your skills` : "";
    const ds = document.getElementById("acct-demand-sub");
    if (ds) ds.textContent = typeof placeSummary === "function" ? placeSummary() : (country ? countryLabel(country) : "Anywhere");
    const open_link = document.getElementById("acct-open-matches");
    if (open_link && draft.skills.length) open_link.href = `/board?view=matches&skills=${encodeURIComponent(draft.skills.join(","))}${country ? `&country=${country}` : ""}`;
  }

  function ago(iso) {
    const h = (Date.now() - new Date(iso).getTime()) / 36e5;
    if (h < 1) return "just now";
    if (h < 24) return `${Math.floor(h)}h ago`;
    const d = Math.floor(h / 24);
    return d === 1 ? "yesterday" : `${d}d ago`;
  }

  // ---- the skills against demand ----
  async function paintDemand(matches, counts = {}) {
    const host = document.getElementById("acct-demand");
    if (!host) return;
    const { skills, country } = matchScope();
    if (!skills.length) { host.innerHTML = '<p class="acct-matches-empty">Add skills to see demand for them.</p>'; return; }
    host.innerHTML = Array.from({ length: Math.min(skills.length, 6) }, () => '<div class="acct-demand-row"><span class="skeleton sk-line" style="width:40%"></span></div>').join("");
    const shown = skills.slice(0, 10);
    // Skills the matches ask for that the reader does not list, with
    // the share of matches naming each; the one most asked for gets
    // the note, with what adding it would open up.
    const have = new Set(skills);
    const seen = new Map();
    for (const j of matches) for (const sk of (j.skills || "").split(",").filter(Boolean)) if (!have.has(sk)) seen.set(sk, (seen.get(sk) || 0) + 1);
    const suggested = [...seen.entries()].filter(([, n]) => matches.length && n / matches.length >= 0.2).sort((a, b) => b[1] - a[1]).slice(0, 2);
    // The counts came with the dashboard, computed with the matches.
    const rows = shown.map((sk) => ({ sk, n: counts[sk], mine: true }))
      .concat(suggested.map(([sk, share]) => ({ sk, n: counts[sk], mine: false, share: share / matches.length })))
      .filter((r) => r.n != null).sort((a, b) => b.n - a.n);
    const max = Math.max(1, ...rows.map((r) => r.n));
    host.innerHTML = rows.map((r) => `
      <div class="acct-demand-row${r.mine ? "" : " suggested"}">
        <span class="acct-demand-name">${esc(r.sk)}${r.mine ? "" : ` <button type="button" class="acct-add" data-add="${esc(r.sk)}">Add skill</button>`}</span>
        <span class="acct-demand-track"><span class="acct-demand-fill" style="width:${Math.round(100 * r.n / max)}%"></span></span>
        <span class="acct-demand-n">${fmt(r.n)}</span>
      </div>`).join("");
    const note = document.getElementById("acct-demand-note");
    if (note) {
      const top = rows.find((r) => !r.mine);
      if (top) {
        // The share alone: what adding it would open up cost a scan of its own.
        note.innerHTML = `<b>${esc(top.sk)}</b> appears in ${Math.round(top.share * 100)}% of your matches. Add it if you have it, and ${fmt(top.n)} open roles ask for it.`;
        note.hidden = false;
      } else note.hidden = true;
    }
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
      } catch { b.disabled = false; }
    }));
  }

  // ---- pay, from the matches' own estimates ----
  function parseShekels(text) {
    if (!text || !/₪|ILS|NIS/.test(text)) return null;
    const nums = [...text.matchAll(/(\d[\d,.]*)\s*([kK])?/g)].map((m) => parseFloat(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1)).filter((n) => n > 1000);
    if (!nums.length) return null;
    return nums.length >= 2 ? (nums[0] + nums[1]) / 2 : nums[0];
  }
  function paintPay(matches) {
    const host = document.getElementById("acct-pay");
    if (!host) return;
    const pays = matches.map((j) => parseShekels(j.salary_text)).filter((n) => n).sort((a, b) => a - b);
    if (pays.length < 5) { host.innerHTML = `<p class="acct-matches-empty">${draft.skills.length ? "Not enough salary estimates yet among the roles matching your background." : "Add skills to see what roles matching your background pay."}</p>`; return; }
    const q = (f) => pays[Math.min(pays.length - 1, Math.floor(f * (pays.length - 1)))];
    const med = q(0.5), lo = q(0.25), hi = q(0.75);
    const k = (n) => `₪${Math.round(n / 1000)}K`;
    const bins = 12, min = pays[0], max = pays[pays.length - 1], step = Math.max(1, (max - min) / bins);
    const hist = Array(bins).fill(0);
    for (const p of pays) hist[Math.min(bins - 1, Math.floor((p - min) / step))] += 1;
    const top = Math.max(...hist);
    const W = 280, H = 70;
    const bars = hist.map((n, i) => { const x0 = min + i * step, x1 = x0 + step; const mid = x0 <= hi && x1 >= lo; return `<rect class="acct-pay-bar${mid ? " mid" : ""}" x="${(i / bins * W).toFixed(1)}" y="${(H - 10 - (n / top) * (H - 14)).toFixed(1)}" width="${(W / bins - 2).toFixed(1)}" height="${((n / top) * (H - 14)).toFixed(1)}" rx="1"/>`; }).join("");
    const mx = ((med - min) / (max - min || 1)) * W;
    host.innerHTML = `<div class="acct-pay-head"><span class="acct-pay-value">${k(med)}</span><span class="acct-pay-sub">median /mo, estimated from ${pays.length} roles matching your background</span></div>
      <svg class="acct-pay-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Estimated salary across roles matching your background, median ${k(med)}">${bars}<line class="acct-pay-median" x1="${mx.toFixed(1)}" x2="${mx.toFixed(1)}" y1="2" y2="${H - 8}"/></svg>
      <div class="acct-pay-foot"><span>${k(min)}</span><span>Middle half pays ${k(lo)}–${k(hi)}</span><span>${k(max)}</span></div>`;
  }

  // ---- what happened ----
  function paintActivity(savedRows, savedJobs) {
    const host = document.getElementById("acct-activity");
    if (!host) return;
    const items = [];
    for (const a of ((typeof myAlerts !== "undefined" ? myAlerts : []) || [])) {
      if (a.last_notified_at) items.push({ at: a.last_notified_at, text: `${a.active ? "Alert" : "Paused alert"} ${esc(describeAlertFilter(a.filter || {}))}`, sub: "last sent" });
    }
    const byId = new Map(savedJobs.map((j) => [j.id, j]));
    for (const r of savedRows) {
      const j = byId.get(r.job_id);
      if (r.saved_at && j) items.push({ at: r.saved_at, text: `You saved ${esc(j.title)}${j.company_name ? ` at ${esc(j.company_name)}` : ""}`, sub: "" });
    }
    items.sort((a, b) => new Date(b.at) - new Date(a.at));
    host.innerHTML = items.length
      ? items.slice(0, 6).map((it) => `<div class="acct-act"><span class="acct-act-when">${esc(ago(it.at))}</span><span class="acct-act-text">${it.text}${it.sub ? ` <span class="acct-act-sub">· ${it.sub}</span>` : ""}</span></div>`).join("")
      : '<p class="acct-matches-empty">Nothing yet. Alerts you create and jobs you save show up here.</p>';
  }

  // ---- the matches, 100 of them, read once for three panels ----
  // One call: the overview's numbers, computed on the box on the first
  // visit of the day and stored with the profile (api/dashboard.py).
  let forceNext = false;
  async function loadDashboard() {
    const { skills } = matchScope();
    if (!skills.length) return null;
    const force = forceNext;
    forceNext = false;
    try { return await authedFetch(`/me/dashboard${force ? "?refresh=1" : ""}`); } catch { return null; }
  }

  function paintFresh(at) {
    const el = document.getElementById("acct-fresh");
    if (!el) return;
    if (!at) { el.hidden = true; return; }
    // "Refreshed Saturday at 3:25 PM GMT+3": the day, the time and the
    // reader's own time zone. A copy more than six days old adds the date,
    // since the weekday alone would then be ambiguous.
    const d = new Date(at);
    const old = Date.now() - d.getTime() > 6 * 864e5;
    const day = d.toLocaleDateString(undefined, old ? { weekday: "long", month: "short", day: "numeric" } : { weekday: "long" });
    const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
    el.textContent = `Refreshed ${day} at ${time}. `;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "link-inline";
    btn.id = "acct-refresh";
    btn.textContent = "Refresh now";
    el.appendChild(btn);
    if (updatingNow) {
      const tag = document.createElement("span");
      tag.className = "acct-updating";
      tag.textContent = " Updating now…";
      el.appendChild(tag);
    }
    el.hidden = false;
    el.querySelector("#acct-refresh").addEventListener("click", () => { forceNext = true; inflight = null; paintDashboard(); });
  }

  // The last answer, kept in this browser for half an hour, so the page
  // paints at once on the next visit and the fresh numbers replace it
  // quietly when they arrive. The history alone is a pass over the
  // whole table on the box.
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

  // "Updating" beside the freshness line while the box recomputes. Kept as
  // state too: the overview repaints when the alerts and saved lists come
  // in, and paintFresh puts the tag back each time.
  let updatingNow = false;
  function paintUpdating(on) {
    updatingNow = on;
    const el = document.getElementById("acct-fresh");
    if (!el) return;
    let tag = el.querySelector(".acct-updating");
    if (on && !tag) {
      tag = document.createElement("span");
      tag.className = "acct-updating";
      tag.textContent = " Updating now…";
      el.appendChild(tag);
      el.hidden = false;
    } else if (!on && tag) {
      tag.remove();
    }
  }

  // The frame at once: greeting, the four tiles and bones in every
  // panel, before any answer is in. The numbers can take seconds on a
  // busy box, and a blank page for that long reads as broken.
  function paintSkeleton() {
    const g = document.getElementById("acct-greeting");
    if (g && !/,/.test(g.textContent)) g.textContent = greeting();
    const bone = (w, h) => `<span class="skeleton sk-line" style="width:${w}px;height:${h}px;display:inline-block"></span>`;
    const stats = document.getElementById("acct-stats");
    if (stats && !stats.children.length) {
      stats.innerHTML = ["New matches this week", "Open roles that fit you", "Alerts", "Saved jobs"]
        .map((label) => tile(label, bone(64, 26), bone(120, 11), "")).join("");
    }
    const market = document.getElementById("acct-market");
    if (market && !market.children.length) market.innerHTML = `<div class="acct-market-bones">${bone(999, 180)}</div>`;
    const demand = document.getElementById("acct-demand");
    if (demand && !demand.children.length) demand.innerHTML = Array.from({ length: 5 }, () => `<div class="acct-demand-row"><span class="acct-demand-name">${bone(90, 12)}</span><span class="acct-demand-track"></span><span class="acct-demand-n">${bone(32, 12)}</span></div>`).join("");
    for (const id of ["acct-matches", "acct-pay", "acct-activity"]) {
      const el = document.getElementById(id);
      if (el && !el.children.length && !el.textContent.trim()) el.innerHTML = `<div class="acct-bones">${bone(220, 12)}<br>${bone(160, 12)}</div>`;
    }
  }
  let painted = "";
  function paintAll(matches, counts = {}, computedAt = null) {
    const savedRows = (typeof dashSavedRows !== "undefined" ? dashSavedRows : []) || [];
    const savedJobs = (typeof dashSavedJobs !== "undefined" ? dashSavedJobs : []) || [];
    paintStats(savedJobs);
    paintActivity(savedRows, savedJobs);
    paintPay(matches);
    paintDemand(matches, counts);
    paintFresh(computedAt);
    // No matches: one card with the two ways out (style.css shows it on
    // a phone, where four empty panels were the whole screen).
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
  async function paintDashboard() {
    paintSkeleton();
    const key = cacheKey();
    const cached = readCache();
    if (cached && painted !== key) {
      history = cached.history;
      painted = key;
      paintAll(cached.matches || [], cached.counts || {}, cached.computedAt || null);
    }
    if (inflight && inflight.key === key) {
      const { matches, counts, at } = await inflight.promise;
      paintAll(matches, counts, at);
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
    paintUpdating(pending);
    // Nothing stored yet: keep the bones up rather than paint empty panels.
    if (pending && !at) return;
    history = h;
    painted = key;
    if (h) writeCache(h, matches, counts, at);
    paintAll(matches, counts, at);
    paintUpdating(pending); // paintAll rewrote the freshness line
  }

  window.paintDashboard = paintDashboard;
})();
