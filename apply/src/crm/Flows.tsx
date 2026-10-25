// Flows (crm/lib/auto.mjs): a trigger, conditions on the user, and steps.
// The list with quick starts, and the editor. Email text is always the
// owner's: quick starts leave every email empty.
import { useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { Input, InputArea } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { Switch } from "@cloudflare/kumo/components/switch";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Loader } from "@cloudflare/kumo/components/loader";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { crm, day, describe, plural, type Filter } from "./api";
import { Failed, FilterFields, useLoad } from "./App";
import { MailPreview } from "./Emails";
import { ImagePicker } from "./ImagePicker";

type Step = { type: string; subject?: string; body?: string; image?: string; subscribers?: boolean; url?: string; text?: string; tag?: string; plan?: string; days?: number };
type Flow = { id?: string; name: string; trigger: string; enabled: boolean; days?: number; tag?: string; conditions: Filter; actions: Step[];
  runs?: number; last_run_at?: string; last_error?: string; baseline_at?: string };
type Trigger = { id: string; group: string; name: string; help: string; days: number | null; event: boolean };
type Data = { flows: Flow[]; triggers: Trigger[]; actions: Record<string, { name: string; group: string; fields: string[] }>; sending: boolean };

const QUICK: { name: string; flow: Omit<Flow, "enabled" | "conditions"> & { conditions?: Filter } }[] = [
  { name: "Welcome new users", flow: { name: "Welcome email", trigger: "signup", actions: [{ type: "email" }] } },
  { name: "Confirm a Pro waitlist join", flow: { name: "Pro waitlist confirmation", trigger: "waitlist_pro", actions: [{ type: "email" }, { type: "tag_add", tag: "pro-waitlist" }] } },
  { name: "Confirm a Basic waitlist join", flow: { name: "Basic waitlist confirmation", trigger: "waitlist_basic", actions: [{ type: "email" }] } },
  { name: "Welcome approved beta users", flow: { name: "Beta approval", trigger: "waitlist_approved", actions: [{ type: "email" }, { type: "tag_add", tag: "beta" }] } },
  { name: "Nudge to connect the extension", flow: { name: "Connect the extension", trigger: "no_extension", days: 3, actions: [{ type: "email", subscribers: true }] } },
  { name: "Nudge to add a resume", flow: { name: "Add your resume", trigger: "no_resume", days: 2, actions: [{ type: "email" }] } },
  { name: "Celebrate the first application", flow: { name: "First application", trigger: "first_application", actions: [{ type: "email" }] } },
  { name: "Out of applications this month", flow: { name: "Applications used up", trigger: "credits_used_up", actions: [{ type: "email" }] } },
  { name: "License ending reminder", flow: { name: "License ends soon", trigger: "license_ending", days: 7, actions: [{ type: "email" }] } },
  { name: "After the license ends", flow: { name: "License ended", trigger: "license_ended", actions: [{ type: "email" }] } },
  { name: "Remind about the updated terms", flow: { name: "Terms reminder", trigger: "not_agreed", days: 3, actions: [{ type: "email" }] } },
  { name: "Tell me about every sign-up", flow: { name: "New sign-up alert", trigger: "signup", actions: [{ type: "notify", subject: "New sign-up: {{email}}", body: "{{email}} just signed up." }] } },
  { name: "Post new mail to Slack", flow: { name: "Inbox to Slack", trigger: "inbox_received", actions: [{ type: "slack", text: "New email from {{from}}: {{subject}}" }] } },
  { name: "Post Pro joins to Discord", flow: { name: "Pro joins to Discord", trigger: "waitlist_pro", actions: [{ type: "discord", text: "{{email}} joined the Pro waitlist. {{pro_left}} places left." }] } },
  { name: "Send sign-ups to a webhook", flow: { name: "Sign-ups to a webhook", trigger: "signup", actions: [{ type: "webhook" }] } },
  { name: "Give Pro when tagged beta", flow: { name: "Beta tag gives Pro", trigger: "tag_added", tag: "beta", actions: [{ type: "license", plan: "pro", days: 60 }, { type: "email" }] } },
  { name: "Follow up a week after sign-up", flow: { name: "One week in", trigger: "signup", actions: [{ type: "wait", days: 7 }, { type: "email", subscribers: true }] } },
];
const VARS = "{{email}} {{plan}} {{waitlist}} {{license_until}} {{pro_left}} {{tag}} {{from}} {{subject}} {{message}}";

