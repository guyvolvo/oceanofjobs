// The Statistics page: questions over every listing, run in the browser.
//
// Two ways to ask. The builder, which reads as a sentence ("Count
// listings that were first seen per day over the last 30 days, where
// ..."), and qb.js writes the SQL. Or the SQL itself, for anyone who
// wants what the builder cannot express. "View as SQL" shows what the
// builder wrote, so it doubles as a way to learn the schema.
//
// The answer gets a title written from the question, the few numbers
// that matter (total, change, average, peak), and one of three views in
// one chart language: an ink line or bar cap, an ink fill fading down,
// hairline gridlines, green only on what is hovered or went up. The page
// picks the view; the toggle shows which one is on and lets you change it.
//
// The database is a static SQLite file the applier rebuilds hourly
// (loader/build_explore.py). SQLite compiled to WebAssembly reads it
// through a virtual filesystem that fetches only the pages a query
// touches, by HTTP range request. No server runs anything, and a query
// can only exhaust this tab, which is the whole security model.

"use strict";

// Absolute from the site root, all three, and it matters for the last
// one: the worker resolves the wasm path relative to ITS location, not
// the page's, so a page-relative "vendor/httpvfs/sql-wasm.wasm" became
// /vendor/httpvfs/vendor/httpvfs/sql-wasm.wasm and the browser tried to
// instantiate an S3 404 document as WebAssembly. Reported live as
// "expected magic word 00 61 73 6d, found 3c 3f 78 6d", which is
// "<?xm". The library's own README uses absolute URLs for this reason.
const MANIFEST_URL = "/explore.json";   // names the current build; see loader/build_explore.py
const WORKER_URL = "/vendor/httpvfs/sqlite.worker.js";
const WASM_URL = "/vendor/httpvfs/sql-wasm.wasm";
// 64 KB per HTTP read, sixteen database pages at a time. The questions
// this page asks are index scans of a few megabytes, and at 4 KB that
// was thousands of round trips: measured against the live file, the
// opening question took 1,203 ms at 4 KB and 122 ms at 64 KB for the
// same bytes.
const CHUNK_SIZE = 65536;
const MAX_BYTES = 256 * 1024 * 1024;  // per page load, then the worker refuses
const MAX_ROWS = 2000;                // painted, not computed
const QUERY_TIMEOUT_MS = 60_000;
const ROWS_PREVIEW = 8;               // rows shown under a chart before "show all"

const ICON = {
  line: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 17l6-6 4 4 8-8"/></svg>',
  hbar: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h11M4 18h7"/></svg>',
  vbar: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 20v-7M12 20V6M18 20v-10"/></svg>',
  table: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10"/></svg>',
  chev: '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5l3 3 3-3"/></svg>',
  caret: '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 3l3 3-3 3"/></svg>',
  down: '<svg viewBox="0 0 12 12" width="10" height="10" fill="currentColor" aria-hidden="true"><path d="M2 4h8L6 9z"/></svg>',
  sort: '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5l3 3 3-3"/></svg>',
};

// Starting questions. Builder states where the builder can express them,
// plain SQL where it cannot. Clicking one loads it and runs it. The icon
// is the view the answer comes back as.
const TEMPLATES = [
  { name: "New listings per day", icon: "line",
    state: { group: "day", event: "first_seen", range: 30, compare: "previous", metric: "count" } },
  { name: "Open jobs by category", icon: "hbar",
    state: { status: "open", group: "category", metric: "count", limit: 25 } },
  { name: "Seniority spread", icon: "hbar",
    state: { status: "open", group: "seniority", metric: "share", limit: 25 } },
  { name: "Most-asked-for skills", icon: "hbar",
    state: { status: "open", group: "skill", metric: "count", limit: 25 } },
  { name: "Skills asked of senior engineers", icon: "hbar",
    state: { status: "open", group: "skill", metric: "count", limit: 20,
             filters: [{ field: "seniority", values: ["senior"] },
                       { field: "category", values: ["Software Engineering"] }] } },
  { name: "Remote, hybrid, on site or unsaid", icon: "vbar",
    state: { status: "open", group: "workplace", metric: "share", limit: 10 } },
  { name: "Who discloses pay, by ATS", icon: "table", view: "table",
    sql: `SELECT ats,
       COUNT(*) AS listings,
       SUM(salary_source = 'disclosed') AS disclosed,
       ROUND(100.0 * SUM(salary_source = 'disclosed') / COUNT(*), 1) AS pct_disclosed
FROM jobs
WHERE closed_at IS NULL
GROUP BY ats
HAVING listings > 300
ORDER BY pct_disclosed DESC` },
  { name: "Days open before closing, by category", icon: "hbar",
    state: { status: "closed", group: "category", metric: "avg_days_open", limit: 25 } },
  { name: "Companies hiring the most", icon: "table", view: "table",
    sql: `SELECT COALESCE(c.name, j.company) AS company,
       j.ats AS ats,
       COUNT(*) AS open_roles,
       ROUND(100.0 * COALESCE(SUM(j.salary_source = 'disclosed'), 0) / COUNT(*)) AS show_pay_pct
FROM jobs j
LEFT JOIN companies c ON c.domain = j.company
WHERE j.closed_at IS NULL
GROUP BY j.company
ORDER BY open_roles DESC
LIMIT 30` },
];

// The dates are ISO 8601 text, which is how SQLite keeps them. Shown as
// "date" so it is plain what they hold, and the note says how to compare.
const DATE_NOTE = "ISO 8601 text, e.g. 2026-10-03T14:20:00Z. Compare as text: first_seen >= '2026-09-01'.";
const SCHEMA = [
  { table: "jobs", note: "One row per listing, open and closed.",
    columns: [["id", "text", "Stable id for the listing."], ["company", "text", "The company's domain; joins to companies.domain."], ["ats", "text", "Which hiring system it came from."],
      ["title", "text", "As the employer wrote it."], ["category", "text", "Our normalisation, e.g. Software Engineering; NULL when unsure."], ["department", "text", "The employer's own label."],
      ["seniority", "text", "intern, junior, mid, senior, staff, principal, lead, manager, director, exec, or NULL."], ["workplace", "text", "remote, hybrid, onsite, or NULL when unsaid."], ["location", "text", "As written by the employer."],
      ["salary_text", "text", "As shown on the board."], ["salary_source", "text", "disclosed, table, estimated, or NULL."], ["url", "text", "The posting on the employer's site."],
      ["posted_at", "date", "The date the employer gives, when it gives one. " + DATE_NOTE], ["first_seen", "date", "When we first saw the listing. " + DATE_NOTE],
      ["last_seen", "date", "When we last saw it open. " + DATE_NOTE], ["closed_at", "date", "When it closed; NULL while open. " + DATE_NOTE],
      ["days_open", "real", "Closed minus first seen, or its age so far while open."]] },
  { table: "job_skills", note: "One row per skill per listing, with the listing's filter columns copied in.",
    columns: [["job_rowid", "integer", "jobs.rowid of the listing."], ["job_id", "text", "jobs.id of the listing."], ["skill", "text", "Lower-cased, e.g. python."], ["company", "text", ""], ["ats", "text", ""], ["category", "text", ""],
      ["seniority", "text", ""], ["workplace", "text", ""], ["salary_source", "text", ""], ["first_seen", "date", DATE_NOTE], ["closed_at", "date", "NULL while open. " + DATE_NOTE], ["days_open", "real", ""]] },
  { table: "companies", note: "One row per tracked company.", columns: [["domain", "text", "Joins to jobs.company."], ["name", "text", "As the hiring system reports it."], ["ats", "text", ""], ["open_jobs", "integer", "Open listings right now."]] },
  { table: "facets", note: "Distinct values per filter, with counts.", columns: [["field", "text", ""], ["value", "text", ""], ["label", "text", "Companies only."], ["n", "integer", "Open listings."]] },
  { table: "meta", note: "When this file was built, and its totals.", columns: [["key", "text", ""], ["value", "text", ""]] },
];

const LABELS = {
  seniority: { intern: "Intern", junior: "Junior", mid: "Mid", senior: "Senior", staff: "Staff", principal: "Principal", lead: "Lead", manager: "Manager", director: "Director", exec: "Executive", unstated: "Unstated" },
  workplace: { remote: "Remote", hybrid: "Hybrid", onsite: "On site", unstated: "Unsaid" },
  salary_source: { disclosed: "Disclosed by employer", table: "Estimated (Israeli table)", estimated: "Estimated (learned)", none: "None" },
  ats: { greenhouse: "Greenhouse", ashby: "Ashby", smartrecruiters: "SmartRecruiters", workable: "Workable", lever: "Lever", comeet: "Comeet", workday: "Workday", recruitee: "Recruitee", personio: "Personio", teamtailor: "Teamtailor", jazzhr: "JazzHR", pinpoint: "Pinpoint", jsonld: "Career page" },
};
const GROUP_WORDS = { category: "category", seniority: "seniority", workplace: "workplace", ats: "ATS", salary_source: "pay info", company: "company", skill: "skill" };
const LIMITS = [10, 25, 50, 100, 500];

