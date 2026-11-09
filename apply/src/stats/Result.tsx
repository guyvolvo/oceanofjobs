// The answer's views: the numbers above the chart, the chart itself, the
// rows under it, and the table. Every header sorts, the main number gets
// a light bar inside its cell, a change reads green when it went up.
import { useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Collapsible } from "@cloudflare/kumo/components/collapsible";
import { Table } from "@cloudflare/kumo/components/table";
import { CaretDown } from "@phosphor-icons/react";
import { ColumnChart, HBarChart, LineChart } from "./Charts";
import { barsAreVertical, fmtInt, fmtTime, fmtValue, LABELS, prettyCol, ROWS_PREVIEW, statsOf, type Cell, type Manifest, type Question, type Shaped, type Viz } from "./data";

export function ResultBody({ d, kind, q, manifest }: { d: Shaped; kind: Exclude<Viz, "auto">; q: Question; manifest: Manifest }) {
  if (kind === "table") return <ResultTable d={d} limit={d.tableRows.length} />;
  return (
    <>
      <StatsRow d={d} q={q} manifest={manifest} />
      {kind === "line" ? <LineChart d={d} /> : barsAreVertical(d.rows) ? <ColumnChart d={d} /> : <HBarChart d={d} />}
      <RowsSection d={d} />
    </>
  );
}

function StatsRow({ d, q, manifest }: { d: Shaped; q: Question; manifest: Manifest }) {
  const stats = statsOf(d, q, manifest);
  if (!stats.length) return null;
  return (
    <div className="mb-4 flex flex-col gap-2">
      <div className="flex flex-wrap gap-px border border-kumo-hairline bg-kumo-hairline">
        {stats.map((s) => (
          <div key={s.label} className="min-w-0 flex-1 basis-[140px] bg-kumo-base px-3 py-2.5">
            <div className="text-xs text-kumo-subtle">{s.label}</div>
            <div className={`font-display text-[26px] leading-tight tracking-tight tabular-nums ${s.up ? "text-kumo-success" : "text-kumo-strong"}`}>{s.value}</div>
            <div className="truncate text-xs text-kumo-subtle" title={s.sub}>{s.sub}</div>
          </div>
        ))}
      </div>
      {d.time && d.pi >= 0 ? (
        <div className="flex gap-4 text-xs text-kumo-subtle">
          <span className="inline-flex items-center gap-1.5"><i className="inline-block w-4 border-t-2 border-kumo-contrast" aria-hidden="true" />Last {d.days} days</span>
          <span className="inline-flex items-center gap-1.5"><i className="inline-block w-4 border-t-2 border-dashed border-kumo-line" aria-hidden="true" />Previous {d.days} days</span>
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
    <Collapsible.Root open={open} onOpenChange={setOpen} className="mt-4 border-t border-kumo-hairline pt-2">
      <Collapsible.Trigger className="inline-flex items-center gap-1.5 rounded px-1 py-1 text-sm font-medium text-kumo-strong hover:bg-kumo-tint">
        <CaretDown size={11} className={`transition-transform ${open ? "" : "-rotate-90"}`} aria-hidden="true" />
        Rows
        <span className="font-normal text-kumo-subtle">· showing {fmtInt(shown)} of {fmtInt(n)}</span>
      </Collapsible.Trigger>
      <Collapsible.Panel>
        <ResultTable d={d} limit={shown} initialSort={d.time ? { col: 0, desc: true } : null} bars={false} />
        {n > ROWS_PREVIEW ? <Button variant="ghost" size="sm" className="mt-1" onClick={() => setAll((a) => !a)}>{all ? "Show fewer" : `Show all ${fmtInt(n)}`}</Button> : null}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

type Sort = { col: number; desc: boolean };

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
    <div className="overflow-x-auto">
      <Table>
        <Table.Header>
          <Table.Row>
            {cols.map((c, i) => {
              const on = sort?.col === i;
              return (
                <Table.Head key={c} aria-sort={on ? (sort!.desc ? "descending" : "ascending") : "none"} className={numeric[i] ? "text-right" : ""}>
                  <button type="button" onClick={() => click(i)} className={`inline-flex items-center gap-1 whitespace-nowrap ${on ? "text-kumo-strong" : ""}`}>
                    {prettyCol(c, d)}
                    <CaretDown size={10} aria-hidden="true" className={on ? (sort!.desc ? "" : "rotate-180") : "opacity-40"} />
                  </button>
                </Table.Head>
              );
            })}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {rows.map((r, ri) => (
            <Table.Row key={ri}>
              {r.map((v, i) => <TableCell key={i} v={v} col={cols[i]} i={i} d={d} isNum={numeric[i]} bar={i === barCol ? barMax : 0} />)}
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </div>
  );
}

function TableCell({ v, col, i, d, isNum, bar }: { v: Cell; col: string; i: number; d: Shaped; isNum: boolean; bar: number }) {
  const num = `tabular-nums ${isNum ? "text-right" : ""}`;
  if (v == null) return <Table.Cell className={`${num} text-kumo-inactive`}>{col === "change" || col === "previous" ? "" : "Unknown"}</Table.Cell>;
  if (col === "change" && typeof v === "number") return <Table.Cell className={`${num} ${v > 0 ? "text-kumo-success" : ""}`}>{v > 0 ? "+" : ""}{v.toFixed(1)}%</Table.Cell>;
  if (typeof v === "number") {
    const w = bar && v >= 0 ? `${((v / bar) * 100).toFixed(1)}%` : null;
    return (
      <Table.Cell className={num} style={w ? { backgroundImage: `linear-gradient(90deg, var(--color-kumo-tint) ${w}, transparent ${w})` } : undefined}>
        {fmtValue(v, col)}
      </Table.Cell>
    );
  }
  const s = String(v);
  if (col === "url" && /^https?:\/\//.test(s)) return <Table.Cell><a className="text-kumo-link underline" href={s} target="_blank" rel="noopener">open</a></Table.Cell>;
  if (i === 0 && d.time) return <Table.Cell className="whitespace-nowrap">{fmtTime(s, d.time, true)}</Table.Cell>;
  return <Table.Cell>{(LABELS[col] && LABELS[col][s]) || s}</Table.Cell>;
}