function StepEditor({ s, spec, set }: { s: Step; spec: { name: string; fields: string[] }; set: (s: Step) => void }) {
  const up = (k: keyof Step, v: unknown) => set({ ...s, [k]: v });
  const f = new Set(spec.fields);
  return (
    <div className="crm-stack">
      {f.has("subject") ? <Input label="Subject" value={s.subject || ""} onChange={(e) => up("subject", e.target.value)} maxLength={150} /> : null}
      {f.has("body") ? (
        <div className="crm-split">
          <InputArea label="Message" description="Markdown" className="crm-md crm-md-short" value={s.body || ""} onChange={(e) => up("body", e.target.value)} />
          <MailPreview subject={s.subject || ""} body={s.body || ""} kind={s.subscribers ? "newsletter" : "account"} image={s.image} />
        </div>
      ) : null}
      {f.has("image") ? <ImagePicker value={s.image || ""} onChange={(v) => up("image", v)} /> : null}
      {f.has("subscribers") ? <Checkbox label="Only if they get product updates (for nudges and promotions)" checked={!!s.subscribers}
        onCheckedChange={(c) => up("subscribers", c === true)} /> : null}
      {f.has("url") ? <Input label={s.type === "slack" ? "Slack webhook address" : s.type === "discord" ? "Discord webhook address" : "Webhook address"}
        placeholder={s.type === "slack" ? "https://hooks.slack.com/services/…" : s.type === "discord" ? "https://discord.com/api/webhooks/…" : "https://…"}
        description={s.type === "webhook" ? "Gets a POST with the flow, the trigger, the user and the values as JSON." : undefined}
        value={s.url || ""} onChange={(e) => up("url", e.target.value)} /> : null}
      {f.has("text") ? <InputArea label={s.type === "note" ? "Note" : "Text"} rows={3} value={s.text || ""} onChange={(e) => up("text", e.target.value)} /> : null}
      {f.has("tag") ? <Input label="Tag" value={s.tag || ""} onChange={(e) => up("tag", e.target.value.trim().toLowerCase())} /> : null}
      <div className="crm-row">
        {f.has("plan") ? <Select label="Plan" value={s.plan || "pro"} onValueChange={(v) => up("plan", String(v))} items={{ pro: "Pro", basic: "Basic" }} /> : null}
        {f.has("days") ? <div className="crm-num"><Input label={s.type === "wait" ? "Days" : "For days"} type="number" min={0} value={String(s.days ?? 0)}
          description={s.type === "wait" ? undefined : "0 means no end"} onChange={(e) => up("days", Number(e.target.value))} /></div> : null}
      </div>
    </div>
  );
}

