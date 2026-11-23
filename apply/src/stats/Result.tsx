// The answer's views: the numbers above the chart, the chart itself, the
// rows under it, and the table. Every header sorts, the main number gets
// a light bar inside its cell, a change reads green when it went up.
import { lazy, Suspense, useState } from "react";
import { CaretDown } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { barsAreVertical, fmtInt, fmtTime, fmtValue, LABELS, prettyCol, ROWS_PREVIEW, statsOf, type Cell, type Manifest, type Question, type Shaped, type Viz } from "./data";

// ECharts arrives with the first chart, not with the page.
const LineChart = lazy(() => import("./Charts").then((m) => ({ default: m.LineChart })));
const ColumnChart = lazy(() => import("./Charts").then((m) => ({ default: m.ColumnChart })));
const HBarChart = lazy(() => import("./Charts").then((m) => ({ default: m.HBarChart })));

export function ResultBody({ d, kind, q, manifest }: { d: Shaped; kind: Exclude<Viz, "auto">; q: Question; manifest: Manifest }) {
  if (kind === "table") return <ResultTable d={d} limit={d.tableRows.length} />;
  const vertical = kind === "line" || barsAreVertical(d.rows);
  // The chart's own height is held while ECharts loads, so the rows under it don't jump.
  const height = vertical ? 268 : d.rows.length * 28 + 8;
  return (
    <>
      <StatsRow d={d} q={q} manifest={manifest} />
      <Suspense fallback={<div style={{ height }} />}>
        {kind === "line" ? <LineChart d={d} /> : vertical ? <ColumnChart d={d} /> : <HBarChart d={d} />}
      </Suspense>
      <RowsSection d={d} />
    </>
  );
}

function StatsRow({ d, q, manifest }: { d: Shaped; q: Question; manifest: Manifest }) {
  const stats = statsOf(d, q, manifest);
  if (!stats.length) return null;
  return (
    <div className="mb-[18px] grid grid-cols-2 gap-x-4 gap-y-3.5 sm:flex sm:flex-wrap sm:items-start sm:gap-0">
      {stats.map((s) => (
        <div key={s.label} className="min-w-0 sm:border-l sm:px-6 sm:first:border-l-0 sm:first:pl-0">
          <div className="text-[12.5px] text-muted-foreground">{s.label}</div>
          <div className={cn("font-display text-[22px] leading-tight whitespace-nowrap tabular-nums sm:text-[26px]", s.up && "text-link-hover")}>{s.value}</div>
          <div className="max-w-[220px] truncate text-xs text-muted-foreground" title={s.sub}>{s.sub}</div>
        </div>
      ))}
      {d.time && d.pi >= 0 ? (
        <div className="col-span-full flex items-center gap-4 self-center text-[12.5px] sm:ml-auto">
          <span className="inline-flex items-center gap-[7px] whitespace-nowrap"><i className="inline-block w-3.5 border-t-2 border-foreground" aria-hidden="true" />Last {d.days} days</span>
          <span className="inline-flex items-center gap-[7px] whitespace-nowrap"><i className="inline-block w-3.5 border-t-[1.5px] border-dashed border-dim" aria-hidden="true" />Previous {d.days} days</span>
        </div>
      ) : null}
    </div>
  );
}

// The rows under a chart: the first few, most recent first for time,
// with the rest a click away. The section folds away entirely.
function RowsSection({ d }: { d: Shaped }) {
  const [open, setOpen] = useState(true);
  const [all, setAll] = useState(false);
  const n = d.tableRows.length;
  const shown = Math.min(all ? n : ROWS_PREVIEW, n);
  return (
    <div className="mt-[18px] border-t pt-3">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
        className="inline-flex cursor-pointer items-center gap-1.5 rounded-xs font-ui text-[13px] font-bold">
        <CaretDown size={10} weight="fill" className={cn("transition-transform", !open && "-rotate-90")} aria-hidden="true" />
        Rows
        <span className="font-normal text-muted-foreground">· showing {fmtInt(shown)} of {fmtInt(n)}</span>
      </button>
      <div hidden={!open}>
        <ResultTable d={d} limit={shown} initialSort={d.time ? { col: 0, desc: true } : null} bars={false} />
        {n > ROWS_PREVIEW ? (
          <button type="button" className="mt-2.5 cursor-pointer rounded-xs text-sm underline underline-offset-[3px]" onClick={() => setAll((a) => !a)}>
            {all ? "Show fewer" : `Show all ${fmtInt(n)}`}
          </button>
        ) : null}
      </div>
    </div>
  );
}

