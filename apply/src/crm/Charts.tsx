// The overview's charts, on shadcn's chart (Recharts), loaded lazily so
// Recharts only downloads when the overview opens. Colours are the
// --chart-* tokens in crm.css, so the theme toggle repaints them.
// Every series sets isAnimationActive: Recharts' "auto" skips the
// animation when the OS asks for reduced motion.
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, LabelList, Pie, PieChart, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";

// A bucket is an hour ("2026-10-28T09") or a day ("2026-10-28").
const at = (b: string) => (b.length > 10 ? new Date(b + ":00:00Z").toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  : new Date(b + "T12:00:00Z").toLocaleDateString(undefined, { day: "numeric", month: "short" }));
const BOX = "aspect-auto w-full";
const axis = { tickLine: false, axisLine: false, tickMargin: 8 } as const;
const tip = <ChartTooltip isAnimationActive cursor={{ fill: "var(--muted)" }} content={<ChartTooltipContent className="min-w-52" />} />;

// Sign-ups per day: one bar a day, a day with none at zero.
export function SignupsChart({ buckets: days }: { buckets: [string, number][] }) {
  const config = { n: { label: "Sign-ups", color: "var(--chart-brand)" } } satisfies ChartConfig;
  const data = days.map(([d, n]) => ({ at: at(d), n }));
  return (
    <ChartContainer config={config} className={`${BOX} h-[200px]`} role="img" aria-label="Sign-ups.">
      <BarChart data={data} margin={{ left: -16, right: 4, top: 8 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="at" {...axis} minTickGap={16} />
        <YAxis {...axis} allowDecimals={false} tickCount={4} />
        {tip}
        <Bar dataKey="n" fill="var(--color-n)" radius={[3, 3, 0, 0]} maxBarSize={18} isAnimationActive />
      </BarChart>
    </ChartContainer>
  );
}

// Users in total at the end of each day.
export function GrowthChart({ buckets: days, label = "Users" }: { buckets: [string, number][]; label?: string }) {
  const config = { n: { label, color: "var(--chart-brand)" } } satisfies ChartConfig;
  const data = days.map(([d, n]) => ({ at: at(d), n }));
  return (
    <ChartContainer config={config} className={`${BOX} h-[200px]`} role="img"
      aria-label={`${label === "Users" ? "Total users" : label}, from ${days[0]?.[1]} to ${days[days.length - 1]?.[1]}.`}>
      <AreaChart data={data} margin={{ left: -16, right: 4, top: 8 }}>
        <defs>
          <linearGradient id="crm-growth" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-n)" stopOpacity={0.35} />
            <stop offset="100%" stopColor="var(--color-n)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="at" {...axis} minTickGap={16} />
        <YAxis {...axis} allowDecimals={false} tickCount={4} domain={["auto", "auto"]} />
        <ChartTooltip isAnimationActive cursor={{ stroke: "var(--border)" }} content={<ChartTooltipContent indicator="line" />} />
        <Area dataKey="n" type="monotone" stroke="var(--color-n)" strokeWidth={2} fill="url(#crm-growth)" isAnimationActive />
      </AreaChart>
    </ChartContainer>
  );
}

// Steps from signing up to paying, as bars with each step's share of sign-ups.
export function FunnelChart({ steps }: { steps: [string, number][] }) {
  const top = Math.max(1, steps[0]?.[1] || 0);
  const pct = (n: number) => Math.round((n / top) * 100);
  const config = { n: { label: "Users", color: "var(--chart-brand)" } } satisfies ChartConfig;
  const data = steps.map(([step, n]) => ({ step, n, text: `${n} · ${pct(n)}%` }));
  return (
    <ChartContainer config={config} className={BOX} style={{ height: Math.max(160, steps.length * 34) }} role="img"
      aria-label={steps.map(([s, n]) => `${s}: ${n}`).join(", ") + "."}>
      <BarChart data={data} layout="vertical" margin={{ left: 0, right: 72, top: 0, bottom: 0 }}>
        <XAxis type="number" hide domain={[0, top]} />
        <YAxis type="category" dataKey="step" {...axis} width={130} />
        <ChartTooltip isAnimationActive cursor={{ fill: "var(--muted)" }}
          content={<ChartTooltipContent hideIndicator formatter={(v, _n, item) => (
            <span className="flex w-full justify-between gap-3"><span className="text-muted-foreground">{item.payload.step}</span>
              <span className="font-mono font-medium text-foreground tabular-nums">{Number(v)} ({pct(Number(v))}%)</span></span>)} hideLabel />} />
        <Bar dataKey="n" fill="var(--color-n)" radius={[0, 3, 3, 0]} maxBarSize={18} isAnimationActive>
          <LabelList dataKey="text" position="right" className="fill-foreground" fontSize={12} />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

// A share of the whole, as a ring with the parts named beside it.
export function ShareChart({ parts, name }: { parts: [string, number][]; name: string }) {
  const total = parts.reduce((n, [, v]) => n + v, 0) || 1;
  const config = Object.fromEntries(parts.map(([k], i) => [`p${i}`, { label: k, color: `var(--chart-${(i % 5) + 1})` }])) satisfies ChartConfig;
  const data = parts.map(([k, n], i) => ({ part: k, key: `p${i}`, n, fill: `var(--color-p${i})` }));
  return (
    <ChartContainer config={config} className={`${BOX} h-[200px]`} role="img" aria-label={`${name}: ${parts.map(([k, n]) => `${k} ${n}`).join(", ")}.`}>
      <PieChart>
        <ChartTooltip isAnimationActive content={<ChartTooltipContent nameKey="key" hideLabel
          formatter={(v, _n, item) => (
            <span className="flex w-full items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-muted-foreground"><i className="size-2.5 rounded-[2px]" style={{ background: item.payload.fill }} />{item.payload.part}</span>
              <span className="font-mono font-medium text-foreground tabular-nums">{Number(v)} ({Math.round((Number(v) / total) * 100)}%)</span>
            </span>)} />} />
        <Pie data={data} dataKey="n" nameKey="key" innerRadius="52%" outerRadius="78%" stroke="var(--card)" strokeWidth={2} isAnimationActive
          label={({ x, y, textAnchor, payload }) => (
            <text x={x} y={y} textAnchor={textAnchor} dominantBaseline="central" className="fill-muted-foreground text-xs">{`${payload.part} ${payload.n}`}</text>)}
          labelLine={{ stroke: "var(--border)" }}>
          {data.map((d) => <Cell key={d.key} fill={d.fill} />)}
        </Pie>
      </PieChart>
    </ChartContainer>
  );
}

// Application outcomes, kept apart: [label, confirmed, unconfirmed, sent by the user, failed].
type Split = [string, number, number, number, number];
const OUTCOMES = { confirmed: "Confirmed", unconfirmed: "Unconfirmed", sent: "Sent by user, not confirmed", failed: "Failed" };
const KEYS = Object.keys(OUTCOMES) as (keyof typeof OUTCOMES)[];
const COLOURS = { confirmed: "var(--chart-success)", unconfirmed: "var(--chart-warning)", sent: "var(--chart-info)", failed: "var(--chart-danger)" };
const SPLIT = Object.fromEntries(KEYS.map((k) => [k, { label: OUTCOMES[k], color: COLOURS[k] }])) satisfies ChartConfig;
const rowsOf = (splits: Split[], label: (s: string) => string) =>
  splits.map(([b, confirmed, unconfirmed, sent, failed]) => ({ at: label(b), confirmed, unconfirmed, sent, failed }));

function Legend({ rows }: { rows: Split[] }) {
  return (
    <div className="crm-legend">
      {KEYS.map((k, i) => <span key={k}><i style={{ background: COLOURS[k] }} />{OUTCOMES[k]} <b>{rows.reduce((n, r) => n + (r[i + 1] as number), 0).toLocaleString()}</b></span>)}
    </div>
  );
}

const bars = (horizontal: boolean) => KEYS.map((k, i) => (
  <Bar key={k} dataKey={k} stackId="all" fill={`var(--color-${k})`} maxBarSize={18} isAnimationActive
    radius={i === KEYS.length - 1 ? (horizontal ? [0, 3, 3, 0] : [3, 3, 0, 0]) : 0} />
));

// Outcomes per hour or day, stacked.
export function OutcomesChart({ buckets }: { buckets: Split[] }) {
  return (
    <>
      <Legend rows={buckets} />
      <ChartContainer config={SPLIT} className={`${BOX} h-[200px]`} role="img" aria-label="Applications by outcome.">
        <BarChart data={rowsOf(buckets, at)} margin={{ left: -16, right: 4, top: 8 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis dataKey="at" {...axis} minTickGap={16} />
          <YAxis {...axis} allowDecimals={false} tickCount={4} />
          {tip}
          {bars(false)}
        </BarChart>
      </ChartContainer>
    </>
  );
}

// Outcomes per hiring system, stacked across.
export function SystemsChart({ systems }: { systems: Split[] }) {
  return (
    <>
      <Legend rows={systems} />
      <ChartContainer config={SPLIT} className={BOX} style={{ height: Math.max(120, systems.length * 34) }} role="img"
        aria-label={systems.map((r) => `${r[0]}: ${KEYS.map((k, i) => `${OUTCOMES[k]} ${r[i + 1]}`).join(", ")}`).join("; ") + "."}>
        <BarChart data={rowsOf(systems, (s) => s)} layout="vertical" margin={{ left: 0, right: 16, top: 0, bottom: 0 }}>
          <XAxis type="number" {...axis} allowDecimals={false} tickCount={4} />
          <YAxis type="category" dataKey="at" {...axis} width={130} />
          {tip}
          {bars(true)}
        </BarChart>
      </ChartContainer>
    </>
  );
}

// One bar group per day for the Usage page: each series side by side, in
// the colours its config names.
export function DailyChart({ rows, series }: { rows: Record<string, number | string>[]; series: Record<string, [string, string]> }) {
  const config = Object.fromEntries(Object.entries(series).map(([k, [label, color]]) => [k, { label, color }])) satisfies ChartConfig;
  const data = rows.map((r) => ({ ...r, at: at(String(r.date)) }));
  return (
    <ChartContainer config={config} className={`${BOX} h-[220px]`} role="img" aria-label={Object.values(series).map(([l]) => l).join(", ") + " per day."}>
      <BarChart data={data} margin={{ left: -16, right: 4, top: 8 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="at" {...axis} minTickGap={16} />
        <YAxis {...axis} allowDecimals={false} tickCount={4} />
        {tip}
        {Object.keys(series).map((k) => <Bar key={k} dataKey={k} fill={`var(--color-${k})`} radius={[3, 3, 0, 0]} maxBarSize={14} isAnimationActive />)}
      </BarChart>
    </ChartContainer>
  );
}
