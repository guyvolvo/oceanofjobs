// The CRM's shell: the sidebar and the small pages (overview, segments,
// activity). Contacts, emails and the changelog have their own files.
import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Article, ChartBar, ClockCounterClockwise, EnvelopeSimple, FlowArrow, FunnelSimple, Hourglass, Moon, SquaresFour, Sun, Tray, Users, type Icon } from "@/components/icons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarHeader, SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem,
  SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { crm, day, describe, plural, type Campaign, type Filter, type Segment } from "./api";
import { Contacts } from "./Contacts";
import { Emails } from "./Emails";
import { Changelog } from "./Changelog";
import { Inbox } from "./Inbox";
import { Waitlist } from "./Waitlist";
import { Flows } from "./Flows";
import { Usage } from "./Usage";
import { Btn, Loading, Panel, SelectField, TextField } from "./ui";

const TABS: { value: string; label: string; icon: Icon }[] = [
  { value: "overview", label: "Overview", icon: SquaresFour }, { value: "inbox", label: "Inbox", icon: Tray }, { value: "contacts", label: "Users", icon: Users }, { value: "usage", label: "Usage", icon: ChartBar },
  { value: "waitlist", label: "Waitlist", icon: Hourglass }, { value: "segments", label: "Groups", icon: FunnelSimple }, { value: "emails", label: "Emails", icon: EnvelopeSimple },
  { value: "flows", label: "Flows", icon: FlowArrow }, { value: "changelog", label: "Changelog", icon: Article }, { value: "activity", label: "Activity", icon: ClockCounterClockwise },
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
  return (
    <Alert variant="destructive" className="flex flex-wrap items-center justify-between gap-3">
      <AlertTitle className="line-clamp-none">{error}</AlertTitle>
      <Button variant="outline" size="sm" onClick={retry}>Try again</Button>
    </Alert>
  );
}

function Notice({ title, description }: { title: string; description: string }) {
  return <Alert role="status"><AlertTitle>{title}</AlertTitle><AlertDescription>{description}</AlertDescription></Alert>;
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
// Imported on first use, so Recharts loads with the overview, not the CRM.
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

export function ChartCard({ title, children, wide }: { title: string; children: ReactNode; wide?: boolean }) {
  return (
    <Panel className={wide ? "crm-wide" : undefined}><div className="crm-card">
      <h2>{title}</h2>
      <Suspense fallback={<Loading />}>{children}</Suspense>
    </div></Panel>
  );
}

function Overview({ sending }: { sending: boolean }) {
  const [range, setRange] = useState<Range>("30d");
  const { data, error, load } = useLoad<Dash>(`/dashboard?range=${range}`);
  if (error) return <Failed error={error} retry={load} />;
  if (!data) return <Loading />;
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
      {!sending ? <Notice title="Sending to users is off" description="Test emails to you work. To send to users, set SENDING to on in the Worker's settings." /> : null}
      {!data.complete ? <Notice title="Some users aren't counted" description="The user list is longer than one read covers." /> : null}
      <Tabs value={range} onValueChange={(v) => setRange(v as Range)}>
        <TabsList aria-label="Range">
          {(Object.keys(RANGES) as Range[]).map((r) => <TabsTrigger key={r} value={r} className="px-3">{RANGES[r]}</TabsTrigger>)}
        </TabsList>
      </Tabs>
      <div className="crm-stats">
        {stats.map(([n, label, sub]) => <Panel key={label}><div className="crm-stat"><b>{n.toLocaleString()}</b><span>{label}</span>
          {sub ? <span className="crm-sub">{sub}</span> : null}</div></Panel>)}
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
      <div className="crm-grow"><TextField label="Search" placeholder="Email or tag" value={filter.search || ""} onChange={(e) => up("search", e.target.value)} /></div>
      <SelectField label="Product updates" value={filter.newsletter === undefined ? "" : filter.newsletter ? "yes" : "no"}
        onValueChange={(v) => up("newsletter", v === "" ? undefined : v === "yes")} items={{ "": "Anyone", yes: "Subscribed", no: "Not subscribed" }} />
      <SelectField label="Waitlist" value={filter.waitlist || ""} onValueChange={(v) => up("waitlist", v)}
        items={{ "": "Anyone", any: "Any waitlist", basic: "Basic", pro: "Pro" }} />
      <SelectField label="Plan" value={filter.plan || ""} onValueChange={(v) => up("plan", v)} items={{ "": "Any plan", free: "Free", basic: "Basic", pro: "Pro" }} />
      <TextField label="Tag" value={filter.tag || ""} onChange={(e) => up("tag", e.target.value.trim().toLowerCase())} />
      <TextField label="Joined after" type="date" value={filter.signed_up_after || ""} onChange={(e) => up("signed_up_after", e.target.value)} />
    </div>
  );
}

