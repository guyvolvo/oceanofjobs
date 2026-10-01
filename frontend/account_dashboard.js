// The account page's overview: a greeting with what is new, four
// numbers with a fortnight behind each, the market the reader's skills
// are in, the skills themselves against demand, the newest fits, what
// they pay, and what the alerts have been doing. Every number is the
// reader's own, from the same endpoints the board uses, plus
// /api/jobs/history for the days. Called by account.js's bootAccount
// once the profile, alerts and saved lists are in.
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString("en-US");
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

  const dayLabel = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const weekdayOf = (d) => d.toLocaleDateString("en-US", { weekday: "long" });

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

  // ---- the market ----
  let history = null;
  let range = 7;
  async function loadHistory() {
    const { skills, country, min } = matchScope();
    if (!skills.length) return null;
    const q = new URLSearchParams({ skills: skills.join(","), min_match: String(min) });
    if (country) q.set("country", country);
    try { return await getJSON(`/jobs/history?${q}`); } catch { return null; }
  }

  // The card grows when the panel beside it fills in, and shrinks on a
  // narrower window; the drawing follows its box either way.
  let marketResize = null, marketDrawn = "", marketWatch = null;
  function watchMarket(host) {
    if (marketWatch || typeof ResizeObserver === "undefined") return;
    marketWatch = new ResizeObserver(() => {
      const r = host.getBoundingClientRect();
      if (`${Math.round(r.width)}x${Math.round(r.height)}` === marketDrawn) return;
      clearTimeout(marketResize);
      marketResize = setTimeout(() => { if (history) drawMarket(); }, 120);
    });
    marketWatch.observe(host);
  }

  function drawMarket() {
    const host = document.getElementById("acct-market");
    if (!host) return;
    if (!history || !history.days.length) {
      host.innerHTML = `<p class="acct-matches-empty">${draft.skills.length ? "Could not load the market." : "Add skills to see your market."}</p>`;
      return;
    }
    // 24h is yesterday to today: the record is daily.
    const days = history.days.slice(-(range === 1 ? 2 : range));
    const box = host.getBoundingClientRect();
    const W = Math.max(320, Math.round(box.width || host.clientWidth || 640)), H = Math.max(160, Math.round(box.height || host.clientHeight || 220));
    const L = 44, R = 12, T = 14, B = 26;
    marketDrawn = `${W}x${H}`;
    watchMarket(host);
    const iw = W - L - R, ih = H - T - B;
    const maxOpen = Math.max(1, ...days.map((d) => d.open));
    const minOpen = Math.min(...days.map((d) => d.open));
    const x = (i) => L + (days.length === 1 ? iw / 2 : i / (days.length - 1) * iw);
    // The line sits on the range the numbers occupy, the way the tiles'
    // sparklines do, so a day's move is visible rather than a flat line
    // over a tall axis.
    const span = Math.max(1, maxOpen - minOpen);
    const yOpen = (v) => T + ih - ((v - minOpen) / span) * ih;
    const line = days.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${yOpen(d.open).toFixed(1)}`).join(" ");
    const area = `${line} L${x(days.length - 1).toFixed(1)} ${T + ih} L${x(0).toFixed(1)} ${T + ih} Z`;
    const ticks = [0, 0.5, 1].map((f) => `<text class="acct-axis" x="${L - 6}" y="${(T + ih - f * ih + 4).toFixed(1)}" text-anchor="end">${fmt(Math.round(minOpen + span * f))}</text>`).join("");
    const first = days[0].day, last = days[days.length - 1].day;
    host.innerHTML = `<svg class="acct-market-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Open roles matching your background over ${days.length} days, ${fmt(days[0].open)} to ${fmt(days[days.length - 1].open)}">
      <line class="acct-grid" x1="${L}" x2="${W - R}" y1="${T + ih}" y2="${T + ih}"/>
      <line class="acct-grid" x1="${L}" x2="${W - R}" y1="${T + ih / 2}" y2="${T + ih / 2}"/>
      ${ticks}
      <path class="acct-area" d="${area}"/>
      <path class="acct-line" d="${line}" fill="none"/>
      <text class="acct-axis" x="${L}" y="${H - 8}">${dayLabel(first)}</text><text class="acct-axis" x="${W - R}" y="${H - 8}" text-anchor="end">${dayLabel(last)}</text>
      <g class="acct-cursor" hidden><line x1="0" x2="0" y1="${T}" y2="${T + ih}"/><circle r="3.5"/></g>
    </svg><div class="acct-tip" hidden></div>`;
    // The tooltip: the nearest day under the pointer, said in words.
    const svg = host.querySelector("svg"), tip = host.querySelector(".acct-tip"), cur = host.querySelector(".acct-cursor");
    svg.addEventListener("mousemove", (e) => {
      const r = svg.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width * W;
      const i = Math.max(0, Math.min(days.length - 1, Math.round((px - L) / iw * (days.length - 1))));
      const d = days[i];
      cur.hidden = false;
      cur.querySelector("line").setAttribute("x1", x(i)); cur.querySelector("line").setAttribute("x2", x(i));
      cur.querySelector("circle").setAttribute("cx", x(i)); cur.querySelector("circle").setAttribute("cy", yOpen(d.open));
      tip.hidden = false;
      tip.textContent = `${dayLabel(d.day)} · ${fmt(d.open)} open, ${fmt(d.new)} new that day`;
      const left = (x(i) / W) * r.width;
      tip.style.left = `${Math.min(r.width - 170, Math.max(0, left - 80))}px`;
    });
    svg.addEventListener("mouseleave", () => { cur.hidden = true; tip.hidden = true; });
  }

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
  async function paintDemand(matches) {
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
    // One request for every count: the API sums them in one pass, where
    // a count per skill was a scan of the whole table each.
    let counts = {};
    try {
      const q = new URLSearchParams({ skills: [...shown, ...suggested.map(([sk]) => sk)].join(","), confidence: "all" });
      if (country) q.set("country", country);
      counts = (await getJSON(`/jobs/skill_counts?${q}`)).counts || {};
    } catch { counts = {}; }
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
  async function loadTopMatches() {
    const { skills, country } = matchScope();
    if (!skills.length) return [];
    const q = new URLSearchParams({ skills: skills.join(","), sort: "match", dir: "asc", limit: "60", count: "skip" });
    if (country) q.set("country", country);
    try { return (await getJSON(`/jobs?${q}`)).jobs || []; } catch { return []; }
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
  function writeCache(h, matches) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ key: cacheKey(), at: Date.now(), history: h, matches: matches.slice(0, 100) })); } catch { /* per-browser nicety only */ }
  }

  let inflight = null;
  let historyRetries = 0;

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
  function paintAll(matches) {
    const savedRows = (typeof dashSavedRows !== "undefined" ? dashSavedRows : []) || [];
    const savedJobs = (typeof dashSavedJobs !== "undefined" ? dashSavedJobs : []) || [];
    paintStats(savedJobs);
    drawMarket();
    paintActivity(savedRows, savedJobs);
    paintPay(matches);
    paintDemand(matches);
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
      paintAll(cached.matches || []);
    }
    if (inflight && inflight.key === key) {
      const { matches } = await inflight.promise;
      paintAll(matches);
      return;
    }
    const promise = Promise.all([loadHistory(), loadTopMatches()]).then(([h, matches]) => ({ h, matches }));
    inflight = { key, promise };
    const { h, matches } = await promise;
    if (cacheKey() !== key) return; // the skills changed meanwhile
    // No history means the box did not answer in time. Ask again in a
    // little while, twice, rather than leave the page half drawn.
    if (!h && historyRetries < 2) {
      historyRetries++;
      setTimeout(() => { inflight = null; paintDashboard(); }, 20000);
    }
    history = h;
    painted = key;
    if (h) writeCache(h, matches);
    paintAll(matches);
  }

  document.getElementById("acct-range")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-range]");
    if (!b) return;
    range = Number(b.dataset.range);
    document.querySelectorAll("#acct-range button").forEach((x) => x.classList.toggle("on", x === b));
    drawMarket();
  });

  window.paintDashboard = paintDashboard;
})();
