// The overview's charts, on Kumo's ECharts wrapper, loaded lazily so ECharts
// only downloads when the overview opens. A canvas can't read CSS
// variables, so colours come from the Kumo tokens on each render (the
// theme toggle re-renders the app).
import * as echarts from "echarts/core";
import { BarChart, LineChart, PieChart } from "echarts/charts";
import { AriaComponent, GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { Chart, ChartLegend, ChartPalette, type KumoChartOption } from "@cloudflare/kumo/components/chart";

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
    success: v("--color-kumo-success", ChartPalette.semantic("Success", dark)),
    warning: v("--color-kumo-warning", ChartPalette.semantic("Warning", dark)),
    danger: v("--color-kumo-danger", ChartPalette.semantic("Attention", dark)),
    info: ChartPalette.categorical(0, dark),
  };
}
type T = ReturnType<typeof tokens>;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
// A bucket is an hour ("2026-10-28T09") or a day ("2026-10-28").
const at = (b: string) => (b.length > 10 ? new Date(b + ":00:00Z").toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  : new Date(b + "T12:00:00Z").toLocaleDateString(undefined, { day: "numeric", month: "short" }));
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
export function SignupsChart({ buckets: days }: { buckets: [string, number][] }) {
  const t = tokens();
  const options: KumoChartOption = {
    backgroundColor: "transparent", grid,
    aria: { enabled: true, label: { description: "Sign-ups." } },
    tooltip: { trigger: "axis", ...tip(t), axisPointer: { type: "shadow" },
      dangerousHtmlFormatter: (p: unknown) => { const x = first(p); return `${esc(at(days[x.dataIndex][0]))}: <b>${x.value}</b>`; } },
    xAxis: axisX(t, days.map(([d]) => at(d))), yAxis: axisY(t),
    series: [{ type: "bar", data: days.map(([, n]) => n), barMaxWidth: 18, itemStyle: { color: t.brand, borderRadius: [3, 3, 0, 0] } }],
  };
  return <Chart echarts={echarts} options={options} height={200} />;
}

// Users in total at the end of each day.
export function GrowthChart({ buckets: days }: { buckets: [string, number][] }) {
  const t = tokens();
  const options: KumoChartOption = {
    backgroundColor: "transparent", grid,
    aria: { enabled: true, label: { description: `Total users, from ${days[0]?.[1]} to ${days[days.length - 1]?.[1]}.` } },
    tooltip: { trigger: "axis", ...tip(t), axisPointer: { type: "line", lineStyle: { color: t.line } },
      dangerousHtmlFormatter: (p: unknown) => { const x = first(p); return `${esc(at(days[x.dataIndex][0]))}: <b>${x.value}</b>`; } },
    xAxis: axisX(t, days.map(([d]) => at(d)), false), yAxis: { ...axisY(t), scale: true },
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

// Application outcomes, kept apart: [label, confirmed, unconfirmed, sent by the user, failed].
type Split = [string, number, number, number, number];
const OUTCOMES = ["Confirmed", "Unconfirmed", "Sent by user, not confirmed", "Failed"];
const colours = (t: T) => [t.success, t.warning, t.info, t.danger];
const val = (r: Split, i: number) => r[i + 1] as number;

function Legend({ rows }: { rows: Split[] }) {
  const t = tokens();
  return (
    <div className="crm-legend">
      {OUTCOMES.map((name, i) => <ChartLegend.SmallItem key={name} name={name} color={colours(t)[i]}
        value={rows.reduce((n, r) => n + val(r, i), 0).toLocaleString()} />)}
    </div>
  );
}

const splitTip = (title: string, r: Split) => `${esc(title)}<br>` + OUTCOMES.map((name, i) => `${name}: <b>${val(r, i)}</b>`).join("<br>");

// Outcomes per hour or day, stacked.
export function OutcomesChart({ buckets }: { buckets: Split[] }) {
  const t = tokens();
  const options: KumoChartOption = {
    backgroundColor: "transparent", grid,
    aria: { enabled: true, label: { description: "Applications by outcome." } },
    tooltip: { trigger: "axis", ...tip(t), axisPointer: { type: "shadow" },
      dangerousHtmlFormatter: (p: unknown) => { const r = buckets[first(p).dataIndex]; return splitTip(at(r[0]), r); } },
    xAxis: axisX(t, buckets.map(([b]) => at(b))), yAxis: axisY(t),
    series: OUTCOMES.map((name, i) => ({ type: "bar" as const, name, stack: "all", data: buckets.map((r) => val(r, i)), barMaxWidth: 18,
      itemStyle: { color: colours(t)[i] } })),
  };
  return <><Legend rows={buckets} /><Chart echarts={echarts} options={options} height={200} /></>;
}

// Outcomes per hiring system, stacked across.
export function SystemsChart({ systems }: { systems: Split[] }) {
  const t = tokens();
  const rows = [...systems].reverse();
  const options: KumoChartOption = {
    backgroundColor: "transparent", grid: { ...grid, right: 16 },
    aria: { enabled: true, label: { description: systems.map((r) => `${r[0]}: ${OUTCOMES.map((n, i) => `${n} ${val(r, i)}`).join(", ")}`).join("; ") + "." } },
    tooltip: { trigger: "axis", ...tip(t), axisPointer: { type: "shadow" },
      dangerousHtmlFormatter: (p: unknown) => { const r = rows[first(p).dataIndex]; return splitTip(r[0], r); } },
    xAxis: { ...axisY(t), splitLine: { show: false } },
    yAxis: { type: "category", data: rows.map(([n]) => n), axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: t.text, fontFamily: t.font } },
    series: OUTCOMES.map((name, i) => ({ type: "bar" as const, name, stack: "all", data: rows.map((r) => val(r, i)), barMaxWidth: 18,
      itemStyle: { color: colours(t)[i] } })),
  };
  return <><Legend rows={systems} /><Chart echarts={echarts} options={options} height={Math.max(120, systems.length * 34)} /></>;
}
