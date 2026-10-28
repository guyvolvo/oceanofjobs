// The overview's charts, on Kumo's ECharts wrapper, loaded lazily so ECharts
// only downloads when the overview opens. A canvas can't read CSS
// variables, so colours come from the Kumo tokens on each render (the
// theme toggle re-renders the app).
import * as echarts from "echarts/core";
import { BarChart, LineChart, PieChart } from "echarts/charts";
import { AriaComponent, GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { Chart, ChartPalette, type KumoChartOption } from "@cloudflare/kumo/components/chart";

echarts.use([LineChart, BarChart, PieChart, GridComponent, TooltipComponent, AriaComponent, CanvasRenderer]);

function tokens() {
  const dark = document.documentElement.dataset.mode !== "light";
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    dark,
    text: v("--text-color-kumo-subtle", ChartPalette.text("primary", dark)),
    strong: v("--text-color-kumo-strong", ChartPalette.text("primary", dark)),
    line: v("--color-kumo-hairline", "#888"),
    brand: v("--color-kumo-brand", ChartPalette.categorical(0, dark)),
    overlay: v("--color-kumo-overlay", dark ? "#1b1d22" : "#fff"),
    font: v("--font-sans", "sans-serif"),
  };
}
type T = ReturnType<typeof tokens>;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const day = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString(undefined, { day: "numeric", month: "short" });
const month = (m: string) => new Date(m + "-15T12:00:00Z").toLocaleDateString(undefined, { month: "short", year: "2-digit" });
const tip = (t: T) => ({
  backgroundColor: t.overlay, borderColor: t.line, borderWidth: 1, padding: [6, 10],
  textStyle: { color: t.strong, fontFamily: t.font, fontSize: 12 }, extraCssText: "box-shadow:none;border-radius:8px;",
});
const axisX = (t: T, data: string[], gap = true) => ({ type: "category" as const, data, boundaryGap: gap, axisLine: { lineStyle: { color: t.line } },
  axisTick: { show: false }, axisLabel: { color: t.text, fontFamily: t.font, hideOverlap: true } });
const axisY = (t: T) => ({ type: "value" as const, minInterval: 1, splitNumber: 3, axisLabel: { color: t.text, fontFamily: t.font },
  splitLine: { lineStyle: { color: t.line, type: "dashed" as const } } });
const grid = { left: 4, right: 12, top: 12, bottom: 4, containLabel: true };
const first = (p: unknown) => (Array.isArray(p) ? p[0] : p) as { name: string; value: number; dataIndex: number };

// Sign-ups per day: one bar a day, a day with none at zero.
export function SignupsChart({ days }: { days: [string, number][] }) {
  const t = tokens();
  const options: KumoChartOption = {
    backgroundColor: "transparent", grid,
    aria: { enabled: true, label: { description: `New users per day, last ${days.length} days.` } },
    tooltip: { trigger: "axis", ...tip(t), axisPointer: { type: "shadow" },
      dangerousHtmlFormatter: (p: unknown) => { const x = first(p); return `${esc(day(days[x.dataIndex][0]))}: <b>${x.value}</b>`; } },
    xAxis: axisX(t, days.map(([d]) => day(d))), yAxis: axisY(t),
    series: [{ type: "bar", data: days.map(([, n]) => n), barMaxWidth: 18, itemStyle: { color: t.brand, borderRadius: [3, 3, 0, 0] } }],
  };
  return <Chart echarts={echarts} options={options} height={200} />;
}

// Users in total at the end of each day.
export function GrowthChart({ days }: { days: [string, number][] }) {
  const t = tokens();
  const options: KumoChartOption = {
    backgroundColor: "transparent", grid,
    aria: { enabled: true, label: { description: `Total users over the last ${days.length} days, from ${days[0]?.[1]} to ${days[days.length - 1]?.[1]}.` } },
    tooltip: { trigger: "axis", ...tip(t), axisPointer: { type: "line", lineStyle: { color: t.line } },
      dangerousHtmlFormatter: (p: unknown) => { const x = first(p); return `${esc(day(days[x.dataIndex][0]))}: <b>${x.value}</b> users`; } },
    xAxis: axisX(t, days.map(([d]) => day(d)), false), yAxis: { ...axisY(t), scale: true },
    series: [{ type: "line", data: days.map(([, n]) => n), smooth: 0.3, showSymbol: false, lineStyle: { color: t.brand, width: 2 },
      areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: t.brand + "55" }, { offset: 1, color: t.brand + "00" }]) } }],
  };
  return <Chart echarts={echarts} options={options} height={200} />;
}

