// The three charts, on Kumo's ECharts wrapper, in one chart language: an
// ink line or bar over an ink fill fading down, hairline gridlines, green
// only on what is hovered. A canvas cannot read CSS variables, so the
// colours come from the Kumo tokens each time the theme changes.
import { useMemo } from "react";
import * as echarts from "echarts/core";
import { BarChart, LineChart as EcLine } from "echarts/charts";
import type { BarSeriesOption, LineSeriesOption } from "echarts/charts";
import { AriaComponent, GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { Chart, type KumoChartOption } from "@cloudflare/kumo/components/chart";
import { useTheme } from "../site/theme";
import { axisLabel, fmtTime, fmtValue, groupName, prettyCol, type Shaped } from "./data";

echarts.use([EcLine, BarChart, GridComponent, TooltipComponent, AriaComponent, CanvasRenderer]);

function useTokens() {
  const [dark] = useTheme();
  return useMemo(() => {
    const css = getComputedStyle(document.documentElement);
    const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    return {
      ink: v("--text-color-kumo-strong", "#2c3a28"), text: v("--text-color-kumo-subtle", "#5d6a58"), muted: v("--text-color-kumo-inactive", "#9aa396"),
      line: v("--color-kumo-hairline", "#d9d5d0"), green: v("--color-kumo-brand", "#3f6f45"), overlay: v("--color-kumo-overlay", "#f8f7f6"),
      paper: v("--color-kumo-base", "#fdfcfb"), font: v("--font-sans", "sans-serif"),
    };
  }, [dark]);
}
type Tokens = ReturnType<typeof useTokens>;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const tooltip = (t: Tokens) => ({
  backgroundColor: t.overlay, borderColor: t.line, borderWidth: 1, padding: [6, 10],
  textStyle: { color: t.ink, fontFamily: t.font, fontSize: 12 }, extraCssText: "box-shadow:none;border-radius:6px;",
});
const tipHead = (t: Tokens, s: string) => `<div style="color:${t.text};margin-bottom:2px">${esc(s)}</div>`;
const tipRow = (label: string, value: string) => `<div style="display:flex;justify-content:space-between;gap:16px"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
const axisText = (t: Tokens) => ({ color: t.text, fontFamily: t.font, fontSize: 11 });
const valueAxis = (t: Tokens, name: string) => ({
  type: "value" as const, min: 0, splitNumber: 4, axisLabel: { ...axisText(t), formatter: (n: number) => axisLabel(n, name) },
  splitLine: { lineStyle: { color: t.line } },
});
// The ink fill under a line or inside a bar, fading down.
const fade = (ink: string, top: string, bottom: string) =>
  new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: ink + top }, { offset: 1, color: ink + bottom }]);

// The period as an ink line over its fill, the period before dashed in
// grey, a green dot on the hovered point with both values in the tooltip.
export function LineChart({ d }: { d: Shaped }) {
  const t = useTokens();
  const cur = d.rows.map((r) => (typeof r[d.vi] === "number" ? (r[d.vi] as number) : null));
  const prev = d.pi >= 0 ? d.rows.map((r) => (typeof r[d.pi] === "number" ? (r[d.pi] as number) : null)) : null;
  const series: LineSeriesOption[] = [];
  if (prev) series.push({ type: "line", name: "previous", data: prev, showSymbol: false, symbol: "circle", symbolSize: 7,
    lineStyle: { color: t.muted, width: 1.5, type: "dashed" }, itemStyle: { color: t.muted, borderColor: t.paper, borderWidth: 2 }, z: 1 });
  series.push({ type: "line", name: d.valueName, data: cur, showSymbol: false, symbol: "circle", symbolSize: 9,
    lineStyle: { color: t.ink, width: 2 }, itemStyle: { color: t.green, borderColor: t.paper, borderWidth: 2 },
    areaStyle: { color: fade(t.ink, "38", "05") }, z: 2 });
  const options: KumoChartOption = {
    backgroundColor: "transparent", animation: false,
    aria: { enabled: true, label: { description: `${prettyCol(d.valueName, d)} over time` } },
    grid: { left: 8, right: 12, top: 12, bottom: 4, containLabel: true },
    tooltip: { trigger: "axis", ...tooltip(t), axisPointer: { type: "line", lineStyle: { color: t.line } },
      dangerousHtmlFormatter: (p: unknown) => {
        const i = ((Array.isArray(p) ? p[0] : p) as { dataIndex: number }).dataIndex;
        return tipHead(t, fmtTime(d.rows[i][0], d.time!, true)) + tipRow(prettyCol(d.valueName, d), fmtValue(cur[i], d.valueName))
          + (prev ? tipRow(prettyCol("previous", d), fmtValue(prev[i], d.valueName)) : "");
      } },
    xAxis: { type: "category", data: d.rows.map((r) => fmtTime(r[0], d.time!)), boundaryGap: false, axisLine: { lineStyle: { color: t.line } },
      axisTick: { show: false }, axisLabel: { ...axisText(t), hideOverlap: true } },
    yAxis: valueAxis(t, d.valueName),
    series,
  };
  return <Chart echarts={echarts} options={options} height={268} optionUpdateBehavior={{ notMerge: true }} />;
}

// Columns, for a short category axis or time; the hovered one turns green.
export function ColumnChart({ d }: { d: Shaped }) {
  const t = useTokens();
  const vals = d.rows.map((r) => (typeof r[d.vi] === "number" ? (r[d.vi] as number) : 0));
  const head = (i: number) => (d.time ? fmtTime(d.rows[i][0], d.time, true) : groupName(d, d.rows[i][0]));
  const series: BarSeriesOption[] = [{ type: "bar", data: vals, barMaxWidth: 56, barCategoryGap: "38%",
    itemStyle: { color: fade(t.ink, "4d", "0a"), borderColor: t.ink, borderWidth: 1 },
    emphasis: { itemStyle: { color: t.green + "47", borderColor: t.green } } }];
  const options: KumoChartOption = {
    backgroundColor: "transparent", animation: false,
    aria: { enabled: true, label: { description: `${prettyCol(d.valueName, d)} by ${prettyCol(d.columns[0])}` } },
    grid: { left: 8, right: 12, top: 12, bottom: 4, containLabel: true },
    tooltip: { trigger: "item", ...tooltip(t), dangerousHtmlFormatter: (p: unknown) => {
      const i = (p as { dataIndex: number }).dataIndex;
      return tipHead(t, head(i)) + tipRow(prettyCol(d.valueName, d), fmtValue(vals[i], d.valueName))
        + (d.pi >= 0 ? tipRow(prettyCol("previous", d), fmtValue(d.rows[i][d.pi], d.valueName)) : "");
    } },
    xAxis: { type: "category", data: d.rows.map((r, i) => (d.time ? fmtTime(r[0], d.time) : head(i))), axisLine: { lineStyle: { color: t.line } },
      axisTick: { show: false }, axisLabel: { ...axisText(t), hideOverlap: true, interval: d.time ? "auto" : 0, overflow: "truncate", width: d.time ? undefined : 96 } },
    yAxis: valueAxis(t, d.valueName),
    series,
  };
  return <Chart echarts={echarts} options={options} height={268} optionUpdateBehavior={{ notMerge: true }} />;
}

// Bars, horizontal: one row per group with its value and its share of
// the total, for long labels or more than eight groups.
export function HBarChart({ d }: { d: Shaped }) {
  const t = useTokens();
  const vi = Math.max(1, d.vi);
  const name = d.columns[vi];
  const nums = d.rows.map((r) => (typeof r[vi] === "number" ? (r[vi] as number) : 0));
  const sum = nums.reduce((a, b) => a + b, 0);
  const share = !/avg|pct|share|rate|percent/i.test(name || "") && sum > 0;
  const text = (i: number) => fmtValue(nums[i], name) + (share ? `   ${((nums[i] / sum) * 100).toFixed(1)}%` : "");
  const series: BarSeriesOption[] = [{ type: "bar", data: nums, barWidth: 12, itemStyle: { color: t.ink + "33" }, emphasis: { itemStyle: { color: t.green + "66" } },
    label: { show: true, position: "right", color: t.ink, fontFamily: t.font, fontSize: 12, formatter: (p) => text(p.dataIndex) } }];
  const options: KumoChartOption = {
    backgroundColor: "transparent", animation: false,
    aria: { enabled: true, label: { description: `${prettyCol(name, d)} by ${prettyCol(d.columns[0])}` } },
    grid: { left: 4, right: 110, top: 2, bottom: 2, containLabel: true },
    tooltip: { trigger: "item", ...tooltip(t), dangerousHtmlFormatter: (p: unknown) => {
      const i = (p as { dataIndex: number }).dataIndex;
      return tipHead(t, groupName(d, d.rows[i][0])) + tipRow(prettyCol(name, d), text(i));
    } },
    xAxis: { type: "value", show: false },
    yAxis: { type: "category", inverse: true, data: d.rows.map((r) => groupName(d, r[0])), axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { ...axisText(t), color: t.ink, fontSize: 12, width: 170, overflow: "truncate" } },
    series,
  };
  return <Chart echarts={echarts} options={options} height={d.rows.length * 28 + 8} optionUpdateBehavior={{ notMerge: true }} />;
}
