// The CRM's shell: the bar, the tabs and the small pages (overview,
// segments, activity). Contacts, emails and the changelog have their own files.
import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { Table } from "@cloudflare/kumo/components/table";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { crm, day, describe, plural, type Campaign, type Filter, type Segment } from "./api";
import { Contacts } from "./Contacts";
import { Emails } from "./Emails";
import { Changelog } from "./Changelog";
import { Inbox } from "./Inbox";
import { Waitlist } from "./Waitlist";
import { Flows } from "./Flows";

const TABS = [
  { value: "overview", label: "Overview" }, { value: "inbox", label: "Inbox" }, { value: "contacts", label: "Users" }, { value: "waitlist", label: "Waitlist" }, { value: "segments", label: "Groups" },
  { value: "emails", label: "Emails" }, { value: "flows", label: "Flows" }, { value: "changelog", label: "Changelog" }, { value: "activity", label: "Activity" },
];

export function useLoad<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    setError("");
    crm<T>(path).then(setData, (e) => setError(e.message || "Couldn't load this."));
  }, [path]);
  useEffect(load, [load]);
  return { data, error, load, setData };
}

export function Failed({ error, retry }: { error: string; retry: () => void }) {
  return <Banner variant="error" title={error} action={<Button onClick={retry}>Try again</Button>} />;
}

type Range = "24h" | "7d" | "30d" | "90d";
type Dash = { complete: boolean; range: Range; members: number; new: number; newsletter: number; waitlist: { basic: number; pro: number };
  mcp: number; signups: [string, number][]; total: [string, number][]; funnel: [string, number][]; providers: Record<string, number>;
  plans: Record<string, number>; applications: Apps };
// Attempt outcomes as [label, confirmed, unconfirmed, sent by the user, failed].
type Split = [string, number, number, number, number];
type Apps = { confirmed: number; unconfirmed: number; sent: number; failed: number; disputed: number; older: number; by_time: Split[]; by_system: Split[];
  weeks: number; active_user_weeks: number; per_user_week: number | null; unconfirmed_per_user_week: number | null;
  sent_per_user_week: number | null };
// Imported on first use, so ECharts loads with the overview, not the CRM.
const Charts = () => import("./Charts");
const SignupsChart = lazy(() => Charts().then((m) => ({ default: m.SignupsChart })));
const GrowthChart = lazy(() => Charts().then((m) => ({ default: m.GrowthChart })));
const FunnelChart = lazy(() => Charts().then((m) => ({ default: m.FunnelChart })));
const ShareChart = lazy(() => Charts().then((m) => ({ default: m.ShareChart })));
const OutcomesChart = lazy(() => Charts().then((m) => ({ default: m.OutcomesChart })));
const SystemsChart = lazy(() => Charts().then((m) => ({ default: m.SystemsChart })));
const PROVIDER: Record<string, string> = { google: "Google", github: "GitHub", email: "Email" };
const PLAN: Record<string, string> = { free: "Free", basic: "Basic", pro: "Pro" };
const RANGES: Record<Range, string> = { "24h": "24h", "7d": "7d", "30d": "30d", "90d": "90d" };

function ChartCard({ title, children, wide }: { title: string; children: ReactNode; wide?: boolean }) {
  return (
    <LayerCard className={wide ? "crm-wide" : undefined}><div className="crm-card">
      <h2>{title}</h2>
      <Suspense fallback={<p className="crm-note"><Loader /> Loading</p>}>{children}</Suspense>
    </div></LayerCard>
  );
}

