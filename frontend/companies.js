// The companies directory (/companies). The list is /api/companies/
// directory under the chosen filters; a picked company reads its own
// profile (/api/companies/<domain>), its facets and its newest roles.
// What the API does not have (industry, size) is not on the page.
(function () {
  const API = "/api";
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString("en-US");
  const ATS = { greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby", workday: "Workday", smartrecruiters: "SmartRecruiters",
    workable: "Workable", comeet: "Comeet", recruitee: "Recruitee", personio: "Personio", teamtailor: "Teamtailor",
    bamboohr: "BambooHR", breezy: "Breezy", jazzhr: "JazzHR", pinpoint: "Pinpoint", oracle: "Oracle", eightfold: "Eightfold",
    hunter: "Hunter" };
  // A scraper of our own is named for the company it reads (tycowp,
  // niloosoft, apple...). To a reader those are all one thing, the
  // company's own website, so they count, filter and read as one.
  const atsKey = (a) => (a ? (ATS[a] ? a : "custom") : null);
  const atsName = (a) => (a ? ATS[a] || "Company website" : "Unknown");

  // A row's trend: the last seven days of open roles as one line, 90 by
  // 28, under the list's "Trend chart" head. Fewer than two days on
  // record draws nothing rather than a dot.
  function rowSpark(trend) {
    const pts = (trend || []).map((v, i) => [i, v]).filter(([, v]) => v != null);
    if (pts.length < 2) return "";
    const w = 90, h = 28, n = (trend || []).length - 1;
    const vals = pts.map(([, v]) => v);
    const min = Math.min(...vals), max = Math.max(...vals), span = Math.max(1, max - min);
    const d = pts.map(([i, v], k) => `${k ? "L" : "M"}${(i / n * w).toFixed(1)} ${(h - 3 - ((v - min) / span) * (h - 6)).toFixed(1)}`).join(" ");
    const up = vals[vals.length - 1] >= vals[0];
    return `<svg class="dir-trend${up ? " up" : " down"}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="Open roles over seven days, ${fmt(vals[0])} to ${fmt(vals[vals.length - 1])}"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
  }

  const COUNTRY_KEY = "iljobs_dir_country";
  const FOLLOW_KEY = "iljobs_dir_follow";
  let following = new Set();
  try { following = new Set(JSON.parse(localStorage.getItem(FOLLOW_KEY) || "[]")); } catch { /* per-browser nicety only */ }
  let savedCountry = "";
  try { savedCountry = localStorage.getItem(COUNTRY_KEY) || ""; } catch { /* as above */ }
  const state = { country: savedCountry, ats: new Set(), view: "hiring", q: "", sort: "roles", selected: null, shown: 50 };
  let directory = null;   // the API's list for the current country
  let countries = [];     // every country with its open-role count, once
  let loadSeq = 0;

  const countryName = (code) => (countries.find((c) => c.value === code) || {}).label || code;
  const where = () => (state.country ? ` in ${countryName(state.country)}` : "");

  async function loadCountries() {
    try {
      const r = await fetch(`${API}/facets?confidence=all`);
      countries = ((await r.json()).locations || []).map((c) => ({ value: c.value, label: c.label, n: c.n }));
    } catch { countries = []; }
    // The list and the empty pane may have drawn first with the
    // country's code for a name.
    if (directory) renderAll(); else renderPills();
    if (!state.selected) openCompany(null);
  }

  async function loadDirectory() {
    const seq = ++loadSeq;
    directory = null;
    renderList();
    renderPills();
    let data;
    try {
      const r = await fetch(`${API}/companies/directory?confidence=all${state.country ? `&country=${encodeURIComponent(state.country)}` : ""}`);
      if (!r.ok) throw new Error(`${r.status}`);
      data = await r.json();
    } catch (e) {
      if (seq !== loadSeq) return;
      // Said plainly, with the status, rather than bones for ever.
      $("#dir-count").textContent = "Could not load the list";
      $("#dir-sub").textContent = /^\d+$/.test(e.message) ? `The API answered ${e.message}. Try again in a minute.` : "The API did not answer. Try again in a minute.";
      return;
    }
    if (seq !== loadSeq) return;
    directory = data;
    renderAll();
  }

  function rows() {
    let out = (directory?.companies || []).map((c) => ({ ...c, name: c.name || c.domain }));
    if (state.view === "following") out = out.filter((r) => following.has(r.domain));
    if (state.ats.size) out = out.filter((r) => r.ats && state.ats.has(atsKey(r.ats)));
    if (state.q) {
      const q = state.q.toLowerCase();
      out = out.filter((r) => r.name.toLowerCase().includes(q) || r.domain.includes(q) || atsName(r.ats).toLowerCase().includes(q));
    }
    const byName = (a, b) => a.name.localeCompare(b.name);
    out.sort(state.sort === "name" ? byName
      : state.sort === "new" ? (a, b) => (b.new_7d || 0) - (a.new_7d || 0) || b.n - a.n || byName(a, b)
      : (a, b) => b.n - a.n || byName(a, b));
    return out;
  }

  function atsCounts() {
    const counts = {};
    for (const r of (directory?.companies || [])) if (r.ats) counts[atsKey(r.ats)] = (counts[atsKey(r.ats)] || 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }

  function logoTile(r) {
    const letter = esc((r.name || r.domain || "?").trim()[0].toUpperCase());
    const img = r.has_logo === false ? "" : `<img src="/logo/${encodeURIComponent(r.domain)}.png" alt="" loading="lazy" onerror="this.hidden=true" />`;
    return `<span class="dir-logo">${img}<span class="dir-letter">${letter}</span></span>`;
  }

  // Bones where numbers are still coming: a list says nothing in words
  // while it loads, it shows the shape of what is coming.
  const bone = (w, h = 11) => `<span class="skeleton sk-line" style="width:${w};height:${h}px"></span>`;
  const boneRows = (n, cls) => Array.from({ length: n }, (_, i) => `<div class="${cls}" aria-hidden="true">${bone(`${[62, 48, 70, 55][i % 4]}%`)}</div>`).join("");
  const boneList = (n) => Array.from({ length: n }, (_, i) => `
      <div class="dir-row dir-row-bone" aria-hidden="true">
        <span class="dir-logo skeleton sk-logo"></span>
        <div class="dir-main">${bone(`${[55, 40, 66, 48][i % 4]}%`, 14)}<div style="margin-top:6px">${bone(`${[70, 58, 76, 62][i % 4]}%`)}</div></div>
        <div class="dir-trend-cell">${bone("90px", 20)}</div>
        <span></span>
        <div class="dir-count">${bone("44px", 14)}</div>
      </div>`).join("");

  function renderSidebar() {
    const hiring = directory ? directory.companies.length : null;
    $("#dir-browse").innerHTML = [["hiring", `Hiring now${where()}`, hiring], ["following", "Following", following.size]].map(([key, label, n]) =>
      `<button type="button" class="side-cat${state.view === key ? " on" : ""}" data-view="${key}" aria-pressed="${state.view === key}"><span>${esc(label)}</span><span class="side-cat-n">${n == null ? "" : fmt(n)}</span></button>`).join("");
    const counts = atsCounts();
    $("#dir-systems").innerHTML = counts.length
      ? counts.slice(0, 8).map(([a, n]) => `<button type="button" class="side-cat${state.ats.has(a) ? " on" : ""}" data-ats="${esc(a)}" aria-pressed="${state.ats.has(a)}"><span>${esc(atsName(a))}</span><span class="side-cat-n">${fmt(n)}</span></button>`).join("")
      : (directory ? '<div class="side-cat side-hint">None</div>' : boneRows(4, "side-cat"));
  }

  // What is typed into each list's search box. The box is drawn once
  // and kept, so typing never loses focus; only the list under it is
  // redrawn.
  const popQuery = { place: "", ats: "" };
  function popList(key) {
    const q = popQuery[key].trim().toLowerCase();
    const hit = (label) => !q || label.toLowerCase().includes(q);
    if (key === "place") {
      const rows = [...(hit("Anywhere") ? [`<button type="button" class="dir-opt${state.country ? "" : " on"}" data-country=""><span>Anywhere</span></button>`] : []),
        // The chosen country first, whatever its size.
        ...[...countries.filter((c) => c.value === state.country), ...countries.filter((c) => c.value !== state.country)]
          .filter((c) => hit(c.label) || hit(c.value)).map((c) =>
          `<button type="button" class="dir-opt${state.country === c.value ? " on" : ""}" data-country="${esc(c.value)}"><span>${esc(c.label)}</span><span class="dir-n">${fmt(c.n)}</span></button>`)];
      return countries.length ? (rows.join("") || '<div class="dir-opt side-hint">No country matches.</div>') : boneRows(6, "dir-opt");
    }
    const counts = atsCounts();
    const rows = counts.filter(([a]) => hit(atsName(a))).map(([a, n]) =>
      `<button type="button" class="dir-opt${state.ats.has(a) ? " on" : ""}" data-ats="${esc(a)}"><span>${esc(atsName(a))}</span><span class="dir-n">${fmt(n)}</span></button>`);
    return counts.length ? (rows.join("") || '<div class="dir-opt side-hint">No system matches.</div>') : boneRows(6, "dir-opt");
  }

  function renderPills() {
    const sum = (id, text) => { const el = $(id); el.textContent = text; el.hidden = !text; };
    sum("#dir-sum-place", state.country ? countryName(state.country) : "");
    sum("#dir-sum-ats", [...state.ats].map(atsName).join(", "));
    for (const [key, placeholder] of [["place", "Search countries"], ["ats", "Search hiring systems"]]) {
      const pop = $(`#dir-pop-${key}`);
      if (!pop.querySelector(".dir-pop-list")) {
        pop.innerHTML = `<input type="search" class="rail-search dir-pop-search" data-pop="${key}" placeholder="${placeholder}" aria-label="${placeholder}" autocomplete="off" /><div class="dir-pop-list"></div>`;
      }
      pop.querySelector(".dir-pop-list").innerHTML = popList(key);
    }
    $("#dir-reset").hidden = !state.country && !state.ats.size && state.view === "hiring" && !state.q;
  }

  function renderList() {
    const body = $("#dir-rows");
    if (!directory) {
      $("#dir-count").innerHTML = bone("240px", 14);
      $("#dir-sub").textContent = "";
      body.innerHTML = boneList(10);
      return;
    }
    const list = rows();
    $("#dir-count").textContent = state.view === "following"
      ? `${fmt(list.length)} companies you follow${where()}`
      : `Top ${fmt(list.length)} companies by open jobs${where()}`;
    $("#dir-sub").textContent = "";
    body.innerHTML = list.slice(0, state.shown).map((r) => `
      <div class="dir-row${r.domain === state.selected ? " selected" : ""}" data-domain="${esc(r.domain)}" tabindex="0" role="button">
        ${logoTile(r)}
        <div class="dir-main">
          <div class="dir-name">${esc(r.name)}</div>
          <div class="dir-line">${esc(r.domain)} · ${esc(atsName(r.ats))}</div>
        </div>
        <div class="dir-trend-cell">${rowSpark(r.trend)}</div>
        <button type="button" class="dir-follow${following.has(r.domain) ? " on" : ""}" data-follow="${esc(r.domain)}" aria-pressed="${following.has(r.domain)}" aria-label="${following.has(r.domain) ? "Unfollow" : "Follow"} ${esc(r.name)}">${following.has(r.domain) ? "Following" : "Follow"}</button>
        <div class="dir-count"><b>${fmt(r.n)}</b><span>${r.new_7d ? `+${fmt(r.new_7d)} this week` : "open roles"}</span></div>
      </div>`).join("") + (list.length > state.shown
        ? `<div class="dir-more"><button type="button" class="btn ghost" id="dir-more">Show ${Math.min(50, list.length - state.shown)} more</button></div>`
        : (list.length ? "" : `<div class="dir-empty">No companies match.</div>`));
  }

  function renderAll() { renderSidebar(); renderPills(); renderList(); }

  // Twelve weeks of open roles as one line, from company_daily. Before
  // the table has a fortnight in it the chart would be two dots, so it
  // says when the record starts instead.
  function sparkline(history) {
    const pts = (history || []).map((h) => h.open_n);
    if (pts.length < 14) return `<span class="dir-hint">Daily counts start ${history?.length ? `on ${esc(history[0].day)}` : "with the next publish run"}.</span>`;
    const w = 280, h = 56, max = Math.max(1, ...pts), min = Math.min(...pts);
    const span = Math.max(1, max - min);
    const xy = pts.map((v, i) => [i * (w / (pts.length - 1)), h - 4 - ((v - min) / span) * (h - 8)]);
    const d = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
    return `<svg class="dir-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" fill="none" stroke="var(--black)" stroke-width="1.5"/></svg>
      <div class="dir-spark-axis"><span>${esc(history[0].day.slice(5))}</span><span>${fmt(min)}–${fmt(max)} open</span><span>${esc(history[history.length - 1].day.slice(5))}</span></div>`;
  }

  const age = (iso) => {
    if (!iso) return "";
    const hrs = (Date.now() - new Date(iso).getTime()) / 36e5;
    return hrs < 1 ? "just now" : hrs < 24 ? `${Math.floor(hrs)}h ago` : `${Math.floor(hrs / 24)}d ago`;
  };

  let panelSeq = 0;
  async function openCompany(domain) {
    state.selected = domain;
    $("#job-detail").classList.toggle("open", !!domain);
    $("#job-scrim").classList.toggle("open", !!domain);
    document.querySelectorAll(".dir-row").forEach((r) => r.classList.toggle("selected", r.dataset.domain === domain));
    history.replaceState(null, "", domain ? `#${domain}` : location.pathname + location.search);
    const head = $("#dir-pane-head");
    const body = $("#dir-pane-body");
    if (!domain) {
      head.innerHTML = `<div class="list-head-text"><span class="col-head-title">Company</span><span class="col-head-sub">${esc(state.country ? countryName(state.country) : "Everywhere")}</span></div>`;
      body.innerHTML = `<div class="detail-empty"><div class="ov-hint">Select a company to see its details here.</div></div>`;
      return;
    }
    const seq = ++panelSeq;
    const row = rows().find((r) => r.domain === domain) || { domain, name: domain, n: null, ats: null };
    head.innerHTML = `<span class="dir-crumb">Companies / <b>${esc(row.name)}</b></span><button type="button" class="pane-close" id="dir-close" aria-label="Close">&#10005;</button>`;
    body.innerHTML = `<div class="dir-panel">
      <div class="dir-company">${logoTile(row)}<div><h2>${esc(row.name)}</h2>
        <div class="dir-line">${esc(atsName(row.ats))} · <a href="https://${esc(domain)}" target="_blank" rel="noopener">${esc(domain)}</a></div></div></div>
      <div class="dir-actions">
        <a class="btn primary" href="/board?company=${encodeURIComponent(domain)}${state.country ? `&country=${encodeURIComponent(state.country)}` : ""}">See ${row.n == null ? "the" : fmt(row.n)} open roles</a>
        <a class="btn ghost" href="/account">Alert me when they post</a>
        <a class="btn ghost" href="https://${esc(domain)}" target="_blank" rel="noopener">Careers page &nearr;</a>
      </div>
      <div class="ov-tiles" id="dir-tiles"></div>
      <div class="ov-block"><span class="ov-block-title">Open roles, twelve weeks</span><div id="dir-spark">${bone("100%", 56)}</div></div>
      <div class="ov-block"><span class="ov-block-title">Hiring for</span><div class="dir-bars" id="dir-bars">${boneRows(3, "dir-bar-bone")}</div></div>
      <div class="ov-block"><div class="dir-block-head"><span class="ov-block-title">Newest roles</span><a id="dir-all" href="/board?company=${encodeURIComponent(domain)}">All</a></div><div class="dir-jobs" id="dir-jobs"></div></div>
    </div>`;
    const here = state.country ? `&country=${encodeURIComponent(state.country)}` : "";
    const q = (extra) => `${API}/jobs?company=${encodeURIComponent(domain)}&confidence=all&${extra}`;
    const [profile, newest, cf] = await Promise.all([
      fetch(`${API}/companies/${encodeURIComponent(domain)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(q(`limit=4&sort=age&dir=asc${here}`)).then((r) => r.json()).catch(() => null),
      fetch(`${API}/facets?confidence=all&company=${encodeURIComponent(domain)}${here}`).then((r) => r.json()).catch(() => null),
    ]);
    if (seq !== panelSeq) return;
    const hereN = newest?.total ?? row.n;
    const tiles = [];
    const tile = (label, value, sub, cls = "") => tiles.push(`<div class="ov-tile ${cls}"><span class="ov-label">${label}</span><span class="ov-value">${value}</span>${sub ? `<span class="ov-sub">${sub}</span>` : ""}</div>`);
    const worldwide = profile && state.country && profile.open_jobs > hereN ? `of ${fmt(profile.open_jobs)} worldwide` : "";
    tile(state.country ? `Open roles in ${esc(countryName(state.country))}` : "Open roles", fmt(hereN), worldwide);
    tile("New this week", profile ? fmt(profile.new_jobs_7d) : "–", "first seen in the past 7 days", "dir-green");
    tile("Hiring system", esc(atsName(profile?.ats ?? row.ats)), "", "dir-words");
    const cities = (cf?.locations || []).flatMap((c) => (c.cities || []).slice(0, 3).map((x) => x.value));
    tile(state.country ? "Sites" : "Countries", esc(cities.slice(0, 3).join(" · ") || (cf?.locations || []).slice(0, 3).map((c) => c.label).join(" · ") || "–"), "", "dir-words");
    $("#dir-tiles").innerHTML = tiles.join("");
    $("#dir-spark").innerHTML = sparkline(profile?.history);
    const cats = (cf?.categories || []).slice(0, 5);
    const max = Math.max(1, ...cats.map((c) => c.n));
    $("#dir-bars").innerHTML = cats.length ? cats.map((c) => `<div class="dir-bar"><span>${esc(c.value)}</span><span class="dir-bar-track"><span class="dir-bar-fill" style="width:${Math.round(100 * c.n / max)}%"></span></span><span class="dir-bar-n">${fmt(c.n)}</span></div>`).join("") : `<span class="dir-hint">No categorised roles.</span>`;
    $("#dir-all").textContent = `All ${fmt(hereN)}`;
    $("#dir-jobs").innerHTML = (newest?.jobs || []).map((j) => `<a class="dir-job" href="/job/${esc(j.id)}"><span class="dir-job-title">${esc(j.title)}${j.location ? ` <span class="dir-job-where">· ${esc(String(j.location).split(";")[0])}</span>` : ""}</span><span class="dir-job-age">${age(j.posted_at)}</span></a>`).join("") || `<span class="dir-hint">No open roles here.</span>`;
  }

  // The corner says who is signed in, the way the board's does. The
  // session is the one localStorage entry auth.js keeps, so this page
  // only has to read it; signing in happens on the board or /account.
  function paintCorner() {
    const login = $(".dir-login");
    if (!login || typeof getAuthTokens !== "function") return;
    const tokens = getAuthTokens();
    if (!tokens) return;
    const email = decodeJwtEmail(tokens.id_token) || "";
    login.outerHTML = `<a class="hero-account-btn dir-account" href="/account">${avatarHtml(email, tokens.id_token)}My Account</a>`;
  }

  function wire() {
    wireSideBar();
    paintCorner();
    $("#theme-toggle")?.addEventListener("click", () => {
      const dark = document.documentElement.getAttribute("data-theme") !== "dark";
      if (dark) document.documentElement.setAttribute("data-theme", "dark");
      else document.documentElement.removeAttribute("data-theme");
      $("#theme-toggle").setAttribute("aria-checked", String(dark));
      try { localStorage.setItem("iljobs_theme", dark ? "dark" : "light"); } catch { /* as above */ }
    });
    $("#dir-browse").addEventListener("click", (e) => {
      const b = e.target.closest("[data-view]"); if (!b) return;
      state.view = b.dataset.view; state.shown = 50; renderAll();
    });
    $("#dir-systems").addEventListener("click", (e) => {
      const b = e.target.closest("[data-ats]"); if (!b) return;
      state.ats.has(b.dataset.ats) ? state.ats.delete(b.dataset.ats) : state.ats.add(b.dataset.ats);
      state.shown = 50; renderAll();
    });
    const search = $("#dir-search");
    search.addEventListener("input", () => { state.q = search.value.trim(); state.shown = 50; renderList(); renderPills(); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName || "")) { e.preventDefault(); search.focus(); }
    });

    // Pills: one open at a time, a click outside or Escape closes.
    const closePills = () => {
      document.querySelectorAll(".dir-pill[aria-expanded='true']").forEach((p) => { p.setAttribute("aria-expanded", "false"); p.nextElementSibling.hidden = true; });
      document.body.classList.remove("pill-open");
    };
    document.addEventListener("click", (e) => {
      const pill = e.target.closest(".dir-pill");
      if (pill) {
        const open = pill.getAttribute("aria-expanded") === "true";
        closePills();
        if (!open) {
          pill.setAttribute("aria-expanded", "true");
          pill.nextElementSibling.hidden = false;
          document.body.classList.add("pill-open");
          // Not on a phone: the keyboard would take half the sheet as it opens.
          if (!matchMedia("(max-width: 800px)").matches) pill.nextElementSibling.querySelector(".dir-pop-search")?.focus({ preventScroll: true });
        }
        return;
      }
      if (!e.target.closest(".dir-pop")) closePills();
    });
    document.addEventListener("input", (e) => {
      const box = e.target.closest(".dir-pop-search");
      if (!box) return;
      popQuery[box.dataset.pop] = box.value;
      box.closest(".dir-pop").querySelector(".dir-pop-list").innerHTML = popList(box.dataset.pop);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (closeSideDrawer()) return;
      if (document.querySelector(".dir-pill[aria-expanded='true']")) return closePills();
      if (state.selected) openCompany(null);
    });
    $("#dir-pop-place").addEventListener("click", (e) => {
      const b = e.target.closest("[data-country]"); if (!b) return;
      state.country = b.dataset.country; state.shown = 50;
      try { localStorage.setItem(COUNTRY_KEY, state.country); } catch { /* as above */ }
      closePills(); loadDirectory();
    });
    $("#dir-pop-ats").addEventListener("click", (e) => {
      const b = e.target.closest("[data-ats]"); if (!b) return;
      state.ats.has(b.dataset.ats) ? state.ats.delete(b.dataset.ats) : state.ats.add(b.dataset.ats);
      state.shown = 50; renderAll();
    });
    $("#dir-reset").addEventListener("click", () => {
      Object.assign(state, { country: "", view: "hiring", q: "", shown: 50 }); state.ats.clear(); search.value = "";
      try { localStorage.setItem(COUNTRY_KEY, ""); } catch { /* as above */ }
      loadDirectory();
    });
    $("#dir-sort").addEventListener("change", (e) => { state.sort = e.target.value; renderList(); });

    $("#dir-rows").addEventListener("click", (e) => {
      const star = e.target.closest("[data-follow]");
      if (star) {
        const d = star.dataset.follow;
        following.has(d) ? following.delete(d) : following.add(d);
        try { localStorage.setItem(FOLLOW_KEY, JSON.stringify([...following])); } catch { /* as above */ }
        renderAll();
        return;
      }
      if (e.target.closest("#dir-more")) { state.shown += 50; renderList(); return; }
      const row = e.target.closest(".dir-row");
      if (row) openCompany(row.dataset.domain === state.selected ? null : row.dataset.domain);
    });
    $("#dir-rows").addEventListener("keydown", (e) => {
      const row = e.target.closest(".dir-row");
      if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openCompany(row.dataset.domain); }
    });
    $("#dir-pane-head").addEventListener("click", (e) => { if (e.target.closest("#dir-close")) openCompany(null); });
    $("#job-scrim").addEventListener("click", () => openCompany(null));
  }

  async function start() {
    wire();
    openCompany(null);
    loadCountries();
    await loadDirectory();
    const want = decodeURIComponent(location.hash.slice(1));
    if (want) openCompany(want);
  }
  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", start) : start();
})();
