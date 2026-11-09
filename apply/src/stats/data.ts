// The Statistics page's fixed content (starter questions, the schema,
// value labels) and the pure functions over an answer: which view fits,
// which column is the value, the numbers above the chart, the title. No
// DOM and no React here; the components draw what these return.
export type Cell = string | number | null;
export type Mode = "builder" | "sql";
export type Viz = "auto" | "table" | "bar" | "line";
export const VIZ_KINDS: Viz[] = ["auto", "table", "bar", "line"];
export type PickOpt = { value: string; name: string; n: number };
export type Picks = Record<string, PickOpt[]>;
export type Manifest = { url?: string; built_at?: string; corpus_since?: string } | null;
// The question on screen: the builder state in builder mode, the SQL
// otherwise, the view picked (auto until someone picks), and which
// starter question it still is, if unchanged.
export type Question = { mode: Mode; qb: QbState; sql: string; viz: Viz; template: number | null };

export const MAX_ROWS = 2000;              // painted, not computed
export const ROWS_PREVIEW = 8;             // rows shown under a chart before "show all"
export const QUERY_TIMEOUT_MS = 60_000;

export type Template = { name: string; icon: "line" | "hbar" | "vbar" | "table"; view?: Viz; state?: Partial<QbState>; sql?: string };
// Builder states where the builder can express them, plain SQL where it
// cannot. The icon is the view the answer comes back as.
export const TEMPLATES: Template[] = [
  { name: "New jobs per day", icon: "line", state: { group: "day", event: "first_seen", range: 30, compare: "previous", metric: "count" } },
  { name: "Open jobs by category", icon: "hbar", state: { status: "open", group: "category", metric: "count", limit: 25 } },
  { name: "Seniority spread", icon: "hbar", state: { status: "open", group: "seniority", metric: "share", limit: 25 } },
  { name: "Most-asked-for skills", icon: "hbar", state: { status: "open", group: "skill", metric: "count", limit: 25 } },
  { name: "Skills asked of senior engineers", icon: "hbar",
    state: { status: "open", group: "skill", metric: "count", limit: 20,
      filters: [{ field: "seniority", values: ["senior"] }, { field: "category", values: ["Software Engineering"] }] } },
  { name: "Remote, hybrid, on site or unsaid", icon: "vbar", state: { status: "open", group: "workplace", metric: "share", limit: 10 } },
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
  { name: "Days open before closing, by category", icon: "hbar", state: { status: "closed", group: "category", metric: "avg_days_open", limit: 25 } },
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

const DATE_NOTE = "ISO 8601 text, e.g. 2026-10-03T14:20:00Z. Compare as text: first_seen >= '2026-09-01'.";
export type SchemaTable = { table: string; note: string; columns: [string, string, string][] };
export const SCHEMA: SchemaTable[] = [
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
  { table: "companies", note: "One row per tracked company.", columns: [["domain", "text", "Joins to jobs.company."], ["name", "text", "As the hiring system reports it."], ["ats", "text", ""], ["open_jobs", "integer", "Open jobs right now."]] },
  { table: "facets", note: "Distinct values per filter, with counts.", columns: [["field", "text", ""], ["value", "text", ""], ["label", "text", "Companies only."], ["n", "integer", "Open jobs."]] },
  { table: "meta", note: "When this file was built, and its totals.", columns: [["key", "text", ""], ["value", "text", ""]] },
];

export const LABELS: Record<string, Record<string, string>> = {
  seniority: { intern: "Intern", junior: "Junior", mid: "Mid", senior: "Senior", staff: "Staff", principal: "Principal", lead: "Lead", manager: "Manager", director: "Director", exec: "Executive", unstated: "Unstated" },
  workplace: { remote: "Remote", hybrid: "Hybrid", onsite: "On site", unstated: "Unsaid" },
  salary_source: { disclosed: "Disclosed by employer", table: "Estimated (Israeli table)", estimated: "Estimated (learned)", none: "None" },
  ats: { greenhouse: "Greenhouse", ashby: "Ashby", smartrecruiters: "SmartRecruiters", workable: "Workable", lever: "Lever", comeet: "Comeet", workday: "Workday", recruitee: "Recruitee", personio: "Personio", teamtailor: "Teamtailor", jazzhr: "JazzHR", pinpoint: "Pinpoint", jsonld: "Career page" },
};
export const GROUP_WORDS: Record<string, string> = { category: "category", seniority: "seniority", workplace: "workplace", ats: "ATS", salary_source: "pay info", company: "company", skill: "skill" };
export const LIMITS = [10, 25, 50, 100, 500];

export const fmtInt = (n: number | string) => Number(n).toLocaleString("en-US");
export const fmtBytes = (b: number) => (b < 1024 * 1024 ? `${Math.round(b / 1024)} KB` : `${(b / (1024 * 1024)).toFixed(1)} MB`);
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
export const fmtNum = (v: Cell) => (typeof v !== "number" ? String(v ?? "") : Number.isInteger(v) ? fmtInt(v) : v.toLocaleString("en-US", { maximumFractionDigits: 1 }));
export function fmtValue(v: Cell, name: string): string {
  if (v == null) return "";
  if (typeof v !== "number") return String(v);
  if (/avg_days|days_open/.test(name)) return `${fmtNum(v)} d`;
  if (/pct|share/.test(name)) return `${fmtNum(v)}%`;
  return fmtNum(v);
}
export function axisLabel(v: number, name: string) {
  const s = compact.format(v);
  return /avg_days|days_open/.test(name) ? `${s} d` : /pct|share/.test(name) ? `${s}%` : s;
}

export function ago(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export type TimeKind = "day" | "week" | "month";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function fmtTime(v: Cell, kind: TimeKind, long = false) {
  const s = String(v ?? "");
  if (kind === "week") { const m = s.match(/W(\d{2})/); return m ? `${long ? "Week" : "W"} ${Number(m[1])}` : s; }
  if (kind === "month") { const m = s.match(/^(\d{4})-(\d{2})/); return m ? `${MONTHS[Number(m[2]) - 1]}${long ? ` ${m[1]}` : ""}` : s; }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return s;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const base = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return long ? `${DAYS[d.getUTCDay()]}, ${base}` : base;
}
export function timeKind(v: string): TimeKind {
  if (/^\d{4}-W\d{2}/.test(v)) return "week";
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return "day";
  return "month";
}
export const isTimeAxis = (rows: Cell[][]) => rows.length > 0 && rows.every((r) => /^\d{4}-(\d{2}|W\d{2})(-\d{2})?/.test(String(r[0] ?? "")));

// The column a chart draws: the last one that is a number in every row,
// leaving out the comparison. The builder's share metric returns the
// count and the share side by side, and the share is the last.
export function valueColumn(columns: string[], rows: Cell[][]) {
  for (let i = columns.length - 1; i >= 1; i--) {
    if (columns[i] === "previous") continue;
    if (rows.every((r) => typeof r[i] === "number")) return i;
  }
  return -1;
}

// Which view is on: the one picked, or the one the data is already in.
// A date and a number is a line; a label and a number is bars; anything
// else, or a chart forced onto text, is a table.
export function pickViz(viz: Viz, columns: string[], rows: Cell[][]): Exclude<Viz, "auto"> {
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

// Short labels go across the bottom; long ones, or more than eight of
// them, read better as rows.
export function barsAreVertical(rows: Cell[][]) {
  if (isTimeAxis(rows)) return true;
  const longest = Math.max(0, ...rows.map((r) => String(r[0] ?? "").length));
  return rows.length <= 8 && longest <= 16;
}

// The result in the shapes the views need: which column is the value,
// whether there is a comparison, what kind of time axis, and the rows a
// table shows, with a change column when there is a comparison.
export type Shaped = {
  columns: string[]; rows: Cell[][]; vi: number; pi: number; time: TimeKind | null; valueName: string; isRate: boolean;
  tableCols: string[]; tableRows: Cell[][]; days: number;
};
export function shape(columns: string[], rows: Cell[][], range: number): Shaped {
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
  return { columns, rows, vi, pi, time, valueName, isRate, tableCols, tableRows, days: range || rows.length };
}

export function groupName(d: Shaped, v: Cell) {
  const map = LABELS[d.columns[0]];
  return v == null ? "Unknown" : (map && map[String(v)]) || String(v);
}

export function prettyCol(c: string, d?: Shaped) {
  const known: Record<string, string> = { listings: "Jobs", previous: d && d.days ? `Previous ${d.days} days` : "Previous",
    avg_days_open: "Avg days open", share_pct: "Share %", change: "Change", day: "Day", week: "Week", month: "Month",
    pct_disclosed: "Disclosed %", show_pay_pct: "Show pay %", open_roles: "Open jobs", ats: "ATS" };
  if (known[c]) return known[c];
  const s = String(c).replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Where the record begins (loader/build_explore.py's corpus_since), and
// where a comparison's earlier period would have to begin.
export function historyStart(manifest: Manifest) {
  const s = manifest?.corpus_since;
  return /^\d{4}-\d{2}-\d{2}/.test(s || "") ? String(s).slice(0, 10) : null;
}
export const previousStart = (days: number) => new Date(Date.now() - 2 * days * 86400000).toISOString().slice(0, 10);

// The numbers that matter, above the chart.
export type Stat = { label: string; value: string; sub: string; up?: boolean };
export function statsOf(d: Shaped, q: Question, manifest: Manifest): Stat[] {
  if (d.vi < 0) return [];
  const vals = d.rows.map((r) => r[d.vi]).filter((v): v is number => typeof v === "number");
  if (!vals.length) return [];
  const sum = vals.reduce((a, b) => a + b, 0);
  const num = (r: Cell[]) => (typeof r[d.vi] === "number" ? (r[d.vi] as number) : 0);
  const label = (r: Cell[]) => (d.time ? fmtTime(r[0], d.time, true) : groupName(d, r[0]));
  let maxI = 0, minI = 0;
  d.rows.forEach((r, i) => { if (num(r) > num(d.rows[maxI])) maxI = i; if (num(r) < num(d.rows[minI])) minI = i; });
  const stats: Stat[] = [];
  const unit = d.time === "week" ? "Weekly" : d.time === "month" ? "Monthly" : "Daily";
  if (d.time && !d.isRate) {
    stats.push({ label: "Total", value: fmtValue(sum, d.valueName), sub: Number(q.qb.range) && q.mode === "builder" ? `last ${q.qb.range} days` : `${d.rows.length} ${d.time}s` });
    if (d.pi >= 0) {
      const prev = d.rows.reduce((a, r) => a + (typeof r[d.pi] === "number" ? (r[d.pi] as number) : 0), 0);
      const since = historyStart(manifest);
      if (since && previousStart(d.days) < since) {
        // The record does not reach back that far, so a percentage would
        // compare a full period with a sliver of one.
        stats.push({ label: "Change", value: "n/a", sub: `history starts ${fmtTime(since, "day")}` });
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
    stats.push({ label: "Its share", value: sum ? `${((num(d.rows[maxI]) / sum) * 100).toFixed(1)}%` : "n/a", sub: "of the total shown" });
  }
  return stats;
}

// What a filter tag says.
export function filterLabel(f: QbFilter, pickName: (field: string, v: string) => string) {
  const spec = QB.FIELDS[f.field];
  if (!spec) return f.field;
  if (spec.kind === "pick") {
    const vals = (f.values || []).filter((v) => v !== "" && v != null);
    if (!vals.length) return `${spec.label} is any`;
    const names = vals.map((v) => pickName(f.field, v));
    return `${spec.label} is ${names.length <= 2 ? names.join(" or ") : `${names[0]} +${names.length - 1}`}`;
  }
  if (spec.kind === "text") return (f.text || "").trim() ? `${spec.label} contains "${f.text!.trim()}"` : `${spec.label} contains anything`;
  if (f.from && f.to) return `${spec.label} from ${f.from} to ${f.to}`;
  if (f.from) return `${spec.label} since ${f.from}`;
  if (f.to) return `${spec.label} before ${f.to}`;
  return `${spec.label} any time`;
}

// What the answer is called, written from the question.
export function resultTitle(q: Question) {
  if (q.template != null) return TEMPLATES[q.template].name;
  if (q.mode === "sql") return "Query result";
  const st = q.qb;
  const g = QB.GROUPS[st.group] || {};
  if (g.time) {
    const what = st.event === "closed_at" ? "closed jobs" : "new jobs";
    if (st.metric === "avg_days_open") return `Days open of ${what}, per ${g.time}`;
    return `${what[0].toUpperCase()}${what.slice(1)} per ${g.time}`;
  }
  const who = ({ open: "Open jobs", closed: "Closed jobs", all: "Jobs" } as Record<string, string>)[st.status] || "Jobs";
  if (st.group === "none") return `Latest ${who.toLowerCase()}`;
  const by = GROUP_WORDS[st.group] || st.group;
  if (st.metric === "share") return `Share of ${who.toLowerCase()} by ${by}`;
  if (st.metric === "avg_days_open") return st.status === "closed" ? `Days open before closing, by ${by}` : `Average days open of ${who.toLowerCase()}, by ${by}`;
  return `${who} by ${by}`;
}

export function resultContext(q: Question, pickName: (field: string, v: string) => string) {
  if (q.mode === "sql") return [];
  const st = q.qb;
  const parts: string[] = [];
  for (const f of st.filters || []) {
    const spec = QB.FIELDS[f.field];
    if (!spec) continue;
    if (spec.kind === "pick" && (f.values || []).length) parts.push(f.values!.map((v) => pickName(f.field, v)).join(" or "));
    else if (spec.kind === "text" && (f.text || "").trim()) parts.push(`${spec.label.toLowerCase()} contains "${f.text!.trim()}"`);
    else if (spec.kind === "date" && (f.from || f.to)) parts.push(filterLabel(f, pickName).toLowerCase());
  }
  const g = QB.GROUPS[st.group] || {};
  if (g.time) {
    const days = Number(st.range);
    if (!days) parts.push("all time");
    else parts.push(QB.canCompare(st) && st.compare === "previous" ? `last ${days} days vs the ${days} before` : `last ${days} days`);
  }
  return parts;
}

// CSV of the whole answer. Quotes anything with a comma, quote, or
// newline; NULL becomes an empty cell.
export function csvOf(columns: string[], values: Cell[][]) {
  const q = (v: Cell) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + [columns.map(q).join(",")].concat(values.map((r) => r.map(q).join(","))).join("\r\n");
}
