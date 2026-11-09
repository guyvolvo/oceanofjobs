// The overview's charts, on ECharts. Loaded on its own (Overview imports
// this lazily), so ECharts only downloads when the overview is opened. A
// canvas can't read CSS variables, so the colours are read from the tokens
// (src/styles/tokens.css) each time the theme changes.
import { useEffect, useMemo, useRef } from "react";
import * as echarts from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import { AriaComponent, GridComponent, MarkPointComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { useDark } from "../shell/state";

echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, AriaComponent, MarkPointComponent, CanvasRenderer]);
type Option = echarts.EChartsCoreOption;

function useTokens() {
  const dark = useDark();
  return useMemo(() => {
    const css = getComputedStyle(document.documentElement);
    const v = (name: string) => css.getPropertyValue(name).trim();
    return {
      text: v("--muted-foreground"), strong: v("--foreground"), line: v("--border"), brand: v("--ooj-signal-green"),
      fill: v("--accent"), warn: v("--ooj-trend-down"), overlay: v("--popover"), font: 'Geist, "Helvetica Neue", Arial, sans-serif', dark,
    };
  }, [dark]);
}
type Tokens = ReturnType<typeof useTokens>;

// One chart in a box of the given height, redrawn on a new option and
// resized with its box.
function EChart({ options, height }: { options: Option; height: number }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  useEffect(() => {
    const c = echarts.init(box.current!);
    chart.current = c;
    const watch = new ResizeObserver(() => c.resize());
    watch.observe(box.current!);
    return () => { watch.disconnect(); c.dispose(); chart.current = null; };
  }, []);
  useEffect(() => { chart.current?.setOption(options, true); }, [options]);
  return <div ref={box} style={{ height }} className="w-full" />;
}

// "#2fae60" at a given opacity, for the area under the trend.
const alpha = (hex: string, a: number) => {
  const n = parseInt(hex.replace("#", ""), 16);
  return Number.isNaN(n) ? hex : `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};
const tooltip = (t: Tokens) => ({
  backgroundColor: t.overlay, borderColor: t.line, borderWidth: 1, padding: [6, 10],
  textStyle: { color: t.strong, fontFamily: t.font, fontSize: 12 }, extraCssText: "box-shadow:none;border-radius:8px;",
});
const short = (n: number) => (n >= 1000 ? `${+(n / 1000).toFixed(n % 1000 ? 1 : 0)}k` : String(Math.round(n)));
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

// The weekly trend: an area over up to eight weeks, latest point marked.
export function TrendChart({ labels, values, name }: { labels: string[]; values: number[]; name: string }) {
  const t = useTokens();
  const options = useMemo<Option>(() => ({
    backgroundColor: "transparent",
    aria: { enabled: true, label: { description: `${name}, by week: ${labels.map((l, i) => `${l} ${values[i]}`).join(", ")}.` } },
    grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
    tooltip: { trigger: "axis", ...tooltip(t), axisPointer: { type: "line", lineStyle: { color: t.line } },
      formatter: (p: unknown) => {
        const x = (Array.isArray(p) ? p[0] : p) as { name: string; value: number };
        return `<div style="color:${t.text}">Week to ${esc(x.name)}</div><b>${Number(x.value).toLocaleString()}</b>`;
      } },
    xAxis: { type: "category", data: labels, boundaryGap: false, axisLine: { lineStyle: { color: t.line } }, axisTick: { show: false },
      axisLabel: { color: t.text, fontFamily: t.font, hideOverlap: true } },
    yAxis: { type: "value", minInterval: 1, splitNumber: 4, axisLabel: { color: t.text, fontFamily: t.font, formatter: (n: number) => short(n) },
      splitLine: { lineStyle: { color: t.line, type: "dashed" } } },
    series: [{
      type: "line", name, data: values, smooth: 0.3, symbol: "circle", symbolSize: 6, showSymbol: true,
      lineStyle: { color: t.brand, width: 2 }, itemStyle: { color: t.brand },
      areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: alpha(t.brand, 0.33) }, { offset: 1, color: alpha(t.brand, 0) }]) },
      markPoint: { symbol: "circle", symbolSize: 10, itemStyle: { color: t.brand, borderColor: t.overlay, borderWidth: 2 }, label: { show: false },
        data: [{ name: "latest", coord: [labels.length - 1, values[values.length - 1]] }] },
    }],
  }), [t, labels, values, name]);
  return <EChart options={options} height={300} />;
}

// Pay across the matches' estimates: 13 bins of 5K from 20K, the middle
// half in the brand colour.
export function PayChart({ bins, lo, hi }: { bins: number[]; lo: number; hi: number }) {
  const t = useTokens();
  const label = (i: number) => (i === 0 ? "Under ₪25K" : i === 12 ? "₪80K and up" : `₪${20 + i * 5}K to ₪${25 + i * 5}K`);
  const options = useMemo<Option>(() => ({
    backgroundColor: "transparent",
    grid: { left: 0, right: 0, top: 2, bottom: 0 },
    tooltip: { trigger: "item", ...tooltip(t), formatter: (p: unknown) => {
      const x = p as { dataIndex: number; value: number };
      return `${esc(label(x.dataIndex))}: <b>${x.value}</b>`;
    } },
    xAxis: { type: "category", show: false, data: bins.map((_, i) => i) },
    yAxis: { type: "value", show: false },
    series: [{ type: "bar", barCategoryGap: "20%", data: bins.map((n, i) => {
      const x0 = 20000 + i * 5000;
      const mid = (i === 0 || x0 <= hi) && (i === 12 || x0 + 5000 > lo);
      return { value: n, itemStyle: { color: mid ? t.brand : t.fill, borderRadius: [2, 2, 0, 0] } };
    }) }],
  }), [t, bins, lo, hi]); // eslint-disable-line react-hooks/exhaustive-deps
  return <EChart options={options} height={36} />;
}

// Open jobs per skill: the reader's gaps first in the warning colour,
// then the skills on their profile.
export function DemandChart({ rows }: { rows: { sk: string; n: number; gap: boolean }[] }) {
  const t = useTokens();
  const options = useMemo<Option>(() => ({
    backgroundColor: "transparent",
    aria: { enabled: true, label: { description: `Open jobs per skill: ${rows.map((r) => `${r.sk} ${r.n}${r.gap ? " (not on your profile)" : ""}`).join(", ")}.` } },
    grid: { left: 4, right: 48, top: 0, bottom: 0, containLabel: true },
    tooltip: { trigger: "item", ...tooltip(t), formatter: (p: unknown) => {
      const x = p as { dataIndex: number };
      const r = rows[x.dataIndex];
      return `${esc(r.sk)}: <b>${r.n.toLocaleString()}</b> open jobs${r.gap ? `<div style="color:${t.text}">Not on your profile</div>` : ""}`;
    } },
    xAxis: { type: "value", show: false },
    yAxis: { type: "category", inverse: true, data: rows.map((r) => r.sk), axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: t.text, fontFamily: t.font, width: 110, overflow: "truncate" } },
    series: [{
      type: "bar", barWidth: 10, showBackground: true, backgroundStyle: { color: t.fill, borderRadius: 5 },
      data: rows.map((r) => ({ value: r.n, itemStyle: { color: r.gap ? t.warn : t.brand, borderRadius: 5 } })),
      label: { show: true, position: "right", color: t.strong, fontFamily: t.font, formatter: (p: { value: unknown }) => Number(p.value).toLocaleString() },
    }],
  }), [t, rows]);
  return <EChart options={options} height={rows.length * 30 + 8} />;
}