function Editor({ start, data, onDone }: { start: Flow; data: Data; onDone: () => void }) {
  const toasts = useKumoToastManager();
  const [f, setF] = useState<Flow>(start);
  const [busy, setBusy] = useState("");
  const [who, setWho] = useState("");
  const trig = data.triggers.find((t) => t.id === f.trigger);
  const groups = (items: { id: string; group: string; name: string }[]) => Object.fromEntries(items.map((t) => [t.id, `${t.group}: ${t.name}`]));
  const setStep = (i: number, s: Step) => setF({ ...f, actions: f.actions.map((x, j) => (j === i ? s : x)) });
  const move = (i: number, d: number) => {
    const a = [...f.actions];
    [a[i], a[i + d]] = [a[i + d], a[i]];
    setF({ ...f, actions: a });
  };
  const save = async (enabled = f.enabled) => {
    setBusy("save");
    try {
      const r = await crm<{ flow: Flow }>("/flows", "POST", { ...f, enabled });
      setF({ ...r.flow, id: r.flow.id });
      toasts.add({ variant: "success", title: enabled ? "Flow saved and on" : "Flow saved" });
      return r.flow;
    } catch (e) { toasts.add({ variant: "error", title: (e as Error).message }); return null; } finally { setBusy(""); }
  };
  const test = async () => {
    const saved = await save();
    if (!saved) return;
    setBusy("test");
    try {
      const r = await crm<{ log: [string, string][] }>(`/flows/${saved.id}/test`, "POST");
      toasts.add({ variant: "success", title: "Test run", description: r.log.map(([t, s]) => `${data.actions[t]?.name}: ${s}`).join(" · ") });
    } catch (e) { toasts.add({ variant: "error", title: (e as Error).message }); } finally { setBusy(""); }
  };
  const preview = async () => {
    const saved = await save();
    if (!saved) return;
    const r = await crm<{ count: number; sample: string[] }>(`/flows/${saved.id}/preview`);
    setWho(trig?.event ? "Runs when it happens." : `${plural(r.count, "user")} match now${r.sample.length ? `, like ${r.sample.join(", ")}` : ""}. Turning it on doesn't run it for them, only for people who match after.`);
  };
  return (
    <div className="crm-stack">
      <LayerCard><div className="crm-card crm-stack">
        <div className="crm-row between"><h2>{f.id ? "Edit flow" : "New flow"}</h2><Button variant="ghost" onClick={onDone}>Back</Button></div>
        <Input label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </div></LayerCard>
      <LayerCard><div className="crm-card crm-stack">
        <h3 className="crm-h3 crm-first">When</h3>
        <div className="crm-row">
          <div className="crm-grow"><Select label="Trigger" value={f.trigger} onValueChange={(v) => setF({ ...f, trigger: String(v), days: data.triggers.find((t) => t.id === v)?.days ?? undefined })}
            items={groups(data.triggers)} /></div>
          {trig?.days !== null && trig?.days !== undefined ? <div className="crm-num"><Input label="Days" type="number" min={0} value={String(f.days ?? trig.days)}
            onChange={(e) => setF({ ...f, days: Number(e.target.value) })} /></div> : null}
          {f.trigger === "tag_added" ? <Input label="Tag" value={f.tag || ""} onChange={(e) => setF({ ...f, tag: e.target.value.trim().toLowerCase() })} /> : null}
        </div>
        {trig?.help ? <p className="crm-note">{trig.help}</p> : null}
        <h3 className="crm-h3">Only for users who match</h3>
        <FilterFields filter={f.conditions} set={(c) => setF({ ...f, conditions: c })} />
        <p className="crm-note">The flow runs for the one user the trigger is about, never for everyone at once. These narrow it further: {Object.keys(f.conditions || {}).length
          ? `only when that user is ${describe(f.conditions)}` : "empty means any user it happens to"}.</p>
      </div></LayerCard>
      {f.actions.map((s, i) => {
        const spec = data.actions[s.type];
        return (
          <LayerCard key={i}><div className="crm-card crm-stack">
            <div className="crm-row between">
              <h3 className="crm-h3 crm-first">{i + 1}. {spec?.name}</h3>
              <div className="crm-row">
                <Button variant="ghost" size="sm" disabled={i === 0} onClick={() => move(i, -1)}>Up</Button>
                <Button variant="ghost" size="sm" disabled={i === f.actions.length - 1} onClick={() => move(i, 1)}>Down</Button>
                <Button variant="ghost" size="sm" onClick={() => setF({ ...f, actions: f.actions.filter((_, j) => j !== i) })}>Remove</Button>
              </div>
            </div>
            {spec ? <StepEditor s={s} spec={spec} set={(x) => setStep(i, x)} /> : null}
          </div></LayerCard>
        );
      })}
      <LayerCard><div className="crm-card crm-stack">
        <div className="crm-row">
          <div className="crm-grow"><Select label="Add a step" value="" onValueChange={(v) => v && setF({ ...f, actions: [...f.actions, { type: String(v), ...(v === "wait" ? { days: 1 } : {}) }] })}
            items={{ "": "Choose…", ...groups(Object.entries(data.actions).map(([id, a]) => ({ id, ...a }))) }} /></div>
        </div>
        <p className="crm-note">In emails and posts you can use {VARS}.</p>
      </div></LayerCard>
      <LayerCard><div className="crm-card crm-stack">
        <div className="crm-row">
          <Button variant="secondary" loading={busy === "save"} onClick={() => save()}>Save</Button>
          <Button variant="secondary" loading={busy === "test"} disabled={!f.actions.length} onClick={test}>Test with me</Button>
          <Button variant="ghost" onClick={preview}>Who matches now</Button>
          <div className="crm-grow" />
          <Switch label={f.enabled ? "On" : "Off"} checked={f.enabled} onClick={async () => { const r = await save(!f.enabled); if (r) setF({ ...r, id: r.id }); }} />
        </div>
        {who ? <p className="crm-note">{who}</p> : null}
        <p className="crm-note">"Test with me" sends the emails to you and real posts to Slack, Discord or the webhook. Steps that change data are skipped.
          {data.sending ? "" : " Flows don't run while sending is off."}</p>
      </div></LayerCard>
    </div>
  );
}