function Overview({ sending }: { sending: boolean }) {
  const [range, setRange] = useState<Range>("30d");
  const { data, error, load } = useLoad<Dash>(`/dashboard?range=${range}`);
  if (error) return <Failed error={error} retry={load} />;
  if (!data) return <p className="crm-note"><Loader /> Loading</p>;
  const stats: [number, string, string?][] = [
    [data.members, "Users"], [data.new, `New in ${RANGES[range]}`], [data.newsletter, "Product updates"],
    [data.waitlist.basic, "Basic waitlist"], [data.waitlist.pro, "Pro waitlist"], [data.mcp, "AI agent"],
    [data.applications.per_user_week ?? 0, "Confirmed per active user per week",
      `${(data.applications.unconfirmed_per_user_week ?? 0).toLocaleString()} unconfirmed, ${(data.applications.sent_per_user_week ?? 0).toLocaleString()} sent by user`],
  ];
  const apps = data.applications;
  const parts = (m: Record<string, number>, names: Record<string, string>): [string, number][] => Object.entries(m).map(([k, n]) => [names[k] || k, n]);
  return (
    <div className="crm-stack">
      {!sending ? <Banner variant="default" title="Sending to users is off"
        description="Test emails to you work. To send to users, set SENDING to on in the Worker's settings." /> : null}
      {!data.complete ? <Banner variant="default" title="Some users aren't counted" description="The user list is longer than one read covers." /> : null}
      <div><Tabs variant="segmented" value={range} onValueChange={(v) => setRange(v as Range)}
        tabs={(Object.keys(RANGES) as Range[]).map((r) => ({ value: r, label: RANGES[r] }))} /></div>
      <div className="crm-stats">
        {stats.map(([n, label, sub]) => <LayerCard key={label}><div className="crm-stat"><b>{n.toLocaleString()}</b><span>{label}</span>
          {sub ? <span className="crm-sub">{sub}</span> : null}</div></LayerCard>)}
      </div>
      <p className="crm-note">An active user had at least one application started or finished that week, counted once. Weeks run in UTC, counted over the last {apps.weeks === 1 ? "week" : `${apps.weeks} weeks`}.</p>
      <div className="crm-charts">
        <ChartCard title="Sign-ups"><SignupsChart buckets={data.signups} /></ChartCard>
        <ChartCard title="Total users"><GrowthChart buckets={data.total} /></ChartCard>
        <ChartCard title="Funnel" wide><FunnelChart steps={data.funnel} /></ChartCard>
        <ChartCard title="Sign-in method"><ShareChart name="Sign-in method" parts={parts(data.providers, PROVIDER)} /></ChartCard>
        <ChartCard title="Plans"><ShareChart name="Plans" parts={parts(data.plans, PLAN)} /></ChartCard>
        <ChartCard title="Applications" wide>
          <OutcomesChart buckets={apps.by_time} />
          <p className="crm-note">{plural(apps.disputed, "attempt")} disputed as not sent, left out.</p>
          <p className="crm-note">Counts recorded attempts only.{apps.older ? " Applications from before attempts were recorded aren't included, so a lower number here doesn't mean fewer applications." : ""}</p>
        </ChartCard>
        <ChartCard title="By hiring system" wide>
          {apps.by_system.length ? <SystemsChart systems={apps.by_system} /> : <p className="crm-note">No applications in this range.</p>}
        </ChartCard>
      </div>
    </div>
  );
}

export function FilterFields({ filter, set }: { filter: Filter; set: (f: Filter) => void }) {
  const up = (k: keyof Filter, v: unknown) => set({ ...filter, [k]: v === "" ? undefined : v });
  return (
    <div className="crm-row">
      <div className="crm-grow"><Input label="Search" placeholder="Email or tag" value={filter.search || ""} onChange={(e) => up("search", e.target.value)} /></div>
      <Select label="Product updates" value={filter.newsletter === undefined ? "" : filter.newsletter ? "yes" : "no"}
        onValueChange={(v) => up("newsletter", v === "" ? undefined : v === "yes")} items={{ "": "Anyone", yes: "Subscribed", no: "Not subscribed" }} />
      <Select label="Waitlist" value={filter.waitlist || ""} onValueChange={(v) => up("waitlist", v)}
        items={{ "": "Anyone", any: "Any waitlist", basic: "Basic", pro: "Pro" }} />
      <Select label="Plan" value={filter.plan || ""} onValueChange={(v) => up("plan", v)} items={{ "": "Any plan", free: "Free", basic: "Basic", pro: "Pro" }} />
      <Input label="Tag" value={filter.tag || ""} onChange={(e) => up("tag", e.target.value.trim().toLowerCase())} />
      <Input label="Joined after" type="date" value={filter.signed_up_after || ""} onChange={(e) => up("signed_up_after", e.target.value)} />
    </div>
  );
}

function Segments() {
  const toasts = useKumoToastManager();
  const { data, error, load } = useLoad<{ segments: Segment[] }>("/segments");
  const [name, setName] = useState("");
  const [filter, setFilter] = useState<Filter>({});
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await crm("/segments", "POST", { name, filter });
      setName(""); setFilter({});
      toasts.add({ variant: "success", title: "Group saved" });
      load();
    } catch (e) {
      toasts.add({ variant: "error", title: (e as Error).message });
    } finally { setBusy(false); }
  };
  const remove = async (s: Segment) => {
    await crm(`/segments/${s.sk}`, "DELETE").then(load, (e) => toasts.add({ variant: "error", title: e.message }));
  };
  if (error) return <Failed error={error} retry={load} />;
  return (
    <div className="crm-stack">
      <LayerCard><div className="crm-card crm-stack">
        <div><h2>New group</h2><p className="crm-note">A saved filter for emails. Only users subscribed to product updates are ever emailed, whatever the group says.</p></div>
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Pro waitlist" />
        <FilterFields filter={filter} set={setFilter} />
        <div><Button variant="primary" loading={busy} disabled={!name.trim()} onClick={save}>Save group</Button></div>
      </div></LayerCard>
      <LayerCard><div className="crm-card">
        <h2>Groups</h2>
        {!data ? <p className="crm-note"><Loader /> Loading</p> : !data.segments.length ? <p className="crm-note">No groups yet.</p> : (
          <div className="crm-table"><Table className="crm-list"><Table.Body>
            {data.segments.map((s) => (
              <Table.Row key={s.sk}>
                <Table.Cell><b>{s.name}</b><span className="crm-sub">{describe(s.filter)}</span></Table.Cell>
                <Table.Cell><Button variant="ghost" onClick={() => remove(s)}>Delete</Button></Table.Cell>
              </Table.Row>
            ))}
          </Table.Body></Table></div>
        )}
      </div></LayerCard>
    </div>
  );
}