const $ = (id) => document.getElementById(id);
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtInt = (n) => Number(n).toLocaleString("en-US");
const fmtBytes = (b) => (b < 1024 * 1024 ? `${Math.round(b / 1024)} KB` : `${(b / (1024 * 1024)).toFixed(1)} MB`);
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
const fmtNum = (v) => (typeof v !== "number" ? String(v ?? "") : Number.isInteger(v) ? fmtInt(v) : v.toLocaleString("en-US", { maximumFractionDigits: 1 }));

let worker = null;
let running = false;
let rerun = false;
let mode = "builder";
let viz = "auto";                // "auto" until someone picks a view
let state = QB.defaultState();
let pickerValues = {};           // field -> [{value, name, n}], from the database itself
let lastResult = null;           // {columns, values} of the last answer, for the CSV export
let activeTemplate = null;       // which starter question is on screen, if unchanged
let manifest = null;
let chartObserver = null;

// Database.
async function openDatabase() {
  const status = $("explore-status");
  status.textContent = "Opening the database…";
  // Each hourly build is its own file, so the pages this session caches
  // all come from one build, whatever gets published while it is open.
  try {
    const res = await fetch(MANIFEST_URL, { cache: "no-store" });
    manifest = res.ok ? await res.json() : null;
  } catch { manifest = null; }
  const url = manifest?.url || "/explore.db";
  const config = { from: "inline", config: { serverMode: "full", url, requestChunkSize: CHUNK_SIZE } };
  worker = await createDbWorker([config], WORKER_URL, WASM_URL, MAX_BYTES);  // eslint-disable-line no-undef

  const meta = Object.fromEntries((await worker.db.exec("SELECT key, value FROM meta"))[0]?.values || []);
  const built = meta.built_at || manifest?.built_at;
  const parts = [`${fmtInt(meta.jobs || 0)} listings`, `${fmtInt(meta.companies || 0)} companies`];
  if (built) parts.push(`refreshed ${ago(built)}`);
  status.textContent = parts.join(" · ");
  status.title = built ? `Built ${new Date(built).toLocaleString()}` : "";

  // The file itself, for anyone who would rather query it locally.
  const dl = $("st-download");
  if (manifest?.url) {
    dl.href = manifest.url;
    const gb = manifest.bytes ? ` ${(manifest.bytes / 1e9).toFixed(1)} GB` : "";
    dl.textContent = `Download the database (SQLite,${gb})`;
    dl.hidden = false;
  }
}

function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

// Throw the worker away and start another. The old one may still be
// grinding through a query nobody wants; terminating it is the only
// way to stop it, and the new one starts with an empty page cache.
async function reopenDatabase() {
  try { worker?.raw?.terminate(); } catch { /* already gone */ }
  worker = null;
  try { await openDatabase(); } catch (e) { $("explore-status").textContent = "The database could not be reopened. Reload the page."; }
}

// The pickers' options come from the facets table the builder
// precomputes: one small indexed query for everything, not one GROUP BY
// over every row per field. A file built before the table existed falls
// back to the scans, which is slow but correct.
async function loadPickerValues() {
  const nameOf = (field, v, name) => name || (LABELS[field] || {})[v] || v;
  try {
    const r = await worker.db.exec("SELECT field, value, label, n FROM facets ORDER BY field, n DESC");
    const by = {};
    for (const [field, v, name, n] of r[0]?.values || []) (by[field] ||= []).push({ value: v, name: nameOf(field, v, name), n });
    if (Object.keys(by).length) { pickerValues = by; return; }
  } catch { /* no facets table in this build; fall through */ }
  for (const col of ["category", "seniority", "workplace", "ats", "salary_source"]) {
    const r = await worker.db.exec(`SELECT ${col}, COUNT(*) n FROM jobs WHERE closed_at IS NULL AND ${col} IS NOT NULL GROUP BY 1 ORDER BY n DESC`);
    pickerValues[col] = (r[0]?.values || []).map(([v, n]) => ({ value: v, name: nameOf(col, v), n }));
  }
  const sk = await worker.db.exec("SELECT skill, COUNT(*) n FROM job_skills GROUP BY 1 ORDER BY n DESC");
  pickerValues.skill = (sk[0]?.values || []).map(([v, n]) => ({ value: v, name: v, n }));
  const co = await worker.db.exec("SELECT domain, COALESCE(name, domain), open_jobs FROM companies WHERE open_jobs > 0 ORDER BY open_jobs DESC");
  pickerValues.company = (co[0]?.values || []).map(([d, name, n]) => ({ value: d, name, n }));
}

function pickName(field, v) {
  const hit = (pickerValues[field] || []).find((o) => o.value === v);
  return hit ? hit.name : (LABELS[field] || {})[v] || v;
}

// The builder, as a sentence. Every choice is a pill that opens a menu
// in the page's own style (a native select opened the browser's plain
// list); every filter is a tag you can open or remove.
const PILLS = {};   // pill id -> {options, current, label}
function pill(id, options, current, label) {
  PILLS[id] = { options, current: String(current), label };
  const flat = options.flatMap((o) => (o.group ? o.options : [o]));
  const hit = flat.find(([v]) => String(v) === String(current));
  return `<span class="st-pill"><button type="button" class="st-pill-btn" id="${id}" aria-haspopup="listbox" aria-expanded="false" aria-label="${escapeHtml(label)}: ${escapeHtml(hit ? hit[1] : current)}">${escapeHtml(hit ? hit[1] : current)}</button>${ICON.chev}</span>`;
}

const CHECK = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>';

function openPillMenu(btn) {
  const spec = PILLS[btn.id];
  if (!spec) return;
  if (pop && pop.anchor === btn) { closePop(); return; }
  const item = ([v, t]) => {
    const on = String(v) === spec.current;
    return `<button type="button" class="st-menu-item" role="option" aria-selected="${on}" data-v="${escapeHtml(v)}"><span>${escapeHtml(t)}</span>${on ? CHECK : ""}</button>`;
  };
  const html = `<div role="listbox" aria-label="${escapeHtml(spec.label)}">${spec.options.map((o) => (o.group
    ? `<div class="st-menu-group" role="presentation">${escapeHtml(o.group)}</div>${o.options.map(item).join("")}`
    : item(o))).join("")}</div>`;
  const el = openPop(btn, html, "st-menu");
  pop.anchor = btn;
  el.style.minWidth = `${Math.max(180, btn.offsetWidth)}px`;
  btn.setAttribute("aria-expanded", "true");
  const items = [...el.querySelectorAll(".st-menu-item")];
  (items.find((b) => b.getAttribute("aria-selected") === "true") || items[0])?.focus();
  el.addEventListener("keydown", (e) => {
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      items[e.key === "Home" ? 0 : items.length - 1].focus();
    } else if (e.key === "Tab") {
      closePop();
    }
  });
  el.addEventListener("click", (e) => {
    const b = e.target.closest(".st-menu-item");
    if (!b) return;
    closePop();
    applyPill(btn.id, b.dataset.v);
  });
}
const word = (w) => `<span class="st-word">${escapeHtml(w)}</span>`;

function groupOptions() {
  return [
    { group: "Over time", options: [["day", "day"], ["week", "week"], ["month", "month"]] },
    { group: "By", options: Object.entries(GROUP_WORDS) },
    { group: "No grouping", options: [["none", "one by one"]] },
  ];
}

function filterLabel(f) {
  const spec = QB.FIELDS[f.field];
  if (!spec) return f.field;
  if (spec.kind === "pick") {
    const vals = (f.values || []).filter((v) => v !== "" && v != null);
    if (!vals.length) return `${spec.label} is any`;
    const names = vals.map((v) => pickName(f.field, v));
    return `${spec.label} is ${names.length <= 2 ? names.join(" or ") : `${names[0]} +${names.length - 1}`}`;
  }
  if (spec.kind === "text") return (f.text || "").trim() ? `${spec.label} contains "${f.text.trim()}"` : `${spec.label} contains anything`;
  if (f.from && f.to) return `${spec.label} from ${f.from} to ${f.to}`;
  if (f.from) return `${spec.label} since ${f.from}`;
  if (f.to) return `${spec.label} before ${f.to}`;
  return `${spec.label} any time`;
}

