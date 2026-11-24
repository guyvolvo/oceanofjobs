// Usage: who uses Ocean of Jobs through its MCP server, its public API and
// the extension (crm/lib/usage.mjs). Directory and uptime checks are shown
// apart from real sessions, and the site's own API calls are left out.
import { lazy, useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChartCard, Failed, useLoad } from "./App";
import { Loading, Panel } from "./ui";

const DailyChart = lazy(() => import("./Charts").then((m) => ({ default: m.DailyChart })));

type Row = Record<string, number | string>;
type Failure = { error: string };
type Mcp = { sessions: number; checks: number; calls: number; clients: [string, number][]; tools: [string, number][]; daily: Row[] };
type Api = { calls: number; apps: [string, number][]; app_count: number; blocked: number; daily: Row[] };
type Usage = { days: number; mcp: Mcp | Failure; api: Api | Failure;
  connections: { extension: { connected: number; active: number }; mcp: { connected: number; active: number } } };

const RANGES = { 7: "7 days", 28: "28 days" } as const;
const failed = (x: object): x is Failure => "error" in x;
const n = (v: number) => v.toLocaleString();

function Stats({ items }: { items: [number, string, string?][] }) {
  return (
    <div className="crm-stats">
      {items.map(([v, label, sub]) => <Panel key={label}><div className="crm-stat"><b>{n(v)}</b><span>{label}</span>
        {sub ? <span className="crm-sub">{sub}</span> : null}</div></Panel>)}
    </div>
  );
}

function Ranked({ title, head, rows }: { title: string; head: string; rows: [string, number][] }) {
  return (
    <ChartCard title={title}>
      {rows.length ? (
        <Table>
          <TableHeader><TableRow><TableHead>{head}</TableHead><TableHead className="text-right">Calls</TableHead></TableRow></TableHeader>
          <TableBody>{rows.map(([name, v]) => (
            <TableRow key={name}><TableCell className="max-w-[340px] truncate" title={name}>{name}</TableCell><TableCell className="text-right tabular-nums">{n(v)}</TableCell></TableRow>
          ))}</TableBody>
        </Table>
      ) : <p className="crm-note">None in this range.</p>}
    </ChartCard>
  );
}

export function Usage() {
  const [days, setDays] = useState<7 | 28>(7);
  const { data, error, load } = useLoad<Usage>(`/usage?days=${days}`);
  if (error) return <Failed error={error} retry={load} />;
  if (!data) return <Loading />;
  const { mcp, api, connections: c } = data;
  return (
    <div className="crm-stack">
      <Tabs value={String(days)} onValueChange={(v) => setDays(Number(v) as 7 | 28)}>
        <TabsList aria-label="Range">
          {Object.entries(RANGES).map(([k, label]) => <TabsTrigger key={k} value={k} className="px-3">{label}</TabsTrigger>)}
        </TabsList>
      </Tabs>

      <h2 className="crm-section">MCP server</h2>
      {failed(mcp) ? <Failed error={mcp.error} retry={load} /> : (
        <>
          <Stats items={[[mcp.sessions, "Sessions", "AI apps connecting"], [mcp.calls, "Tool calls", "Searches, job pages, account tools"],
            [mcp.checks, "Directory checks", "Directories and monitors checking it's up"],
            [c.mcp.connected, "Account tokens", `${n(c.mcp.active)} used in the last 7 days`]]} />
          <div className="crm-charts">
            <ChartCard title="Per day" wide>
              <DailyChart rows={mcp.daily} series={{ sessions: ["Sessions", "var(--chart-brand)"], calls: ["Tool calls", "var(--chart-info)"] }} />
            </ChartCard>
            <Ranked title="Tool calls by tool" head="Tool" rows={mcp.tools} />
            <Ranked title="Sessions by app" head="App" rows={mcp.clients} />
          </div>
        </>
      )}

      <h2 className="crm-section">Public API</h2>
      {failed(api) ? <Failed error={api.error} retry={load} /> : (
        <>
          <Stats items={[[api.calls, "Calls from apps", "The site's own calls left out"], [api.app_count, "Apps calling it"],
            [api.blocked, "Blocked", "Scrapers the firewall stopped"]]} />
          <div className="crm-charts">
            <ChartCard title="Per day" wide>
              <DailyChart rows={api.daily} series={{ calls: ["Calls from apps", "var(--chart-brand)"], blocked: ["Blocked", "var(--chart-danger)"] }} />
            </ChartCard>
            <Ranked title="Apps" head="App" rows={api.apps} />
          </div>
          <p className="crm-note">Cloudflare samples longer ranges, so 28-day numbers are close but rounded.</p>
        </>
      )}

      <h2 className="crm-section">Extension</h2>
      <Stats items={[[c.extension.connected, "Connected", "Installs linked to an account"], [c.extension.active, "Active", "Used in the last 7 days"]]} />
    </div>
  );
}
