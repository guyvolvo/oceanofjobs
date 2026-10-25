// The CRM's shell: the bar, the tabs and the small pages (overview,
// segments, activity). Contacts, emails and the changelog have their own files.
import { useCallback, useEffect, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Banner } from "@cloudflare/kumo/components/banner";
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

type Dash = { complete: boolean; members: number; new_7: number; new_30: number; newsletter: number; agreed: number;
  waitlist: { basic: number; pro: number }; plans: Record<string, number>; by_day: [string, number][] };

function Overview({ sending }: { sending: boolean }) {
  const { data, error, load } = useLoad<Dash>("/dashboard");
  if (error) return <Failed error={error} retry={load} />;
  if (!data) return <p className="crm-note"><Loader /> Loading</p>;
  const max = Math.max(1, ...data.by_day.map(([, n]) => n));
  const stats: [number, string][] = [
    [data.members, "users"], [data.new_7, "joined in the last 7 days"], [data.new_30, "joined in the last 30 days"],
    [data.newsletter, "subscribed to product updates"], [data.waitlist.basic, "on the Basic waitlist"], [data.waitlist.pro, "on the Pro waitlist"],
    [data.agreed, "agreed to the current terms"],
  ];
  return (
    <div className="crm-stack">
      {!sending ? <Banner variant="default" title="Sending to users is off"
        description="Test emails to you work. To send to users, set SENDING to on in the Worker's settings." /> : null}
      {!data.complete ? <Banner variant="default" title="Some users aren't counted" description="The user list is longer than one read covers." /> : null}
      <div className="crm-stats">
        {stats.map(([n, label]) => <LayerCard key={label}><div className="crm-stat"><b>{n.toLocaleString()}</b><span>{label}</span></div></LayerCard>)}
      </div>
      <LayerCard>
        <div className="crm-card">
          <h2>New users, last 30 days</h2>
          <p className="crm-note">{Object.entries(data.plans).map(([p, n]) => `${plural(n, "user")} on ${p}`).join(" · ")}</p>
          <div className="crm-bars" role="img" aria-label="New users per day">
            {data.by_day.map(([d, n]) => <i key={d} title={`${day(d)}: ${n}`} style={{ height: `${(n / max) * 100}%` }} />)}
          </div>
        </div>
      </LayerCard>
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
          <div className="crm-table"><Table><Table.Body>
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
        <div className="crm-table"><Table><Table.Body>
          {data.entries.map((a) => (
            <Table.Row key={a.sk}>
              <Table.Cell className="crm-sub">{new Date(a.sk.split("#")[0]).toLocaleString()}</Table.Cell>
              <Table.Cell>{a.action}</Table.Cell>
              <Table.Cell className="crm-sub">{Object.entries(a.detail || {}).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ")}</Table.Cell>
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