function renderBuilder() {
  const g = QB.GROUPS[state.group] || {};
  const time = Boolean(g.time);
  const rows = state.group === "none";
  if (time && state.metric === "share") state.metric = "count";
  const line1 = [];
  if (rows) line1.push(word("List"));
  else {
    const metrics = [["count", "Count"], ...(time ? [] : [["share", "Share of"]]), ["avg_days_open", "Average days open of"]];
    line1.push(pill("qb-metric", metrics, state.metric, "What to measure"));
  }
  line1.push(word("listings"));
  if (time) {
    line1.push(word("that were"), pill("qb-event", Object.entries(QB.EVENTS).map(([k, v]) => [k, v.label]), state.event, "Which date"), word("per"));
  } else {
    line1.push(word("that are"), pill("qb-status", [["open", "open now"], ["closed", "closed"], ["all", "open or closed"]], state.status, "Which listings"));
    if (!rows) line1.push(word("by"));
  }
  line1.push(pill("qb-group", groupOptions(), state.group, "Group by"));
  if (time) {
    line1.push(word("over"), pill("qb-range", [["7", "the last 7 days"], ["30", "the last 30 days"], ["90", "the last 90 days"], ["0", "all time"]], String(state.range), "Time range"));
  } else {
    const limits = LIMITS.includes(Number(state.limit)) ? LIMITS : [...LIMITS, Number(state.limit)].sort((a, b) => a - b);
    line1.push(word(rows ? "newest first, top" : "top"), pill("qb-limit", limits.map((n) => [String(n), String(n)]), String(state.limit), "How many rows"));
  }

  const tags = (state.filters || []).map((f, i) => `<span class="st-tag" data-i="${i}">
      <button type="button" class="st-tag-edit" data-i="${i}" aria-haspopup="dialog">${escapeHtml(filterLabel(f))}</button>
      <button type="button" class="st-tag-x" data-i="${i}" aria-label="Remove filter: ${escapeHtml(filterLabel(f))}">&times;</button>
    </span>`).join("");
  const line2 = [word("where"), tags, `<button type="button" class="st-add" id="qb-add">+ Add filter</button>`];
  if (QB.canCompare(state)) {
    const days = Number(state.range);
    line2.push(`<span class="st-gap"></span>`, word("compare to"),
      pill("qb-compare", [["none", "nothing"], ["previous", `previous ${days} days`]], state.compare, "Compare to"));
  }
  $("qb").innerHTML = `<div class="st-line">${line1.join("")}</div><div class="st-line">${line2.join("")}</div>`;
}

function syncSqlFromBuilder() {
  $("explore-sql").value = QB.buildSql(state);
}

// A builder change: the sentence may change shape (time groups read
// differently), the question is no longer a starter, and it runs. Focus
// goes back to the pill that was changed, which renderBuilder replaced.
function applyPill(id, value) {
  const key = { "qb-metric": "metric", "qb-event": "event", "qb-status": "status", "qb-group": "group", "qb-range": "range", "qb-limit": "limit", "qb-compare": "compare" }[id];
  if (!key || String(state[key]) === String(value)) { $(id)?.focus(); return; }
  state[key] = key === "range" || key === "limit" ? Number(value) : value;
  if (key === "group" && QB.GROUPS[value]?.time && !state.range) state.range = 30;
  clearActiveTemplate();
  renderBuilder();
  $(id)?.focus();
  run();
}

// The filter editors. One popover at a time, anchored under what opened
// it; it applies as you go and runs the query when it closes.
let pop = null;
function closePop() {
  if (!pop) return;
  const { el, changed, onOutside, onKey, anchor } = pop;
  anchor?.setAttribute("aria-expanded", "false");
  el.remove();
  document.removeEventListener("pointerdown", onOutside, true);
  document.removeEventListener("keydown", onKey, true);
  pop = null;
  if (changed) { clearActiveTemplate(); renderBuilder(); run(); }
}
function openPop(anchor, html, extraClass) {
  closePop();
  const el = document.createElement("div");
  el.className = extraClass ? `st-pop ${extraClass}` : "st-pop";
  el.setAttribute("role", "dialog");
  el.innerHTML = html;
  // Inside the page, which defines the colours it is drawn in; positioned
  // against the document either way, since the page itself is static.
  (document.querySelector(".st-page") || document.body).appendChild(el);
  const r = anchor.getBoundingClientRect();
  const width = el.offsetWidth;
  el.style.top = `${r.bottom + window.scrollY + 6}px`;
  el.style.left = `${Math.max(8, Math.min(r.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - width - 8))}px`;
  const onOutside = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closePop(); };
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); closePop(); anchor.focus(); } };
  document.addEventListener("pointerdown", onOutside, true);
  document.addEventListener("keydown", onKey, true);
  pop = { el, changed: false, onOutside, onKey };
  return el;
}

function editFilter(i, anchor) {
  const f = state.filters[i];
  const spec = QB.FIELDS[f.field];
  if (!spec) return;
  if (spec.kind === "pick") {
    const options = pickerValues[f.field] || [];
    const searchable = spec.searchable || options.length > 12;
    const el = openPop(anchor, `<div class="st-pop-title">${escapeHtml(spec.label)} is</div>
      ${searchable ? `<input type="search" class="st-pop-search" placeholder="Filter ${escapeHtml(spec.label.toLowerCase())}…" aria-label="Filter values" />` : ""}
      <div class="st-pop-list" role="group" aria-label="${escapeHtml(spec.label)}"></div>
      <div class="st-pop-foot"><button type="button" class="st-textlink st-pop-clear">Clear</button><button type="button" class="st-btn st-pop-done">Done</button></div>`);
    const list = el.querySelector(".st-pop-list");
    const paint = (q = "") => {
      const want = q.trim().toLowerCase();
      const sel = new Set(f.values || []);
      const shown = (want ? options.filter((o) => o.name.toLowerCase().includes(want)) : options).slice(0, 400);
      list.innerHTML = shown.map((o) => `<label class="st-opt"><input type="checkbox" value="${escapeHtml(o.value)}"${sel.has(o.value) ? " checked" : ""} />
        <span>${escapeHtml(o.name)}</span><span class="st-opt-n">${fmtInt(o.n)}</span></label>`).join("")
        || `<div class="st-pop-empty">${options.length ? "No matches." : "Loading values…"}</div>`;
    };
    paint();
    list.addEventListener("change", (e) => {
      if (!e.target.matches("input[type=checkbox]")) return;
      const sel = new Set(f.values || []);
      e.target.checked ? sel.add(e.target.value) : sel.delete(e.target.value);
      f.values = [...sel];
      pop.changed = true;
      anchor.textContent = filterLabel(f);
    });
    el.querySelector(".st-pop-search")?.addEventListener("input", (e) => paint(e.target.value));
    el.querySelector(".st-pop-clear").addEventListener("click", () => { f.values = []; pop.changed = true; anchor.textContent = filterLabel(f); paint(el.querySelector(".st-pop-search")?.value || ""); });
    el.querySelector(".st-pop-done").addEventListener("click", closePop);
    (el.querySelector(".st-pop-search") || el.querySelector("input"))?.focus();
  } else if (spec.kind === "text") {
    const el = openPop(anchor, `<div class="st-pop-title">${escapeHtml(spec.label)} contains</div>
      <input type="text" class="st-pop-text" value="${escapeHtml(f.text || "")}" placeholder="e.g. ${spec.label === "Title" ? "backend" : "Tel Aviv"}" />
      <div class="st-pop-foot"><button type="button" class="st-btn st-pop-done">Done</button></div>`);
    const input = el.querySelector(".st-pop-text");
    input.addEventListener("input", () => { f.text = input.value; pop.changed = true; anchor.textContent = filterLabel(f); });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); closePop(); } });
    el.querySelector(".st-pop-done").addEventListener("click", closePop);
    input.focus();
  } else {
    const el = openPop(anchor, `<div class="st-pop-title">${escapeHtml(spec.label)} between</div>
      <div class="st-dates"><input type="text" class="st-pop-from" value="${escapeHtml(f.from || "")}" placeholder="from YYYY-MM-DD" aria-label="From" />
      <input type="text" class="st-pop-to" value="${escapeHtml(f.to || "")}" placeholder="to YYYY-MM-DD" aria-label="To" /></div>
      <div class="st-pop-foot"><button type="button" class="st-btn st-pop-done">Done</button></div>`);
    for (const [cls, key] of [[".st-pop-from", "from"], [".st-pop-to", "to"]]) {
      const input = el.querySelector(cls);
      input.addEventListener("input", () => { f[key] = input.value.trim(); pop.changed = true; anchor.textContent = filterLabel(f); });
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); closePop(); } });
    }
    el.querySelector(".st-pop-done").addEventListener("click", closePop);
    el.querySelector(".st-pop-from").focus();
  }
}