function Segments() {
  const { data, error, load } = useLoad<{ segments: Segment[] }>("/segments");
  const [name, setName] = useState("");
  const [filter, setFilter] = useState<Filter>({});
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await crm("/segments", "POST", { name, filter });
      setName(""); setFilter({});
      toast.success("Group saved");
      load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally { setBusy(false); }
  };
  const remove = async (s: Segment) => {
    await crm(`/segments/${s.sk}`, "DELETE").then(load, (e) => toast.error(e.message));
  };
  if (error) return <Failed error={error} retry={load} />;
  return (
    <div className="crm-stack">
      <Panel><div className="crm-card crm-stack">
        <div><h2>New group</h2><p className="crm-note">A saved filter for emails. Only users subscribed to product updates are ever emailed, whatever the group says.</p></div>
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Pro waitlist" />
        <FilterFields filter={filter} set={setFilter} />
        <div><Btn loading={busy} disabled={!name.trim()} onClick={save}>Save group</Btn></div>
      </div></Panel>
      <Panel><div className="crm-card">
        <h2>Groups</h2>
        {!data ? <Loading /> : !data.segments.length ? <p className="crm-note">No groups yet.</p> : (
          <Table className="crm-list"><TableBody>
            {data.segments.map((s) => (
              <TableRow key={s.sk}>
                <TableCell><b>{s.name}</b><span className="crm-sub">{describe(s.filter)}</span></TableCell>
                <TableCell><Button variant="ghost" onClick={() => remove(s)}>Delete</Button></TableCell>
              </TableRow>
            ))}
          </TableBody></Table>
        )}
      </div></Panel>
    </div>
  );
}

type Audit = { sk: string; who: string; action: string; detail: Record<string, unknown> };
function Activity() {
  const { data, error, load } = useLoad<{ entries: Audit[] }>("/audit");
  if (error) return <Failed error={error} retry={load} />;
  return (
    <Panel><div className="crm-card">
      <h2>Activity</h2>
      <p className="crm-note">Everything done in the CRM: views of a user, exports, edits and every email sent.</p>
      {!data ? <Loading /> : (
        <Table className="crm-log"><TableBody>
          {data.entries.map((a) => (
            <TableRow key={a.sk}>
              <TableCell><span className="crm-sub">{new Date(a.sk.split("#")[0]).toLocaleString()}</span></TableCell>
              <TableCell>{a.action}</TableCell>
              <TableCell><span className="crm-sub">{Object.entries(a.detail || {}).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ")}</span></TableCell>
            </TableRow>
          ))}
        </TableBody></Table>
      )}
    </div></Panel>
  );
}

function Nav({ tab, go, unread }: { tab: string; go: (v: string) => void; unread: number }) {
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarMenu aria-label="CRM">
      {TABS.map((t) => (
        <SidebarMenuItem key={t.value}>
          <SidebarMenuButton isActive={tab === t.value} aria-current={tab === t.value ? "page" : undefined} onClick={() => { go(t.value); setOpenMobile(false); }}>
            <t.icon weight={tab === t.value ? "fill" : "regular"} /><span>{t.label}</span>
          </SidebarMenuButton>
          {t.value === "inbox" && unread ? <SidebarMenuBadge aria-label={`${unread} unread`}>{unread}</SidebarMenuBadge> : null}
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}

const Brand = () => <span className="crm-brand">Ocean of Jobs <small>CRM</small></span>;

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
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader className="px-4 pt-5"><Brand /></SidebarHeader>
        <SidebarContent><SidebarGroup><Nav tab={tab} go={go} unread={unread} /></SidebarGroup></SidebarContent>
        <SidebarFooter className="items-start gap-2 px-4 pb-5">
          <span className="crm-who">{me ? me.email : ""}</span>
          <Button variant="outline" size="sm" onClick={theme}>{light ? <Moon /> : <Sun />}{light ? "Dark theme" : "Light theme"}</Button>
        </SidebarFooter>
      </Sidebar>
      <div className="flex w-full min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b px-2 py-2 md:hidden">
          <SidebarTrigger aria-label="Menu" className="size-9" />
          <Brand />
        </div>
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
          {tab === "usage" ? <Usage /> : null}
        </main>
      </div>
    </SidebarProvider>
  );
}