// Steps from signing up to paying, as bars with each step's share of sign-ups.
export function FunnelChart({ steps }: { steps: [string, number][] }) {
  const t = tokens();
  const top = Math.max(1, steps[0]?.[1] || 0);
  const rows = [...steps].reverse();
  const options: KumoChartOption = {
    backgroundColor: "transparent", grid: { left: 4, right: 84, top: 4, bottom: 4, containLabel: true },
    aria: { enabled: true, label: { description: steps.map(([s, n]) => `${s}: ${n}`).join(", ") + "." } },
    tooltip: { trigger: "item", ...tip(t), dangerousHtmlFormatter: (p: unknown) => {
      const x = first(p); return `${esc(x.name)}: <b>${x.value}</b> (${Math.round((x.value / top) * 100)}%)`; } },
    xAxis: { type: "value", show: false, max: top },
    yAxis: { type: "category", data: rows.map(([s]) => s), axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: t.text, fontFamily: t.font } },
    series: [{ type: "bar", barMaxWidth: 18, itemStyle: { color: t.brand, borderRadius: [0, 3, 3, 0] },
      label: { show: true, position: "right", color: t.strong, fontFamily: t.font },
      data: rows.map(([, n]) => ({ value: n, label: { formatter: `${n} · ${Math.round((n / top) * 100)}%` } })) }],
  };
  return <Chart echarts={echarts} options={options} height={Math.max(160, steps.length * 34)} />;
}

// A share of the whole, as a ring with the parts named beside it.
export function ShareChart({ parts, name }: { parts: [string, number][]; name: string }) {
  const t = tokens();
  const options: KumoChartOption = {
    backgroundColor: "transparent",
    aria: { enabled: true, label: { description: `${name}: ${parts.map(([k, n]) => `${k} ${n}`).join(", ")}.` } },
    tooltip: { trigger: "item", ...tip(t), dangerousHtmlFormatter: (p: unknown) => {
      const x = p as { name: string; value: number; percent: number }; return `${esc(x.name)}: <b>${x.value}</b> (${Math.round(x.percent)}%)`; } },
    series: [{ type: "pie", radius: ["52%", "78%"], center: ["50%", "50%"], avoidLabelOverlap: true,
      itemStyle: { borderColor: t.overlay, borderWidth: 2 },
      label: { color: t.text, fontFamily: t.font, formatter: "{b}\n{c}" }, labelLine: { lineStyle: { color: t.line } },
      data: parts.map(([k, n], i) => ({ name: k, value: n, itemStyle: { color: ChartPalette.categorical(i, t.dark) } })) }],
  };
  return <Chart echarts={echarts} options={options} height={200} />;
}

// Applications sent per month, from the monthly credit ledgers.
export function AppsChart({ months }: { months: [string, number][] }) {
  const t = tokens();
  const options: KumoChartOption = {
    backgroundColor: "transparent", grid,
    aria: { enabled: true, label: { description: `Applications sent per month: ${months.map(([m, n]) => `${month(m)} ${n}`).join(", ")}.` } },
    tooltip: { trigger: "axis", ...tip(t), axisPointer: { type: "shadow" },
      dangerousHtmlFormatter: (p: unknown) => { const x = first(p); return `${esc(month(months[x.dataIndex][0]))}: <b>${x.value}</b>`; } },
    xAxis: axisX(t, months.map(([m]) => month(m))), yAxis: axisY(t),
    series: [{ type: "bar", data: months.map(([, n]) => n), barMaxWidth: 28, itemStyle: { color: t.brand, borderRadius: [3, 3, 0, 0] } }],
  };
  return <Chart echarts={echarts} options={options} height={200} />;
}