function addFilter(anchor) {
  const used = new Set((state.filters || []).map((f) => f.field));
  const fields = Object.entries(QB.FIELDS).filter(([k]) => !used.has(k));
  const el = openPop(anchor, `<div class="st-pop-title">Filter by</div><div class="st-pop-list">${fields.map(([k, v]) =>
    `<button type="button" class="st-opt" data-field="${k}">${escapeHtml(v.label)}</button>`).join("")}</div>`);
  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-field]");
    if (!b) return;
    closePop();
    state.filters.push({ field: b.dataset.field, values: [], text: "", from: "", to: "" });
    clearActiveTemplate();
    renderBuilder();
    const i = state.filters.length - 1;
    const tag = document.querySelector(`.st-tag-edit[data-i="${i}"]`);
    if (tag) { editFilter(i, tag); pop.changed = true; }
  });
  el.querySelector(".st-opt")?.focus();
}

// Switching to SQL normally shows the query the builder wrote. A
// starter query or a shared link brings its own SQL instead; passing it
// here keeps the builder from writing over it.
function setMode(next, sql) {
  mode = next;
  document.querySelectorAll(".seg [data-mode]").forEach((b) => {
    const on = b.dataset.mode === next;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
  $("qb").hidden = next !== "builder";
  $("sqlmode").hidden = next !== "sql";
  $("qb-reset").hidden = next !== "builder";
  $("st-viewsql").hidden = next !== "builder";
  if (next !== "sql") renderBuilder();
  else if (sql != null) $("explore-sql").value = sql;
  else syncSqlFromBuilder();
}

// The views there are. A link's ?v= picks one of these or nothing;
// "auto" is the page choosing, and it is never a button.
const VIZ_KINDS = ["auto", "table", "bar", "line"];

function setViz(next) {
  if (!VIZ_KINDS.includes(next)) next = "auto";
  viz = next;
}

// Which view is on: the one picked, or the one the data is already in.
// A date and a number is a line; a label and a number is bars; anything
// else, or a chart forced onto text, is a table.
function pickViz(columns, rows) {
  const vi = valueColumn(columns, rows);
  if (viz !== "auto") {
    if (viz === "table" || vi < 0) return "table";
    if (viz === "line" && !isTimeAxis(rows)) return "bar";
    return viz;
  }
  if (columns.length < 2 || rows.length < 2 || vi < 0) return "table";
  if (isTimeAxis(rows)) return "line";
  return rows.length <= 60 ? "bar" : "table";
}

function isTimeAxis(rows) {
  return rows.length > 0 && rows.every((r) => /^\d{4}-(\d{2}|W\d{2})(-\d{2})?/.test(String(r[0] ?? "")));
}

// The column a chart draws: the last one that is a number in every row,
// leaving out the comparison. The builder's share metric returns the
// count and the share side by side, and the share, the thing asked for,
// is the last.
function valueColumn(columns, rows) {
  for (let i = columns.length - 1; i >= 1; i--) {
    if (columns[i] === "previous") continue;
    if (rows.every((r) => typeof r[i] === "number")) return i;
  }
  return -1;
}

// Short labels go across the bottom; long ones, or more than eight of
// them, read better as rows.
function barsAreVertical(rows) {
  if (isTimeAxis(rows)) return true;
  const longest = Math.max(0, ...rows.map((r) => String(r[0] ?? "").length));
  return rows.length <= 8 && longest <= 16;
}

// URL state. The builder state when in builder mode, the SQL otherwise,
// so a link reproduces the view either way.
function writeUrl() {
  const p = new URLSearchParams();
  if (mode === "builder") p.set("b", QB.encodeState(state));
  else p.set("q", btoa(unescape(encodeURIComponent($("explore-sql").value))));
  if (viz !== "auto") p.set("v", viz);
  history.replaceState(null, "", `${location.pathname}?${p}`);
}

function readUrl() {
  const p = new URLSearchParams(location.search);
  if (p.get("v")) setViz(p.get("v"));
  if (p.get("b")) {
    const s = QB.decodeState(p.get("b"));
    if (s) { state = Object.assign(QB.defaultState(), s); return "builder"; }
  }
  if (p.get("q")) {
    try { $("explore-sql").value = decodeURIComponent(escape(atob(p.get("q")))); return "sql"; } catch { /* fall through */ }
  }
  return null;
}

function clearActiveTemplate() {
  activeTemplate = null;
  document.querySelectorAll(".st-q.active").forEach((x) => x.classList.remove("active"));
}

// What the answer is called, written from the question.
function resultTitle() {
  if (activeTemplate != null) return TEMPLATES[activeTemplate].name;
  if (mode === "sql") return "Query result";
  const g = QB.GROUPS[state.group] || {};
  if (g.time) {
    const what = state.event === "closed_at" ? "closed listings" : "new listings";
    if (state.metric === "avg_days_open") return `Days open of ${what}, per ${g.time}`;
    return `${what[0].toUpperCase()}${what.slice(1)} per ${g.time}`;
  }
  const who = { open: "Open jobs", closed: "Closed jobs", all: "Jobs" }[state.status] || "Jobs";
  if (state.group === "none") return `Latest ${who.toLowerCase()}`;
  const by = GROUP_WORDS[state.group] || state.group;
  if (state.metric === "share") return `Share of ${who.toLowerCase()} by ${by}`;
  if (state.metric === "avg_days_open") return state.status === "closed" ? `Days open before closing, by ${by}` : `Average days open of ${who.toLowerCase()}, by ${by}`;
  return `${who} by ${by}`;
}

function resultContext() {
  if (mode === "sql") return [];
  const parts = [];
  for (const f of state.filters || []) {
    const spec = QB.FIELDS[f.field];
    if (!spec) continue;
    if (spec.kind === "pick" && (f.values || []).length) parts.push(f.values.map((v) => pickName(f.field, v)).join(" or "));
    else if (spec.kind === "text" && (f.text || "").trim()) parts.push(`${spec.label.toLowerCase()} contains "${f.text.trim()}"`);
    else if (spec.kind === "date" && (f.from || f.to)) parts.push(filterLabel(f).toLowerCase());
  }
  const g = QB.GROUPS[state.group] || {};
  if (g.time) {
    const days = Number(state.range);
    if (!days) parts.push("all time");
    else parts.push(QB.canCompare(state) && state.compare === "previous" ? `last ${days} days vs the ${days} before` : `last ${days} days`);
  }
  return parts;
}

// Running and rendering.
async function run() {
  if (!worker) return;
  // A change made while a query runs is run after it, not dropped, or the
  // chips would show the new filter over the old chart.
  if (running) { rerun = true; return; }
  if (mode === "builder") syncSqlFromBuilder();
  const sql = $("explore-sql").value.trim();
  if (!sql) return;
  running = true;
  const metric = $("explore-metric");
  const err = $("explore-error");
  err.hidden = true;
  metric.textContent = "Running…";
  $("st-rtitle").textContent = resultTitle();
  document.body.classList.add("explore-busy");
  const t0 = performance.now();
  const before = await worker.worker.bytesRead;
  try {
    const result = await Promise.race([
      worker.db.exec(sql),
      new Promise((_, reject) => setTimeout(() => reject(new Error(
        `Still running after ${QUERY_TIMEOUT_MS / 1000}s. Narrow it with a filter or an indexed column.`)), QUERY_TIMEOUT_MS)),
    ]);
    const ms = Math.round(performance.now() - t0);
    const read = (await worker.worker.bytesRead) - before;
    writeUrl();
    render(result, ms, read);
  } catch (e) {
    // A query that timed out is still running inside the worker, and
    // every later query would queue behind it. A read the network
    // dropped leaves the runtime holding a page it should not trust,
    // which SQLite reports as a malformed file. Either way: throw the
    // worker away and open the database again, and say so in words a
    // reader can act on.
    const msg = String(e.message || e);
    const broken = /malformed|XMLHttpRequest|Failed to load/.test(msg);
    const timedOut = /Still running/.test(msg);
    err.textContent = timedOut
      ? `Stopped after ${QUERY_TIMEOUT_MS / 1000} s. Narrow it with a filter or an indexed column; the database has been reopened.`
      : broken ? "The network did not deliver every page this query needed. It has been reopened; run it again, or narrow it with a filter."
      : msg;
    if (timedOut || broken) await reopenDatabase();
    err.hidden = false;
    disconnectChart();
    $("explore-result").innerHTML = "";
    $("st-rtitle").textContent = "The query failed";
    metric.textContent = "";
    lastResult = null;
    $("explore-csv").disabled = true;
  } finally {
    running = false;
    document.body.classList.remove("explore-busy");
    if (rerun) { rerun = false; run(); }
  }
}

function render(result, ms, read) {
  const metric = $("explore-metric");
  const out = $("explore-result");
  disconnectChart();
  $("st-rtitle").textContent = resultTitle();
  const context = resultContext();
  if (!result.length) {
    const why = mode === "builder" ? "No listings match these filters." : "The query returned no rows.";
    out.innerHTML = `<div class="st-empty"><strong>No results</strong><span>${why}</span></div>`;
    metric.textContent = [...context, `0 rows in ${ms} ms`].join(" · ");
    metric.title = `${fmtBytes(read)} fetched`;
    lastResult = null;
    $("explore-csv").disabled = true;
    paintViewToggle(null);
    return;
  }
  const { columns, values } = result[result.length - 1];
  lastResult = { columns, values };
  $("explore-csv").disabled = false;
  const shown = values.slice(0, MAX_ROWS);
  const kind = pickViz(columns, shown);
  metric.textContent = [...context, `${fmtInt(values.length)} row${values.length === 1 ? "" : "s"} in ${fmtInt(ms)} ms`
    + (values.length > MAX_ROWS ? `, showing ${fmtInt(MAX_ROWS)}` : "")].join(" · ");
  metric.title = `${fmtBytes(read)} fetched`;
  paintViewToggle({ columns, rows: shown, kind });

  const data = shape(columns, shown);
  const parts = [];
  if (kind !== "table") parts.push(renderStats(data));
  if (kind === "line" || (kind === "bar" && barsAreVertical(shown))) parts.push(`<div class="st-chart" id="st-chart"></div>`);
  else if (kind === "bar") parts.push(renderBars(columns, shown));
  if (kind === "table") parts.push(`<div class="st-table-wrap" id="st-main-table"></div>`);
  else parts.push(rowsSection(data));
  out.innerHTML = parts.join("");

  if (kind === "table") mountTable($("st-main-table"), data, data.tableRows.length);
  else mountRows(data);
  const chartHost = $("st-chart");
  if (chartHost) {
    const draw = () => (kind === "line" ? drawLine(chartHost, data) : drawColumns(chartHost, data));
    draw();
    let frame = 0;
    chartObserver = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(draw); });
    chartObserver.observe(chartHost);
  }
}

