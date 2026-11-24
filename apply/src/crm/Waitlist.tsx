// The paid plans' waitlists: who's waiting and since when, approving them
// (a license until a date), moving them between Pro and Basic, removing
// them, emailing them, and the Pro limit. Changes go through the
// website's server (crm/lib/admin.mjs); the page only reads.
import { useMemo, useState } from "react";
import { crm, day, plural, type Campaign } from "./api";
import { Failed, useLoad } from "./App";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Btn, Loading, Panel, SelectField, TextField } from "./ui";

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
    try { toast.success(await fn()); load(); } catch (e) { toast.error((e as Error).message); }
    finally { setBusy(""); setConfirm(""); }
  };
  const change = (body: object, done: string) => run(JSON.stringify(body), async () => { await crm("/waitlist", "POST", body); return done; });
  const approve = run("approve", async () => {
    const people = chosen.map((p) => ({ id: p.id, plan: p.waitlist }));
    let emailed = 0;
    for (let i = 0; i < people.length; i += 6) {
      emailed += (await crm<{ emailed: number }>("/waitlist/approve", "POST", { people: people.slice(i, i + 6), until })).emailed || 0;
    }
    setPicked(new Set());
    return `${plural(people.length, "person", "people")} approved, licensed until ${day(until + "T12:00:00")}`
      + (emailed ? `, ${plural(emailed, "email")} sent` : "");
  });
  const email = async () => {
    try {
      const r = await crm<{ campaign: Campaign }>("/campaigns", "POST", { subject: "", body: "", to: [...new Set(chosen.map((p) => p.id))] });
      onEmail(r.campaign);
    } catch (e) { toast.error((e as Error).message); }
  };
  if (error) return <Failed error={error} retry={load} />;
  if (!data) return <Loading />;
  const pro = data.counts.pro;
  const basic = data.people.filter((p) => p.waitlist === "basic").length;
  return (
    <div className="crm-stack">
      <div className="crm-stats">
        <Panel><div className="crm-stat">
          <b>{pro.taken} <small>of {pro.cap}</small></b><span>Pro places taken</span>
          <span className="wl-meter"><i style={{ width: `${Math.min(100, pro.cap ? (pro.taken / pro.cap) * 100 : 100)}%` }} /></span>
          <div className="crm-row wl-cap">
            <div className="crm-num"><TextField aria-label="Pro limit" type="number" min={0} value={cap} placeholder={String(pro.cap)} onChange={(e) => setCap(e.target.value)} /></div>
            <Btn variant="outline" size="sm" disabled={cap === "" || Number(cap) === pro.cap} loading={busy.includes('"cap"')}
              onClick={change({ op: "cap", cap: Number(cap) }, `Pro limit set to ${cap}`)}>Change limit</Btn>
          </div>
        </div></Panel>
        <Panel><div className="crm-stat"><b>{basic}</b><span>on the Basic waitlist, no limit</span></div></Panel>
        <Panel><div className="crm-stat"><b>{data.people.filter((p) => p.status === "approved").length}</b><span>approved</span></div></Panel>
      </div>
      <Panel><div className="crm-card crm-stack">
        <div className="crm-row">
          <SelectField label="Waitlist" value={list} onValueChange={(v) => setList(String(v ?? ""))} items={{ "": "Both", pro: "Pro", basic: "Basic" }} />
          <SelectField label="Status" value={status} onValueChange={(v) => setStatus(String(v ?? ""))} items={{ "": "Anyone", waiting: "Waiting", approved: "Approved" }} />
          <div className="crm-num"><TextField label="Pick the first" type="number" min={1} value={first} onChange={(e) => setFirst(e.target.value)} /></div>
          <Button variant="outline" onClick={() => setPicked(new Set(shown.slice(0, Number(first) || 0).map(key)))}>Pick</Button>
          <div className="crm-grow" />
          <Button variant="outline" onClick={() => csv(shown)}>Export CSV</Button>
        </div>
        <div className="crm-row">
          <span className="crm-note crm-grow">{plural(shown.length, "person", "people")}{chosen.length ? ` · ${chosen.length} picked` : ""}</span>
          <TextField label="License until" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
          <Btn disabled={!chosen.length || !until} loading={busy === "approve"} onClick={approve}>
            {chosen.length ? `Approve ${chosen.length}` : "Approve picked"}</Btn>
          <Button variant="outline" disabled={!chosen.length} onClick={email}>Email picked</Button>
        </div>
      </div></Panel>
      <Panel><div className="crm-card">
        {!shown.length ? <p className="crm-note">Nobody here.</p> : (
          <div className="crm-table"><Table>
            <TableHeader><TableRow>
              <TableHead><Checkbox aria-label="Pick everyone shown" checked={shown.every((p) => picked.has(key(p)))}
                onCheckedChange={(on) => setPicked(new Set(on === true ? shown.map(key) : []))} /></TableHead>
              <TableHead>User</TableHead><TableHead>Waitlist</TableHead><TableHead>Joined</TableHead><TableHead>Status</TableHead>
              <TableHead>Plan now</TableHead><TableHead><span className="sr-only">Changes</span></TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {shown.map((p) => {
                const k = key(p);
                const other = p.waitlist === "pro" ? "basic" : "pro";
                return (
                  <TableRow key={k}>
                    <TableCell><Checkbox aria-label={`Pick ${p.email}`} checked={picked.has(k)} onCheckedChange={(on) => toggle(k, on === true)} /></TableCell>
                    <TableCell>{p.email}<span className="crm-sub">{p.newsletter ? "Gets product updates" : "No product updates"}</span></TableCell>
                    <TableCell>{NAME[p.waitlist]}</TableCell>
                    <TableCell>{day(p.joined_at)}</TableCell>
                    <TableCell><span className={`crm-chip${p.status === "approved" ? " ok" : ""}`}>{p.status === "approved" ? "Approved" : "Waiting"}</span></TableCell>
                    <TableCell>{NAME[p.plan] || p.plan}{p.license ? <span className="crm-sub">License until {p.license.until ? day(p.license.until + "T12:00:00") : "no end"}</span> : null}</TableCell>
                    <TableCell>
                      <div className="crm-row">
                        <Btn variant="ghost" size="sm" loading={busy.includes(`"move","user_id":"${p.id}"`)}
                          onClick={change({ op: "move", user_id: p.id, plan: other }, `${p.email} moved to ${NAME[other]}`)}>Move to {NAME[other]}</Btn>
                        {confirm === k
                          ? <Button variant="destructive" size="sm" onClick={change({ op: "remove", user_id: p.id, plan: p.waitlist }, `${p.email} removed from ${NAME[p.waitlist]}`)}>Confirm remove</Button>
                          : <Button variant="ghost" size="sm" onClick={() => setConfirm(k)}>Remove</Button>}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table></div>
        )}
      </div></Panel>
    </div>
  );
}