type Audit = { sk: string; who: string; action: string; detail: Record<string, unknown> };
function Activity() {
  const { data, error, load } = useLoad<{ entries: Audit[] }>("/audit");
  if (error) return <Failed error={error} retry={load} />;
  return (
    <LayerCard><div className="crm-card">
      <h2>Activity</h2>
      <p className="crm-note">Everything done in the CRM: views of a user, exports, edits and every email sent.</p>
      {!data ? <p className="crm-note"><Loader /> Loading</p> : (
        <div className="crm-table"><Table className="crm-log"><Table.Body>
          {data.entries.map((a) => (
            <Table.Row key={a.sk}>
              <Table.Cell><span className="crm-sub">{new Date(a.sk.split("#")[0]).toLocaleString()}</span></Table.Cell>
              <Table.Cell>{a.action}</Table.Cell>
              <Table.Cell><span className="crm-sub">{Object.entries(a.detail || {}).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ")}</span></Table.Cell>
            </Table.Row>
          ))}
        </Table.Body></Table></div>
      )}
    </div></LayerCard>
  );
}

export function App() {
  const [tab, setTab] = useState(() => (location.hash.slice(1) && TABS.some((t) => t.value === location.hash.slice(1)) ? location.hash.slice(1) : "overview"));
  const { data: me } = useLoad<{ email: string; sending: boolean }>("/me");
  const [light, setLight] = useState(document.documentElement.dataset.mode === "light");
  const [draft, setDraft] = useState<Campaign | null>(null);
  const [unread, setUnread] = useState(0);
  useEffect(() => { crm<{ messages: { dir: string; read: boolean }[] }>("/inbox").then((r) => setUnread(r.messages.filter((m) => m.dir === "in" && !m.read).length), () => {}); }, []);
  const go = (v: string) => { setTab(v); history.replaceState(null, "", "#" + v); };
  const theme = () => {
    const next = !light;
    setLight(next);
    document.documentElement.dataset.mode = next ? "light" : "dark";
    try { localStorage.setItem("crm_theme", next ? "light" : "dark"); } catch { /* storage blocked */ }
  };
  return (
    <div className="crm">
      <aside className="crm-side">
        <span className="crm-brand">Ocean of Jobs <small>CRM</small></span>
        <nav className="crm-nav" aria-label="CRM">
          {TABS.map((t) => (
            <button key={t.value} type="button" className="crm-nav-item" aria-current={tab === t.value ? "page" : undefined} onClick={() => go(t.value)}>
              {t.label}{t.value === "inbox" && unread ? <span className="crm-count" aria-label={`${unread} unread`}>{unread}</span> : null}
            </button>
          ))}
        </nav>
        <div className="crm-side-foot">
          <span className="crm-who">{me ? me.email : ""}</span>
          <Button variant="secondary" size="sm" onClick={theme}>{light ? "Dark theme" : "Light theme"}</Button>
        </div>
      </aside>
      <main className="crm-main">
      {tab === "overview" ? <Overview sending={!!me?.sending} /> : null}
      {tab === "inbox" ? <Inbox sending={!!me?.sending} onUnread={setUnread} /> : null}
      {tab === "contacts" ? <Contacts sending={!!me?.sending} onEmail={(c) => { setDraft(c); go("emails"); }} /> : null}
      {tab === "waitlist" ? <Waitlist onEmail={(c) => { setDraft(c); go("emails"); }} /> : null}
      {tab === "segments" ? <Segments /> : null}
      {tab === "emails" ? <Emails sending={!!me?.sending} initial={draft} onOpened={() => setDraft(null)} /> : null}
      {tab === "flows" ? <Flows /> : null}
      {tab === "changelog" ? <Changelog onEmail={() => go("emails")} /> : null}
      {tab === "activity" ? <Activity /> : null}
      </main>
    </div>
  );
}
