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
    const area = cls ? `<path class="acct-spark-area" d="${d} L${w} ${h} L0 ${h} Z"/>` : "";
    return `<svg class="acct-spark ${cls}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${area}<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
  }

  function tile(label, value, sub, sparkHtml, cls = "") {
    return `<div class="acct-stat ${cls}"><span class="acct-stat-label">${label}</span><span class="acct-stat-value">${value}</span><span class="acct-stat-sub">${sub}</span>${sparkHtml}</div>`;
  }

  // ---- the market ----
  let history = null;
  let range = 30;
  async function loadHistory() {
    const { skills, country, min } = matchScope();
    if (!skills.length) return null;
    const q = new URLSearchParams({ skills: skills.join(","), min_match: String(min) });
    if (country) q.set("country", country);
    try { return await getJSON(`/jobs/history?${q}`); } catch { return null; }
  }

  function drawMarket() {
    const host = document.getElementById("acct-market");
    if (!host) return;
    if (!history || !history.days.length) {
      host.innerHTML = `<p class="acct-matches-empty">${draft.skills.length ? "Could not load the market." : "Add skills to see your market."}</p>`;
      return;
    }
    const days = history.days.slice(-range);
    const W = 640, H = 220, L = 44, R = 12, T = 14, B = 26;
    const iw = W - L - R, ih = H - T - B;
    const maxOpen = Math.max(1, ...days.map((d) => d.open));
    const maxNew = Math.max(1, ...days.map((d) => d.new));
    const x = (i) => L + (days.length === 1 ? iw / 2 : i / (days.length - 1) * iw);
    const yOpen = (v) => T + ih - (v / maxOpen) * ih;
    const yNew = (v) => T + ih - (v / maxNew) * ih * 0.5;
    const bw = Math.max(2, Math.min(14, iw / days.length * 0.6));
    const bars = days.map((d, i) => `<rect class="acct-bar${i === days.length - 1 ? " today" : ""}" x="${(x(i) - bw / 2).toFixed(1)}" y="${yNew(d.new).toFixed(1)}" width="${bw.toFixed(1)}" height="${(T + ih - yNew(d.new)).toFixed(1)}" rx="1"/>`).join("");
    const line = days.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${yOpen(d.open).toFixed(1)}`).join(" ");
    const ticks = [0, 0.5, 1].map((f) => `<text class="acct-axis" x="${L - 6}" y="${(T + ih - f * ih + 4).toFixed(1)}" text-anchor="end">${fmt(Math.round(maxOpen * f))}</text>`).join("");
    const first = days[0].day, last = days[days.length - 1].day;
    host.innerHTML = `<svg class="acct-market-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Open roles matching you over ${days.length} days, ${fmt(days[0].open)} to ${fmt(days[days.length - 1].open)}">
      <line class="acct-grid" x1="${L}" x2="${W - R}" y1="${T + ih}" y2="${T + ih}"/>
      <line class="acct-grid" x1="${L}" x2="${W - R}" y1="${T + ih / 2}" y2="${T + ih / 2}"/>
      ${ticks}${bars}
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
      tile("New matches this week", noSkills ? "–" : fmt(week), noSkills ? '<a href="#skills">Add your skills</a>' : `${fmt(before)} the week before`, spark(days.slice(-14).map((d) => d.new)), "acct-stat-green"),
      tile("Open roles that fit you", open == null ? "–" : fmt(open), monthAgo == null ? "" : `${fmt(monthAgo)} a month ago`, spark(days.slice(-30).map((d) => d.open))),
      tile("Alerts", fmt(alerts.length), alerts.length ? `${on} on, ${alerts.length - on} paused${sent ? ` · last sent ${ago(sent)}` : ""}` : '<a href="#alerts">Create one</a>', ""),
      tile("Saved jobs", fmt(savedJobs.length), savedJobs.length ? `${stillOpen} still open` : '<a href="/board">Save one from the board</a>', ""),
    ].join("");
    const since = weekdayOf(new Date(Date.now() - 7 * DAY));
    const summary = document.getElementById("acct-summary");
    if (summary) {
      summary.innerHTML = noSkills
        ? 'Read a CV in <a href="#skills">Skills</a> and this page fills with the roles that fit you.'
        : `<b>${fmt(week)}</b> new ${week === 1 ? "job matches" : "jobs match"} your skills since ${since}${open != null ? `, out of <b>${fmt(open)}</b> open roles that fit you` : ""}.`;
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
    if (ds) ds.textContent = `Open roles${where} asking for each skill`;
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
    const count = async (sk) => {
      const q = new URLSearchParams({ skills: sk, limit: "1" });
      if (country) q.set("country", country);
      try { return (await getJSON(`/jobs?${q}`)).total || 0; } catch { return null; }
    };
    // Five at a time: the API allows sixty requests in ten seconds per
    // address, and this page is already asking for several other things.
    const counts = [];
    for (let i = 0; i < shown.length; i += 5) counts.push(...await Promise.all(shown.slice(i, i + 5).map(count)));
    // Skills the matches ask for that the reader does not list, with
    // the share of matches naming each; the one most asked for gets
    // the note, with what adding it would open up.
    const have = new Set(skills);
    const seen = new Map();
    for (const j of matches) for (const sk of (j.skills || "").split(",").filter(Boolean)) if (!have.has(sk)) seen.set(sk, (seen.get(sk) || 0) + 1);
    const suggested = [...seen.entries()].filter(([, n]) => matches.length && n / matches.length >= 0.2).sort((a, b) => b[1] - a[1]).slice(0, 2);
    const sugCounts = await Promise.all(suggested.map(([sk]) => count(sk)));
    const rows = shown.map((sk, i) => ({ sk, n: counts[i], mine: true }))
      .concat(suggested.map(([sk, share], i) => ({ sk, n: sugCounts[i], mine: false, share: share / matches.length })))
      .filter((r) => r.n != null).sort((a, b) => b.n - a.n);
    const max = Math.max(1, ...rows.map((r) => r.n));
    host.innerHTML = rows.map((r) => `
      <div class="acct-demand-row${r.mine ? "" : " suggested"}">
        <span class="acct-demand-name">${esc(r.sk)}${r.mine ? "" : ` <button type="button" class="acct-add" data-add="${esc(r.sk)}">Add?</button>`}</span>
        <span class="acct-demand-track"><span class="acct-demand-fill" style="width:${Math.round(100 * r.n / max)}%"></span></span>
        <span class="acct-demand-n">${fmt(r.n)}</span>
      </div>`).join("");
    const note = document.getElementById("acct-demand-note");
    if (note) {
      const top = rows.find((r) => !r.mine);
      if (top) {
        const q = new URLSearchParams({ skills: [...skills, top.sk].join(","), limit: "1" });
        if (country) q.set("country", country);
        let more = null;
        try { more = (await getJSON(`/jobs?${q}`)).total; } catch { /* the note says the share alone */ }
        const now = history?.days?.length ? history.days[history.days.length - 1].open : null;
        const gain = more != null && now != null ? Math.max(0, more - now) : null;
        note.innerHTML = `<b>${esc(top.sk)}</b> appears in ${Math.round(top.share * 100)}% of your matches. Add it if you have it${gain ? ` and about ${fmt(gain)} more roles open up` : ""}.`;
        note.hidden = false;
      } else note.hidden = true;
    }
    host.querySelectorAll("[data-add]").forEach((b) => b.addEventListener("click", async () => {
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
    if (pays.length < 5) { host.innerHTML = `<p class="acct-matches-empty">${draft.skills.length ? "Not enough salary figures among your matches yet." : "Add skills to see pay."}</p>`; return; }
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
    host.innerHTML = `<div class="acct-pay-head"><span class="acct-pay-value">${k(med)}</span><span class="acct-pay-sub">median /mo, estimated · ${pays.length} of your matches</span></div>
      <svg class="acct-pay-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Pay across your matches, median ${k(med)}">${bars}<line class="acct-pay-median" x1="${mx.toFixed(1)}" x2="${mx.toFixed(1)}" y1="2" y2="${H - 8}"/></svg>
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
    const q = new URLSearchParams({ skills: skills.join(","), sort: "match", dir: "asc", limit: "100", count: "skip" });
    if (country) q.set("country", country);
    try { return (await getJSON(`/jobs?${q}`)).jobs || []; } catch { return []; }
  }

  // The last answer, kept in this browser for half an hour, so the page
  // paints at once on the next visit and the fresh numbers replace it
  // quietly when they arrive. The history alone is a pass over the
  // whole table on the box.
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