function disconnectChart() {
  if (chartObserver) { chartObserver.disconnect(); chartObserver = null; }
}

// The toggle shows which view is on, and only offers what fits: a line
// needs dates along the bottom, and any chart needs a number to draw.
function paintViewToggle(res) {
  document.querySelectorAll(".st-viewseg [data-viz]").forEach((b) => {
    const k = b.dataset.viz;
    const on = res && res.kind === k;
    b.classList.toggle("active", Boolean(on));
    b.setAttribute("aria-selected", String(Boolean(on)));
    const chartable = res && valueColumn(res.columns, res.rows) >= 0;
    b.disabled = !res || (k !== "table" && !chartable) || (k === "line" && !isTimeAxis(res.rows));
  });
}

// The result in the shapes the views need: which column is the value,
// whether there is a comparison, what kind of time axis, and the rows a
// table shows, with a change column when there is a comparison.
function shape(columns, rows) {
  const vi = valueColumn(columns, rows);
  const pi = columns.indexOf("previous");
  const time = isTimeAxis(rows) ? timeKind(String(rows[0][0])) : null;
  const valueName = vi >= 0 ? columns[vi] : "";
  const isRate = /avg|pct|share|rate|percent/i.test(valueName);
  const tableCols = columns.slice();
  let tableRows = rows.map((r) => r.slice());
  if (pi >= 0 && vi >= 0) {
    tableCols.push("change");
    tableRows = tableRows.map((r) => {
      const cur = r[vi], prev = r[pi];
      r.push(typeof cur === "number" && typeof prev === "number" && prev ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);
      return r;
    });
  }
  return { columns, rows, vi, pi, time, valueName, isRate, tableCols, tableRows,
    days: Number(state.range) || rows.length };
}