export function Flows() {
  const toasts = useKumoToastManager();
  const { data, error, load } = useLoad<Data>("/flows");
  const [open, setOpen] = useState<Flow | null>(null);
  if (error) return <Failed error={error} retry={load} />;
  if (!data) return <p className="crm-note"><Loader /> Loading</p>;
  if (open) return <Editor start={open} data={data} onDone={() => { setOpen(null); load(); }} />;
  const name = (id: string) => data.triggers.find((t) => t.id === id)?.name || id;
  const blank: Flow = { name: "New flow", trigger: "signup", enabled: false, conditions: {}, actions: [] };
  const remove = async (f: Flow) => {
    await crm(`/flows/${f.id}`, "DELETE").then(() => { toasts.add({ variant: "success", title: "Flow deleted" }); load(); }, (e) => toasts.add({ variant: "error", title: e.message }));
  };
  return (
    <div className="crm-stack">
      <LayerCard><div className="crm-card crm-stack">
        <div className="crm-row between">
          <div><h2>Flows</h2><p className="crm-note">Automations: when something happens, run steps. Checked every 10 minutes; events like approvals and new mail run at once.</p></div>
          <div className="crm-row">
            <Button variant="secondary" onClick={async () => { const r = await crm<{ ran: number }>("/flows/run", "POST"); toasts.add({ variant: "success", title: `Ran ${plural(r.ran, "flow")}` }); load(); }}>Run now</Button>
            <Button variant="primary" onClick={() => setOpen(blank)}>New flow</Button>
          </div>
        </div>
        {!data.sending ? <p className="crm-error">Sending is off, so flows don't run.</p> : null}
        {!data.flows.length ? <p className="crm-note">No flows yet. Start from one below or make your own.</p> : data.flows.map((f) => (
          <div key={f.id} className="crm-flow">
            <div className="crm-grow">
              <b>{f.name}</b> <span className={`crm-chip${f.enabled ? " ok" : ""}`}>{f.enabled ? "On" : "Off"}</span>
              <span className="crm-sub">When: {name(f.trigger)}{f.trigger === "tag_added" && f.tag ? ` "${f.tag}"` : ""}
                {Object.keys(f.conditions || {}).length ? `, for ${describe(f.conditions)}` : ""} · {f.actions.map((a) => data.actions[a.type]?.name).join(", then ") || "no steps"}</span>
              <span className="crm-sub">{plural(f.runs || 0, "run")}{f.last_run_at ? `, last ${day(f.last_run_at)}` : ""}{f.last_error ? ` · Last error: ${f.last_error}` : ""}</span>
            </div>
            <Button variant="secondary" size="sm" onClick={() => setOpen(f)}>Edit</Button>
            <Button variant="ghost" size="sm" onClick={() => remove(f)}>Delete</Button>
          </div>
        ))}
      </div></LayerCard>
      <LayerCard><div className="crm-card crm-stack">
        <div><h2>Quick starts</h2><p className="crm-note">A flow set up with its trigger and steps. Emails start empty for you to write.</p></div>
        <div className="crm-quick">
          {QUICK.map((q) => (
            <button key={q.name} type="button" className="crm-quick-item" onClick={() => setOpen({ enabled: false, conditions: {}, ...q.flow })}>
              <b>{q.name}</b><span className="crm-sub">{name(q.flow.trigger)} → {q.flow.actions.map((a) => data.actions[a.type]?.name).join(", ")}</span>
            </button>
          ))}
        </div>
      </div></LayerCard>
    </div>
  );
}