type Sort = { col: number; desc: boolean };
const TD = "border-b px-3 py-[9px] align-top";

export function ResultTable({ d, limit, initialSort = null, bars = true }: { d: Shaped; limit: number; initialSort?: Sort | null; bars?: boolean }) {
  const [sort, setSort] = useState<Sort | null>(initialSort);
  const cols = d.tableCols;
  const numeric = cols.map((_, i) => d.tableRows.length > 0 && d.tableRows.every((r) => r[i] == null || typeof r[i] === "number"));
  const barCol = bars ? d.vi : -1;
  const barMax = barCol >= 0 ? Math.max(1, ...d.tableRows.map((r) => (typeof r[barCol] === "number" ? (r[barCol] as number) : 0))) : 1;
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
  const click = (col: number) => setSort(sort && sort.col === col ? { col, desc: !sort.desc } : { col, desc: numeric[col] });
  return (
    <div className="mt-2.5 overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            {cols.map((c, i) => {
              const on = sort?.col === i;
              return (
                <th key={c} aria-sort={on ? (sort!.desc ? "descending" : "ascending") : "none"}
                  className={cn("border-b border-input/25 px-3 py-2.5 font-ui text-[13px] font-bold whitespace-nowrap", numeric[i] ? "text-right" : "text-left")}>
                  <button type="button" onClick={() => click(i)} className="inline-flex cursor-pointer items-center gap-1 rounded-xs">
                    {prettyCol(c, d)}
                    <CaretDown size={10} aria-hidden="true" className={on ? (sort!.desc ? "" : "rotate-180") : "opacity-35"} />
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="hover:bg-secondary">
              {r.map((v, i) => <TableCell key={i} v={v} col={cols[i]} i={i} d={d} isNum={numeric[i]} bar={i === barCol ? barMax : 0} />)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TableCell({ v, col, i, d, isNum, bar }: { v: Cell; col: string; i: number; d: Shaped; isNum: boolean; bar: number }) {
  const num = cn(TD, isNum && "text-right tabular-nums whitespace-nowrap", i === 0 && "whitespace-nowrap");
  if (v == null) return <td className={cn(num, "text-muted-foreground")}>{col === "change" || col === "previous" ? "" : "Unknown"}</td>;
  if (col === "change" && typeof v === "number") return <td className={cn(num, v > 0 && "text-link-hover")}>{v > 0 ? "+" : ""}{v.toFixed(1)}%</td>;
  if (typeof v === "number") {
    const w = bar && v >= 0 ? `${((v / bar) * 100).toFixed(1)}%` : null;
    return (
      <td className={num} style={w ? { backgroundImage: `linear-gradient(to left, var(--secondary) ${w}, transparent ${w})`, backgroundClip: "content-box" } : undefined}>
        {fmtValue(v, col)}
      </td>
    );
  }
  const s = String(v);
  if (col === "url" && /^https?:\/\//.test(s)) return <td className={num}><a className="underline underline-offset-[3px] hover:text-link-hover" href={s} target="_blank" rel="noopener">open</a></td>;
  if (i === 0 && d.time) return <td className={num}>{fmtTime(s, d.time, true)}</td>;
  return <td className={num}>{(LABELS[col] && LABELS[col][s]) || s}</td>;
}