function timeKind(v) {
  if (/^\d{4}-W\d{2}/.test(v)) return "week";
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return "day";
  return "month";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function fmtTime(v, kind, long) {
  const s = String(v ?? "");
  if (kind === "week") { const m = s.match(/W(\d{2})/); return m ? `${long ? "Week" : "W"} ${Number(m[1])}` : s; }
  if (kind === "month") { const m = s.match(/^(\d{4})-(\d{2})/); return m ? `${MONTHS[Number(m[2]) - 1]}${long ? ` ${m[1]}` : ""}` : s; }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return s;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const base = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return long ? `${DAYS[d.getUTCDay()]}, ${base}` : base;
}

function groupName(d, v) {
  const map = LABELS[d.columns[0]];
  return v == null ? "NULL" : (map && map[v]) || String(v);
}

function prettyCol(c, data) {
  const known = { listings: "Listings", previous: data && data.days ? `Previous ${data.days} days` : "Previous",
    avg_days_open: "Avg days open", share_pct: "Share %", change: "Change", day: "Day", week: "Week", month: "Month",
    pct_disclosed: "Disclosed %", show_pay_pct: "Show pay %", open_roles: "Open roles", ats: "ATS" };
  if (known[c]) return known[c];
  const s = String(c).replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function fmtValue(v, name) {
  if (v == null) return "—";
  if (typeof v !== "number") return escapeHtml(String(v));
  if (/avg_days|days_open/.test(name)) return `${fmtNum(v)} d`;
  if (/pct|share/.test(name)) return `${fmtNum(v)}%`;
  return fmtNum(v);
}

// The numbers that matter, above the chart.
function renderStats(d) {
  if (d.vi < 0) return "";
  const vals = d.rows.map((r) => r[d.vi]).filter((v) => typeof v === "number");
  if (!vals.length) return "";
  const sum = vals.reduce((a, b) => a + b, 0);
  const label = (r) => (d.time ? fmtTime(r[0], d.time, true) : groupName(d, r[0]));
  let maxI = 0, minI = 0;
  d.rows.forEach((r, i) => { if (r[d.vi] > d.rows[maxI][d.vi]) maxI = i; if (r[d.vi] < d.rows[minI][d.vi]) minI = i; });
  const stats = [];
  const unit = d.time === "week" ? "Weekly" : d.time === "month" ? "Monthly" : "Daily";
  if (d.time && !d.isRate) {
    stats.push({ label: "Total", value: fmtValue(sum, d.valueName), sub: Number(state.range) && mode === "builder" ? `last ${state.range} days` : `${d.rows.length} ${d.time}s` });
    if (d.pi >= 0) {
      const prev = d.rows.reduce((a, r) => a + (typeof r[d.pi] === "number" ? r[d.pi] : 0), 0);
      const since = historyStart();
      if (since && previousStart(d.days) < since) {
        // The record does not reach back that far, so a percentage would
        // compare a full period with a sliver of one.
        stats.push({ label: "Change", value: "—", sub: `history starts ${fmtTime(since, "day")}` });
      } else if (prev) {
        const ch = ((sum - prev) / prev) * 100;
        stats.push({ label: "Change", value: `${ch >= 0 ? "+" : ""}${ch.toFixed(1)}%`, up: ch > 0, sub: `vs previous ${d.days} days` });
      }
    }
    stats.push({ label: `${unit} average`, value: fmtValue(Math.round(sum / vals.length), d.valueName), sub: `over ${vals.length} ${d.time}s` });
    stats.push({ label: `Peak ${d.time}`, value: fmtValue(d.rows[maxI][d.vi], d.valueName), sub: label(d.rows[maxI]) });
  } else if (d.isRate) {
    // A share or an average per group. The mean of shares is just 100
    // over the group count, so groups get their spread instead.
    if (d.time) stats.push({ label: "Average", value: fmtValue(Math.round((sum / vals.length) * 10) / 10, d.valueName), sub: `across ${vals.length} ${d.time}s` });
    stats.push({ label: "Highest", value: fmtValue(d.rows[maxI][d.vi], d.valueName), sub: label(d.rows[maxI]) });
    stats.push({ label: "Lowest", value: fmtValue(d.rows[minI][d.vi], d.valueName), sub: label(d.rows[minI]) });
    if (!d.time) stats.push({ label: "Groups", value: fmtInt(vals.length), sub: `by ${prettyCol(d.columns[0]).toLowerCase()}` });
  } else {
    stats.push({ label: "Total", value: fmtValue(sum, d.valueName), sub: `across ${vals.length} groups` });
    stats.push({ label: "Largest", value: fmtValue(d.rows[maxI][d.vi], d.valueName), sub: label(d.rows[maxI]) });
    stats.push({ label: "Its share", value: sum ? `${((d.rows[maxI][d.vi] / sum) * 100).toFixed(1)}%` : "—", sub: "of the total shown" });
  }
  const legend = d.time && d.pi >= 0
    ? `<div class="st-legend"><span><i></i>Last ${d.days} days</span><span><i class="dash"></i>Previous ${d.days} days</span></div>` : "";
  return `<div class="st-stats">${stats.map((s) => `<div class="st-stat">
      <div class="st-stat-label">${escapeHtml(s.label)}</div>
      <div class="st-stat-value${s.up ? " up" : ""}">${s.value}</div>
      <div class="st-stat-sub" title="${escapeHtml(s.sub)}">${escapeHtml(s.sub)}</div></div>`).join("")}${legend}</div>`;
}

// Where the record begins (loader/build_explore.py's corpus_since), and
// where a comparison's earlier period would have to begin.
function historyStart() {
  const s = manifest?.corpus_since;
  return /^\d{4}-\d{2}-\d{2}/.test(s || "") ? s.slice(0, 10) : null;
}
function previousStart(days) {
  return new Date(Date.now() - 2 * days * 86400000).toISOString().slice(0, 10);
}

// A scale that ends on a round number, ruled in quarters.
function niceMax(m) {
  if (!(m > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(m));
  for (const f of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (f * p >= m * 1.04) return f * p;
  return 10 * p;
}
function axisLabel(v, name) {
  const s = compact.format(v);
  return /avg_days|days_open/.test(name) ? `${s} d` : /pct|share/.test(name) ? `${s}%` : s;
}

let gradSeq = 0;
function gradient(id, top, bottom) {
  return `<linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity="${top}"/><stop offset="1" stop-color="currentColor" stop-opacity="${bottom}"/></linearGradient>`;
}

// The line: the period as an ink line over an ink fill fading down, the
// period before as a dashed grey line, a crosshair and a green dot on
// hover with both values in a tooltip.
function drawLine(host, d) {
  const W = Math.max(280, host.clientWidth), H = 268, L = 46, R = 10, T = 10, B = 26;
  const cur = d.rows.map((r) => (typeof r[d.vi] === "number" ? r[d.vi] : null));
  const prev = d.pi >= 0 ? d.rows.map((r) => (typeof r[d.pi] === "number" ? r[d.pi] : null)) : null;
  const max = niceMax(Math.max(0, ...cur.filter((v) => v != null), ...(prev || []).filter((v) => v != null)));
  const n = cur.length;
  const pw = W - L - R, ph = H - T - B;
  const x = (i) => L + (n > 1 ? (i * pw) / (n - 1) : pw / 2);
  const y = (v) => T + ph - (v / max) * ph;
  const id = `stg${++gradSeq}`;
  const pts = cur.map((v, i) => (v == null ? null : [x(i), y(v)]));
  const linePath = pathOf(pts);
  const firstI = pts.findIndex(Boolean), lastI = pts.length - 1 - [...pts].reverse().findIndex(Boolean);
  const area = firstI >= 0 ? `${linePath} L${x(lastI).toFixed(1)},${(T + ph).toFixed(1)} L${x(firstI).toFixed(1)},${(T + ph).toFixed(1)} Z` : "";
  const prevPath = prev ? pathOf(prev.map((v, i) => (v == null ? null : [x(i), y(v)]))) : "";
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const xIdx = [...new Set([0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * (n - 1))))];
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" style="color:var(--st-ink)" role="img" aria-label="${escapeHtml(prettyCol(d.valueName, d))} over time">
    <defs>${gradient(id, 0.22, 0.02)}</defs>
    ${ticks.map((f) => `<line class="st-grid-line" x1="${L}" x2="${W - R}" y1="${y(max * f).toFixed(1)}" y2="${y(max * f).toFixed(1)}"/>
      <text x="${L - 8}" y="${(y(max * f) + 4).toFixed(1)}" text-anchor="end">${escapeHtml(axisLabel(max * f, d.valueName))}</text>`).join("")}
    ${xIdx.map((i, k) => `<text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="${n === 1 ? "middle" : k === 0 ? "start" : k === xIdx.length - 1 ? "end" : "middle"}">${escapeHtml(fmtTime(d.rows[i][0], d.time))}</text>`).join("")}
    <path d="${area}" fill="url(#${id})"/>
    ${prevPath ? `<path d="${prevPath}" fill="none" style="stroke:var(--st-muted)" stroke-width="1.5" stroke-dasharray="4 4"/>` : ""}
    <path d="${linePath}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <line class="st-guide" x1="0" x2="0" y1="${T}" y2="${T + ph}" visibility="hidden"/>
    <circle class="st-dot" r="4.5" style="fill:var(--green);stroke:var(--st-paper)" stroke-width="2" visibility="hidden"/>
    <rect x="${L}" y="${T}" width="${pw}" height="${ph}" fill="transparent" style="cursor:crosshair"/>
  </svg><div class="st-tip" hidden></div>`;
  const svg = host.querySelector("svg"), guide = svg.querySelector(".st-guide"), dot = svg.querySelector(".st-dot"), tip = host.querySelector(".st-tip");
  const hit = svg.querySelector("rect");
  const show = (e) => {
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - L) / pw) * (n - 1))));
    if (cur[i] == null) return;
    const cx = x(i), cy = y(cur[i]);
    guide.setAttribute("x1", cx); guide.setAttribute("x2", cx); guide.setAttribute("visibility", "visible");
    dot.setAttribute("cx", cx); dot.setAttribute("cy", cy); dot.setAttribute("visibility", "visible");
    tip.innerHTML = `<div class="st-tip-head">${escapeHtml(fmtTime(d.rows[i][0], d.time, true))}</div>
      <div class="st-tip-row"><span>${escapeHtml(prettyCol(d.valueName, d))}</span><b>${fmtValue(cur[i], d.valueName)}</b></div>
      ${prev ? `<div class="st-tip-row"><span>${escapeHtml(prettyCol("previous", d))}</span><b>${fmtValue(prev[i], d.valueName)}</b></div>` : ""}`;
    tip.hidden = false;
    const left = (cx / W) * box.width;
    tip.style.left = `${left + 14 + tip.offsetWidth > box.width ? left - 14 - tip.offsetWidth : left + 14}px`;
    tip.style.top = `${T + 6}px`;
  };
  const hide = () => { guide.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); tip.hidden = true; };
  hit.addEventListener("pointermove", show);
  hit.addEventListener("pointerdown", show);
  hit.addEventListener("pointerleave", hide);
}

function pathOf(pts) {
  let d = "", pen = false;
  for (const p of pts) {
    if (!p) { pen = false; continue; }
    d += `${pen ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)} `;
    pen = true;
  }
  return d.trim();
}

// Columns: gradient bars with a 2px ink cap, for a short category axis
// or time; the hovered one turns green with its value in a tooltip.
function drawColumns(host, d) {
  const W = Math.max(280, host.clientWidth), H = 268, L = 46, R = 10, T = 10, B = 28;
  const vals = d.rows.map((r) => (typeof r[d.vi] === "number" ? r[d.vi] : 0));
  const max = niceMax(Math.max(0, ...vals));
  const n = vals.length, pw = W - L - R, ph = H - T - B;
  const band = pw / n, bw = Math.max(2, Math.min(56, band * 0.62));
  const y = (v) => T + ph - (Math.max(0, v) / max) * ph;
  const id = `stg${++gradSeq}`;
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const maxChars = Math.max(3, Math.floor(band / 6.6));
  const short = (s) => {
    s = String(s ?? "NULL");
    if (s.length <= maxChars) return s;
    const first = s.split(/[\s&/,-]+/)[0];
    return first.length <= maxChars ? first : `${s.slice(0, Math.max(1, maxChars - 1))}…`;
  };
  const labelEvery = d.time ? Math.max(1, Math.ceil(n / 6)) : 1;
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" style="color:var(--st-ink)" role="img" aria-label="${escapeHtml(prettyCol(d.valueName, d))} by ${escapeHtml(prettyCol(d.columns[0]))}">
    <defs>${gradient(id, 0.3, 0.04)}</defs>
    ${ticks.map((f) => `<line class="st-grid-line" x1="${L}" x2="${W - R}" y1="${y(max * f).toFixed(1)}" y2="${y(max * f).toFixed(1)}"/>
      <text x="${L - 8}" y="${(y(max * f) + 4).toFixed(1)}" text-anchor="end">${escapeHtml(axisLabel(max * f, d.valueName))}</text>`).join("")}
    ${vals.map((v, i) => {
      const bx = L + i * band + (band - bw) / 2, by = y(v), bh = T + ph - by;
      const lab = d.time ? (i % labelEvery === 0 ? fmtTime(d.rows[i][0], d.time) : "") : short(groupName(d, d.rows[i][0]));
      return `<g class="st-col-g" data-i="${i}">
        <rect class="st-bar" x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, bh).toFixed(1)}" fill="url(#${id})"/>
        <rect class="st-cap" x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="2" fill="currentColor"/>
        ${lab ? `<text x="${(bx + bw / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${escapeHtml(lab)}</text>` : ""}
        <rect x="${(L + i * band).toFixed(1)}" y="${T}" width="${band.toFixed(1)}" height="${ph}" fill="transparent"/>
      </g>`;
    }).join("")}
  </svg><div class="st-tip" hidden></div>`;
  const svg = host.querySelector("svg"), tip = host.querySelector(".st-tip");
  let hot = null;
  const clear = () => {
    if (hot) { hot.querySelector(".st-bar").setAttribute("fill", `url(#${id})`); hot.querySelector(".st-bar").removeAttribute("style"); hot.querySelector(".st-cap").removeAttribute("style"); }
    hot = null; tip.hidden = true;
  };
  svg.addEventListener("pointermove", (e) => {
    const g = e.target.closest(".st-col-g");
    if (!g) { clear(); return; }
    if (g === hot) return;
    clear();
    hot = g;
    const i = Number(g.dataset.i);
    g.querySelector(".st-bar").setAttribute("style", "fill:var(--green);fill-opacity:0.28");
    g.querySelector(".st-cap").setAttribute("style", "fill:var(--green)");
    const head = d.time ? fmtTime(d.rows[i][0], d.time, true) : groupName(d, d.rows[i][0]);
    tip.innerHTML = `<div class="st-tip-head">${escapeHtml(head)}</div>
      <div class="st-tip-row"><span>${escapeHtml(prettyCol(d.valueName, d))}</span><b>${fmtValue(vals[i], d.valueName)}</b></div>
      ${d.pi >= 0 ? `<div class="st-tip-row"><span>${escapeHtml(prettyCol("previous", d))}</span><b>${fmtValue(d.rows[i][d.pi], d.valueName)}</b></div>` : ""}`;
    tip.hidden = false;
    const box = svg.getBoundingClientRect();
    const cx = ((L + i * band + band / 2) / W) * box.width;
    tip.style.left = `${Math.max(0, Math.min(box.width - tip.offsetWidth, cx - tip.offsetWidth / 2))}px`;
    tip.style.top = `${Math.max(0, (y(vals[i]) / H) * box.height - tip.offsetHeight - 10)}px`;
  });
  svg.addEventListener("pointerleave", clear);
}

// Bars, horizontal: one row per group with its share of the total, for
// long labels or more than eight groups. Text values never reach the
// markup unescaped (a shared ?v=bar link once printed them raw).
function renderBars(columns, rows) {
  const vi = Math.max(1, valueColumn(columns, rows));
  const name = columns[vi];
  const nums = rows.map((r) => (typeof r[vi] === "number" ? r[vi] : 0));
  const max = Math.max(1, ...nums);
  const sum = nums.reduce((a, b) => a + b, 0);
  const share = !/avg|pct|share|rate|percent/i.test(name || "") && sum > 0;
  return `<div class="st-hbars" role="list">${rows.map((r, i) => `
    <div class="st-hrow" role="listitem">
      <div class="st-hname" title="${escapeHtml(r[0])}">${escapeHtml((LABELS[columns[0]] || {})[r[0]] || (r[0] ?? "NULL"))}</div>
      <div><div class="st-hbar" style="width:${((nums[i] / max) * 100).toFixed(2)}%"></div></div>
      <div class="st-hval">${typeof r[vi] === "number" ? fmtValue(r[vi], name) : escapeHtml(String(r[vi] ?? ""))}</div>
      <div class="st-hshare">${share ? `${((nums[i] / sum) * 100).toFixed(1)}%` : ""}</div>
    </div>`).join("")}</div>`;
}

// The rows under a chart: the first few, most recent first for time,
// with the rest a click away. The section folds away entirely.
function rowsSection(d) {
  const n = d.tableRows.length;
  const shown = Math.min(ROWS_PREVIEW, n);
  return `<div class="st-rows" id="st-rows">
    <button type="button" class="st-rows-toggle" aria-expanded="true">${ICON.down}<span>Rows</span><span class="st-count">· showing ${fmtInt(shown)} of ${fmtInt(n)}</span></button>
    <div class="st-rows-body"><div class="st-table-wrap" id="st-rows-table"></div>
    ${n > ROWS_PREVIEW ? `<button type="button" class="st-textlink st-more" id="st-rows-more">Show all ${fmtInt(n)}</button>` : ""}</div>
  </div>`;
}
function mountRows(d) {
  const host = $("st-rows-table");
  if (!host) return;
  let all = false;
  const count = document.querySelector("#st-rows .st-count");
  const paint = () => {
    mountTable(host, d, all ? d.tableRows.length : ROWS_PREVIEW, d.time ? { col: 0, desc: true } : null, false);
    count.textContent = `· showing ${fmtInt(Math.min(all ? d.tableRows.length : ROWS_PREVIEW, d.tableRows.length))} of ${fmtInt(d.tableRows.length)}`;
  };
  paint();
  const more = $("st-rows-more");
  if (more) more.addEventListener("click", () => { all = !all; more.textContent = all ? "Show fewer" : `Show all ${fmtInt(d.tableRows.length)}`; paint(); });
  const sec = $("st-rows");
  sec.querySelector(".st-rows-toggle").addEventListener("click", (e) => {
    const closed = sec.classList.toggle("closed");
    sec.querySelector(".st-rows-body").hidden = closed;
    e.currentTarget.setAttribute("aria-expanded", String(!closed));
  });
}

// The table: every header sorts, the main number gets a light bar inside
// its cell, a change reads green when it went up.
function mountTable(host, d, limit, initialSort, bars = true) {
  let sort = initialSort || null;
  const cols = d.tableCols;
  const numeric = cols.map((_, i) => d.tableRows.length > 0 && d.tableRows.every((r) => r[i] == null || typeof r[i] === "number"));
  const barCol = bars ? d.vi : -1;
  const barMax = barCol >= 0 ? Math.max(1, ...d.tableRows.map((r) => (typeof r[barCol] === "number" ? r[barCol] : 0))) : 1;
  const paint = () => {
    let rows = d.tableRows.slice();
    if (sort) {
      const { col, desc } = sort;
      rows.sort((a, b) => {
        const x = a[col], y = b[col];
        if (x == null) return 1;
        if (y == null) return -1;
        const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
        return desc ? -c : c;
      });
    }
    rows = rows.slice(0, limit);
    const head = cols.map((c, i) => `<th class="${numeric[i] ? "num" : ""}" aria-sort="${sort && sort.col === i ? (sort.desc ? "descending" : "ascending") : "none"}">
      <button type="button" data-col="${i}" class="${sort && sort.col === i ? "sorted" : ""}">${escapeHtml(prettyCol(c, d))}${ICON.sort}</button></th>`).join("");
    const body = rows.map((r) => `<tr>${r.map((v, i) => cell(v, cols[i], i, d, barCol, barMax, numeric[i])).join("")}</tr>`).join("");
    host.innerHTML = `<table class="st-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    host.querySelectorAll("th button").forEach((b) => b.addEventListener("click", () => {
      const col = Number(b.dataset.col);
      sort = sort && sort.col === col ? { col, desc: !sort.desc } : { col, desc: numeric[col] };
      paint();
    }));
    const flipped = sort && sort.col !== undefined ? host.querySelector(`th button[data-col="${sort.col}"] svg`) : null;
    if (flipped && !sort.desc) flipped.style.transform = "rotate(180deg)";
  };
  paint();
}

function cell(v, col, i, d, barCol, barMax, isNum) {
  if (v == null) return `<td class="null${isNum ? " num" : ""}">${col === "change" || col === "previous" ? "—" : "NULL"}</td>`;
  if (col === "change" && typeof v === "number") return `<td class="num${v > 0 ? " up" : ""}">${v > 0 ? "+" : ""}${v.toFixed(1)}%</td>`;
  if (typeof v === "number") {
    const bar = i === barCol && v >= 0 ? ` st-barcell" style="--w:${((v / barMax) * 100).toFixed(1)}%` : "";
    return `<td class="num${bar}">${fmtValue(v, col)}</td>`;
  }
  const s = String(v);
  if (col === "url" && /^https?:\/\//.test(s)) return `<td><a class="link" href="${escapeHtml(s)}" target="_blank" rel="noopener">open</a></td>`;
  if (i === 0 && d.time) return `<td>${escapeHtml(fmtTime(s, d.time, true))}</td>`;
  if (LABELS[col] && LABELS[col][s]) return `<td>${escapeHtml(LABELS[col][s])}</td>`;
  return `<td>${escapeHtml(s)}</td>`;
}

// CSV of the whole last answer, not just the rows on screen. Quotes
// anything with a comma, quote, or newline; NULL becomes an empty cell.
function exportCsv() {
  if (!lastResult) return;
  const q = (v) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [lastResult.columns.map(q).join(",")].concat(lastResult.values.map((r) => r.map(q).join(",")));
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `oceanofjobs-stats-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// The rail: starter questions, each with the view it comes back as.
function renderTemplates() {
  $("explore-templates").innerHTML = TEMPLATES.map((t, i) =>
    `<button type="button" class="st-q" data-i="${i}">${ICON[t.icon] || ICON.table}<span>${escapeHtml(t.name)}</span></button>`).join("");
  $("explore-templates").addEventListener("click", (e) => {
    const b = e.target.closest(".st-q");
    if (!b) return;
    loadTemplate(Number(b.dataset.i));
    run();
  });
}

function loadTemplate(i) {
  const t = TEMPLATES[i];
  closePop();
  document.querySelectorAll(".st-q.active").forEach((x) => x.classList.remove("active"));
  document.querySelector(`.st-q[data-i="${i}"]`)?.classList.add("active");
  setViz(t.view || "auto");
  if (t.state) { state = Object.assign(QB.defaultState(), JSON.parse(JSON.stringify(t.state))); setMode("builder"); }
  else setMode("sql", t.sql);
  activeTemplate = i;
}

// The schema: each column's name and type, its note under the list on
// click. Typing filters columns by name or note across every table.
function renderSchema() {
  $("explore-schema").innerHTML = SCHEMA.map((t, i) => `
    <div class="st-tbl ${i === 0 ? "open" : ""}" data-table="${t.table}">
      <button type="button" class="st-tbl-head" aria-expanded="${i === 0}">${ICON.caret}<span>${t.table}</span><span class="st-n">${t.columns.length} cols</span></button>
      <div class="st-tbl-body" ${i === 0 ? "" : "hidden"}>
        <div class="st-tblnote">${escapeHtml(t.note)}</div>
        ${t.columns.map(([c, ty, n]) => `<button type="button" class="st-col" data-col="${escapeHtml(c)}" data-note="${escapeHtml(n.toLowerCase())}" aria-expanded="false"><span>${c}</span><span class="st-type">${ty}</span></button>`).join("")}
        <div class="st-note" hidden></div>
      </div>
    </div>`).join("");
  $("explore-schema").addEventListener("click", (e) => {
    const head = e.target.closest(".st-tbl-head");
    if (head) {
      const box = head.parentElement;
      const body = box.querySelector(".st-tbl-body");
      const open = body.hidden;
      body.hidden = !open;
      box.classList.toggle("open", open);
      head.setAttribute("aria-expanded", String(open));
      return;
    }
    const col = e.target.closest(".st-col");
    if (!col) return;
    const box = col.closest(".st-tbl");
    const table = SCHEMA.find((t) => t.table === box.dataset.table);
    const spec = table.columns.find(([c]) => c === col.dataset.col);
    const note = box.querySelector(".st-note");
    const was = col.classList.contains("on");
    box.querySelectorAll(".st-col.on").forEach((x) => { x.classList.remove("on"); x.setAttribute("aria-expanded", "false"); });
    if (was) { note.hidden = true; return; }
    col.classList.add("on");
    col.setAttribute("aria-expanded", "true");
    note.innerHTML = `<code>${escapeHtml(spec[0])}</code> · ${escapeHtml(spec[2] || `${spec[1]} column`)}`;
    note.hidden = false;
  });
  $("schema-search").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll(".st-tbl").forEach((box, i) => {
      let hits = 0;
      box.querySelectorAll(".st-col").forEach((c) => {
        const hit = !q || c.dataset.col.includes(q) || c.dataset.note.includes(q) || box.dataset.table.includes(q);
        c.hidden = !hit;
        if (hit) hits++;
      });
      box.hidden = Boolean(q) && hits === 0;
      const open = q ? hits > 0 : i === 0;
      box.querySelector(".st-tbl-body").hidden = !open;
      box.classList.toggle("open", open);
      box.querySelector(".st-tbl-head").setAttribute("aria-expanded", String(open));
    });
  });
}

function wireThemeToggle() {
  const btn = $("theme-toggle");
  // A switch, not a labelled button: the CSS draws the side from
  // :root[data-theme]; the state is all this says.
  const sync = () => { btn.setAttribute("aria-checked", String(document.documentElement.getAttribute("data-theme") === "dark")); };
  sync();
  btn.addEventListener("click", () => {
    const root = document.documentElement;
    const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    if (next === "dark") root.setAttribute("data-theme", "dark"); else root.removeAttribute("data-theme");
    localStorage.setItem("iljobs_theme", next);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", next === "dark" ? "#17181c" : "#f2f0ef");
    sync();
  });
}

async function boot() {
  wireThemeToggle();
  renderTemplates();
  renderSchema();

  document.querySelectorAll(".seg [data-mode]").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.mode === mode) return;
    if (b.dataset.mode === "builder") clearActiveTemplate();
    setMode(b.dataset.mode);
  }));
  document.querySelectorAll(".st-viewseg [data-viz]").forEach((b) => b.addEventListener("click", () => {
    if (b.disabled || b.classList.contains("active")) return;
    setViz(b.dataset.viz);
    if (lastResult) { writeUrl(); render([lastResult], 0, 0); $("explore-metric").textContent = $("explore-metric").textContent.replace(/ in 0 ms/, ""); }
  }));
  $("explore-run").addEventListener("click", run);
  $("explore-csv").addEventListener("click", exportCsv);
  $("st-viewsql").addEventListener("click", () => setMode("sql"));
  $("qb-reset").addEventListener("click", () => { clearActiveTemplate(); state = QB.defaultState(); setViz("auto"); renderBuilder(); run(); });
  $("qb").addEventListener("click", (e) => {
    const x = e.target.closest(".st-tag-x");
    if (x) {
      state.filters.splice(Number(x.dataset.i), 1);
      clearActiveTemplate();
      renderBuilder();
      run();
      return;
    }
    const pillBtn = e.target.closest(".st-pill-btn");
    if (pillBtn) { openPillMenu(pillBtn); return; }
    const edit = e.target.closest(".st-tag-edit");
    if (edit) { editFilter(Number(edit.dataset.i), edit); return; }
    if (e.target.closest("#qb-add")) addFilter(e.target.closest("#qb-add"));
  });
  // On the document, not the textarea, so the shortcut next to Run query
  // works in both modes.
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.key !== "Enter") return;
    e.preventDefault();
    closePop();
    run();
  });
  $("explore-sql").addEventListener("input", clearActiveTemplate);
  $("explore-share").addEventListener("click", async () => {
    writeUrl();
    const label = $("explore-share").querySelector("span");
    try {
      await navigator.clipboard.writeText(location.href);
      label.textContent = "Copied";
      setTimeout(() => { label.textContent = "Copy link"; }, 1500);
    } catch { /* the URL bar already has it */ }
  });

  try {
    await openDatabase();
  } catch (e) {
    $("explore-status").textContent = "The database runtime could not start.";
    $("explore-error").textContent = `${e.message || e}. This page needs WebAssembly and a modern browser.`;
    $("explore-error").hidden = false;
    $("st-rtitle").textContent = "Statistics are unavailable";
    return;
  }

  const fromUrl = readUrl();
  if (fromUrl === "sql") setMode("sql", $("explore-sql").value);
  else if (fromUrl === "builder") setMode("builder");
  else loadTemplate(0);
  // The first answer first. Picker values load behind it.
  await run();
  await loadPickerValues();
  if (mode === "builder" && !pop) renderBuilder();
}

boot();
