// The paid plans' waitlists: who's waiting and since when, approving them
// (a license until a date), moving them between Pro and Basic, removing
// them, emailing them, and the Pro limit. Changes go through the
// website's server (crm/lib/admin.mjs); the page only reads.
import { useMemo, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { Input } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Table } from "@cloudflare/kumo/components/table";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { crm, day, plural, type Campaign } from "./api";
import { Failed, useLoad } from "./App";

type Person = { id: string; email: string; waitlist: "basic" | "pro"; joined_at: string | null; status: "waiting" | "approved";
  newsletter: boolean; plan: string; license: { plan: string; until: string } | null };
type Data = { counts: { pro: { cap: number; taken: number } }; people: Person[] };

const NAME = { basic: "Basic", pro: "Pro", free: "Free" } as Record<string, string>;
const key = (p: Person) => `${p.id}:${p.waitlist}`;

function csv(people: Person[]) {
  const cell = (v: string) => (/^[=+\-@]/.test(v) ? "'" + v : v).replace(/"/g, '""');
  const rows = [["email", "waitlist", "joined", "status", "product_updates", "plan"],
    ...people.map((p) => [p.email, p.waitlist, p.joined_at || "", p.status, p.newsletter ? "yes" : "no", p.plan])];
  const url = URL.createObjectURL(new Blob([rows.map((r) => r.map((v) => `"${cell(v)}"`).join(",")).join("\n")], { type: "text/csv" }));
  Object.assign(document.createElement("a"), { href: url, download: `ocean-of-jobs-waitlist-${new Date().toISOString().slice(0, 10)}.csv` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function Waitlist({ onEmail }: { onEmail: (c: Campaign) => void }) {
  const toasts = useKumoToastManager();
  const { data, error, load } = useLoad<Data>("/waitlist?fresh=1");
  const [list, setList] = useState("");
  const [status, setStatus] = useState("waiting");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [until, setUntil] = useState("2026-12-31");
  const [first, setFirst] = useState("10");
  const [cap, setCap] = useState("");
  const [busy, setBusy] = useState("");
  const [confirm, setConfirm] = useState("");
  const shown = useMemo(() => (data?.people || []).filter((p) => (!list || p.waitlist === list) && (!status || p.status === status)), [data, list, status]);
  const chosen = shown.filter((p) => picked.has(key(p)));
  const toggle = (k: string, on: boolean) => setPicked((s) => { const n = new Set(s); if (on) n.add(k); else n.delete(k); return n; });
  const run = (what: string, fn: () => Promise<string>) => async () => {
    setBusy(what);
    try { toasts.add({ variant: "success", title: await fn() }); load(); } catch (e) { toasts.add({ variant: "error", title: (e as Error).message }); }
    finally { setBusy(""); setConfirm(""); }
  };
  const change = (body: object, done: string) => run(JSON.stringify(body), async () => { await crm("/waitlist", "POST", body); return done; });
  const approve = run("approve", async () => {
    const people = chosen.map((p) => ({ id: p.id, plan: p.waitlist }));
    let emailed = 0;
    for (let i = 0; i < people.length; i += 8) {
      emailed += (await crm<{ emailed: number }>("/waitlist/approve", "POST", { people: people.slice(i, i + 8), until })).emailed || 0;
    }
    setPicked(new Set());
    return `${plural(people.length, "person", "people")} approved, licensed until ${day(until + "T12:00:00")}`
      + (emailed ? `, ${plural(emailed, "email")} sent` : "");
  });
  const email = async () => {
    try {
      const r = await crm<{ campaign: Campaign }>("/campaigns", "POST", { subject: "", body: "", to: [...new Set(chosen.map((p) => p.id))] });
      onEmail(r.campaign);
    } catch (e) { toasts.add({ variant: "error", title: (e as Error).message }); }
  };
  if (error) return <Failed error={error} retry={load} />;
  if (!data) return <p className="crm-note"><Loader /> Loading</p>;
  const pro = data.counts.pro;
  const basic = data.people.filter((p) => p.waitlist === "basic").length;
  return (
    <div className="crm-stack">
      <div className="crm-stats">
        <LayerCard><div className="crm-stat">
          <b>{pro.taken} <small>of {pro.cap}</small></b><span>Pro places taken</span>
          <span className="wl-meter"><i style={{ width: `${Math.min(100, pro.cap ? (pro.taken / pro.cap) * 100 : 100)}%` }} /></span>
        </div></LayerCard>
        <LayerCard><div className="crm-stat"><b>{basic}</b><span>on the Basic waitlist, no limit</span></div></LayerCard>
        <LayerCard><div className="crm-stat"><b>{data.people.filter((p) => p.status === "approved").length}</b><span>approved</span></div></LayerCard>
        <LayerCard><div className="crm-card crm-stack">
          <div className="crm-row">
            <Input label="Pro limit" type="number" min={0} value={cap} placeholder={String(pro.cap)} onChange={(e) => setCap(e.target.value)} />
            <Button variant="secondary" disabled={cap === "" || Number(cap) === pro.cap} loading={busy.includes('"cap"')}
              onClick={change({ op: "cap", cap: Number(cap) }, `Pro limit set to ${cap}`)}>Save</Button>
          </div>
          <span className="crm-note">New Pro joins stop at this number. Lowering it doesn't remove anyone.</span>
        </div></LayerCard>
      </div>
      <LayerCard><div className="crm-card crm-stack">
        <div className="crm-row">
          <Select label="Waitlist" value={list} onValueChange={(v) => setList(String(v ?? ""))} items={{ "": "Both", pro: "Pro", basic: "Basic" }} />
          <Select label="Status" value={status} onValueChange={(v) => setStatus(String(v ?? ""))} items={{ "": "Anyone", waiting: "Waiting", approved: "Approved" }} />
          <div className="crm-num"><Input label="Pick the first" type="number" min={1} value={first} onChange={(e) => setFirst(e.target.value)} /></div>
          <Button variant="secondary" onClick={() => setPicked(new Set(shown.slice(0, Number(first) || 0).map(key)))}>Pick</Button>
          <div className="crm-grow" />
          <Button variant="secondary" onClick={() => csv(shown)}>Export CSV</Button>
        </div>
        <div className="crm-row">
          <span className="crm-note crm-grow">{plural(shown.length, "person", "people")}{chosen.length ? ` · ${chosen.length} picked` : ""}</span>
          <Input label="License until" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
          <Button variant="primary" disabled={!chosen.length || !until} loading={busy === "approve"} onClick={approve}>
            {chosen.length ? `Approve ${chosen.length}` : "Approve picked"}</Button>
          <Button variant="secondary" disabled={!chosen.length} onClick={email}>Email picked</Button>
        </div>
      </div></LayerCard>
      <LayerCard><div className="crm-card">
        {!shown.length ? <p className="crm-note">Nobody here.</p> : (
          <div className="crm-table"><Table>
            <Table.Header><Table.Row>
              <Table.Head><Checkbox aria-label="Pick everyone shown" checked={shown.every((p) => picked.has(key(p)))}
                onCheckedChange={(on) => setPicked(new Set(on === true ? shown.map(key) : []))} /></Table.Head>
              <Table.Head>User</Table.Head><Table.Head>Waitlist</Table.Head><Table.Head>Joined</Table.Head><Table.Head>Status</Table.Head>
              <Table.Head>Plan now</Table.Head><Table.Head><span className="sr-only">Changes</span></Table.Head>
            </Table.Row></Table.Header>
            <Table.Body>
              {shown.map((p) => {
                const k = key(p);
                const other = p.waitlist === "pro" ? "basic" : "pro";
                return (
                  <Table.Row key={k}>
                    <Table.Cell><Checkbox aria-label={`Pick ${p.email}`} checked={picked.has(k)} onCheckedChange={(on) => toggle(k, on === true)} /></Table.Cell>
                    <Table.Cell>{p.email}<span className="crm-sub">{p.newsletter ? "Gets product updates" : "No product updates"}</span></Table.Cell>
                    <Table.Cell>{NAME[p.waitlist]}</Table.Cell>
                    <Table.Cell>{day(p.joined_at)}</Table.Cell>
                    <Table.Cell><span className={`crm-chip${p.status === "approved" ? " ok" : ""}`}>{p.status === "approved" ? "Approved" : "Waiting"}</span></Table.Cell>
                    <Table.Cell>{NAME[p.plan] || p.plan}{p.license ? <span className="crm-sub">License until {p.license.until ? day(p.license.until + "T12:00:00") : "no end"}</span> : null}</Table.Cell>
                    <Table.Cell>
                      <div className="crm-row">
                        <Button variant="ghost" size="sm" loading={busy.includes(`"move","user_id":"${p.id}"`)}
                          onClick={change({ op: "move", user_id: p.id, plan: other }, `${p.email} moved to ${NAME[other]}`)}>Move to {NAME[other]}</Button>
                        {confirm === k
                          ? <Button variant="destructive" size="sm" onClick={change({ op: "remove", user_id: p.id, plan: p.waitlist }, `${p.email} removed from ${NAME[p.waitlist]}`)}>Confirm remove</Button>
                          : <Button variant="ghost" size="sm" onClick={() => setConfirm(k)}>Remove</Button>}
                      </div>
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table></div>
        )}
      </div></LayerCard>
    </div>
  );
}
