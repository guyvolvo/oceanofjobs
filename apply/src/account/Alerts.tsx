// /account/alerts: the list (edit, pause, delete) and the one create/edit
// form, which the overview borrows while its card has it open. The same
// rules as app.js's renderAlertsList and wireAlertCreateForm, which drove
// the old page.
import { useCallback, useEffect, useState } from "react";
import { Input } from "@cloudflare/kumo/components/input";
import { Button } from "@cloudflare/kumo/components/button";
import { Switch } from "@cloudflare/kumo/components/switch";
import { Table } from "@cloudflare/kumo/components/table";
import { Loader } from "@cloudflare/kumo/components/loader";
import { PencilSimple, X } from "@phosphor-icons/react";
import { api, send, ApiError } from "../api";
import { useUnsaved } from "../unsaved";
import { Workspace } from "../site/Workspace";
import { companyOptions, departmentOptions, describeAlertFilter, locationOptions, plural, SENIORITY_LABELS, useAlerts, useProfile, WORKPLACE_LABELS,
  type Alert, type Option, type Profile } from "./data";
import { ACTIONS_CELL, Card, ConfirmButton, ERROR, FORM, gate, JOB, NOTE, Picker, ROW, STACK, SUB, TABLE, TITLE } from "./ui";

export type AlertDraft = { search: string; department: string[]; seniority: string[]; company: string[]; country: string[]; city: string[]; workplace: string[] };
const BLANK: AlertDraft = { search: "", department: [], seniority: [], company: [], country: [], city: [], workplace: [] };
const list = (v?: string) => (v ? String(v).split(",").filter(Boolean) : []);

// The form's state, kept by the page so the list and the form agree.
export function useAlertForm(profile: Profile | null, reload: () => Promise<unknown>) {
  const [draft, setDraft] = useState<AlertDraft>(BLANK);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);

  // A new alert starts from the reader's workplace and places in
  // Preferences, and only a blank one: never over what they typed.
  const withPrefs = useCallback((d: AlertDraft): AlertDraft => {
    if (!profile || d.workplace.length || d.country.length || d.city.length) return d;
    return { ...d, workplace: [...profile.workplace], country: [...profile.country], city: [...profile.city] };
  }, [profile]);
  useEffect(() => { if (!editing) setDraft(withPrefs); }, [withPrefs, editing]);

  const reset = () => { setEditing(null); setDraft(withPrefs({ ...BLANK })); };
  const say = (text: string, error = false) => {
    setFeedback({ text, error });
    setTimeout(() => setFeedback((f) => (f?.text === text ? null : f)), 3000);
  };

  // A saved filter back into the form. israel_only maps exactly onto
  // country=IL, so an old alert keeps its meaning when edited.
  const fill = (filter: Record<string, string>) => {
    const country = list(filter.country);
    if (filter.israel_only === "1" && !country.includes("IL")) country.unshift("IL");
    setDraft({ search: filter.search || filter.q || "", department: list(filter.department), seniority: list(filter.seniority),
      company: list(filter.company), country, city: list(filter.city), workplace: list(filter.workplace) });
  };
  const edit = (a: Alert) => { setEditing(a.alert_id); fill(a.filter || {}); };

  const submit = async (): Promise<boolean> => {
    const raw: Record<string, string> = {
      search: draft.search.trim(), department: draft.department.join(","), seniority: draft.seniority.join(","),
      company: draft.company.join(","), country: draft.country.join(","), city: draft.city.join(","), workplace: draft.workplace.join(","),
    };
    const filter = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== ""));
    const id = editing;
    setBusy(true);
    try {
      if (id) await api(`/me/alerts/${id}`, send("PATCH", { filter }));
      else await api("/me/alerts", send("POST", { filter }));
      say(id ? "Alert saved." : "Alert created.");
      reset();
      await reload().catch(() => {});
      return true;
    } catch (err) {
      // A 400 is the API saying why in words ("you can have up to 5
      // alerts..."); a 5xx or a dropped connection is not worth quoting.
      const m = err instanceof ApiError && err.status === 400 && err.message ? `${err.message[0].toUpperCase()}${err.message.slice(1)}.` : null;
      say(m || (id ? "Couldn't save the alert. Try again." : "Couldn't create the alert. Try again."), true);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return { draft, setDraft, editing, edit, fill, reset, submit, busy, feedback };
}
export type AlertForm = ReturnType<typeof useAlertForm>;

// The pickers' lists, fetched once per visit, when a form first shows.
let options: Promise<{ department: Option[]; location: Option[]; company: Option[] }> | null = null;
const placeLabels: Record<string, string> = {};
function loadOptions() {
  options ??= Promise.all([
    departmentOptions().catch(() => []),
    locationOptions(placeLabels).catch(() => []),
    companyOptions().catch(() => []),
  ]).then(([department, location, company]) => ({ department, location, company }));
  return options;
}

const SENIORITY = Object.entries(SENIORITY_LABELS).map(([value, label]) => ({ value, label }));
export const WORKPLACE = Object.entries(WORKPLACE_LABELS).map(([value, label]) => ({ value, label }));

// One picker for countries and their cities. The two are separate filters
// that AND together on the server, so ticking a country does not tick its
// cities.
export function PlacePicker({ options, country, city, onChange }: {
  options: Option[]; country: string[]; city: string[]; onChange: (country: string[], city: string[]) => void;
}) {
  const kind = new Map(options.map((o) => [o.value, o.kind]));
  return (
    <Picker label="Locations" placeholder="Locations" options={options} value={[...country, ...city]}
      onChange={(v) => {
        const isCountry = (x: string) => kind.get(x) === "country" || (!kind.has(x) ? country.includes(x) || /^[A-Z]{2}$/.test(x) : false);
        onChange(v.filter(isCountry), v.filter((x) => !isCountry(x)));
      }} />
  );
}

export function useLocationOptions() {
  const [opts, setOpts] = useState<Option[]>([]);
  useEffect(() => { loadOptions().then((o) => setOpts(o.location)); }, []);
  return { options: opts, labels: placeLabels };
}

export function AlertFormView({ form, onDone, autoFocus }: { form: AlertForm; onDone?: () => void; autoFocus?: boolean }) {
  const [opts, setOpts] = useState<{ department: Option[]; location: Option[]; company: Option[] } | null>(null);
  useEffect(() => { loadOptions().then(setOpts); }, []);
  const { draft, setDraft, editing } = form;
  const set = <K extends keyof AlertDraft>(k: K, v: AlertDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  return (
    <form className={STACK} id="alert-create" noValidate
      onSubmit={async (e) => { e.preventDefault(); if (await form.submit()) onDone?.(); }}>
      <h3 className={TITLE} id="alert-form-title">{editing ? "Edit alert" : "New alert"}</h3>
      <div className={FORM}>
        <Input label="Keywords" id="alert-f-search" name="search" autoComplete="off" placeholder="e.g. devops" autoFocus={autoFocus}
          value={draft.search} onChange={(e) => set("search", e.target.value)} />
        <Picker label="Categories" placeholder="Categories" options={opts?.department || []} value={draft.department} onChange={(v) => set("department", v)} />
        <Picker label="Levels" placeholder="Levels" options={SENIORITY} value={draft.seniority} onChange={(v) => set("seniority", v)} />
        <Picker label="Companies" placeholder="Companies" options={opts?.company || []} value={draft.company} onChange={(v) => set("company", v)} limit={50} />
        <PlacePicker options={opts?.location || []} country={draft.country} city={draft.city}
          onChange={(country, city) => setDraft((d) => ({ ...d, country, city }))} />
        <Picker label="Workplace" placeholder="Workplace" options={WORKPLACE} value={draft.workplace} onChange={(v) => set("workplace", v)} />
      </div>
      <div className={ROW}>
        <Button type="submit" variant="primary" loading={form.busy} id="create-alert-btn">{editing ? "Save changes" : "Create alert"}</Button>
        {editing ? <Button variant="ghost" onClick={form.reset}>Cancel</Button> : null}
        {!opts ? <span className={`${NOTE} ${ROW}`}><Loader size="sm" /> Loading the lists</span> : null}
        {form.feedback ? <span className={form.feedback.error ? ERROR : NOTE} role="status">{form.feedback.text}</span> : null}
      </div>
    </form>
  );
}

// Two alerts with the same filters would mail the same listings twice;
// the later one is marked as a duplicate of the first.
function duplicates(alerts: Alert[]): Map<string, string> {
  const seen = new Map<string, string>();
  const out = new Map<string, string>();
  for (const a of alerts) {
    const key = JSON.stringify(Object.entries(a.filter || {}).filter(([, v]) => v !== "" && v != null).map(([k, v]) => [k, String(v).toLowerCase()]).sort());
    if (seen.has(key)) out.set(a.alert_id, seen.get(key)!);
    else seen.set(key, describeAlertFilter(a.filter || {}));
  }
  return out;
}

export function useAlertActions(reload: () => Promise<unknown>) {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (id: string, init: RequestInit) => {
    setBusy(id);
    try {
      await api(`/me/alerts/${id}`, init);
      await reload();
    } catch { /* the button comes back and can be tried again */ } finally {
      setBusy(null);
    }
  };
  return {
    busy,
    toggle: (a: Alert) => run(a.alert_id, send("PATCH", { active: !a.active })),
    remove: (a: Alert) => run(a.alert_id, { method: "DELETE" }),
  };
}

const PLAIN = "cursor-pointer border-0 bg-transparent p-0 text-left font-[inherit] text-[length:inherit] focus-visible:rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-focus";

function Alerts({ alerts, error, form, reload }: {
  alerts: Alert[] | null; error: string; form: AlertForm; reload: () => Promise<unknown>;
}) {
  const act = useAlertActions(reload);
  const dup = alerts ? duplicates(alerts) : new Map();
  // An alert deleted from under an open edit leaves nothing to save to.
  useEffect(() => { if (alerts && form.editing && !alerts.some((a) => a.alert_id === form.editing)) form.reset(); }, [alerts]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={STACK}>
      <Card title="Your alerts">
        {error ? <p className={NOTE}>{error}</p>
          : !alerts ? <div className={`${ROW} ${NOTE}`}><Loader /> Loading</div>
          : !alerts.length ? <p className={NOTE}>No alerts yet. Pick some filters below and create one.</p>
          : (
            <div className={TABLE}>
              <Table>
                <Table.Header>
                  <Table.Row><Table.Head>Alert</Table.Head><Table.Head>Email me</Table.Head><Table.Head><span className="sr-only">Delete</span></Table.Head></Table.Row>
                </Table.Header>
                <Table.Body>
                  {alerts.map((a) => {
                    const name = describeAlertFilter(a.filter || {});
                    return (
                      <Table.Row key={a.alert_id} variant={a.alert_id === form.editing ? "selected" : "default"}>
                        <Table.Cell>
                          <button type="button" className={`${PLAIN} ${JOB}`} title="Edit this alert" onClick={() => form.edit(a)}>{name}</button>
                          {dup.has(a.alert_id) ? <span className={SUB}>Duplicate of {dup.get(a.alert_id)}</span> : null}
                        </Table.Cell>
                        <Table.Cell className="whitespace-nowrap">
                          <Switch size="sm" checked={a.active} disabled={act.busy === a.alert_id} label={a.active ? "Active" : "Paused"}
                            aria-label={a.active ? "Alert on. Pause it" : "Alert paused. Resume it"} onClick={() => act.toggle(a)} />
                        </Table.Cell>
                        <Table.Cell className={ACTIONS_CELL}>
                          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                            {/* The form sits below the list: take the reader to it, which on a phone is off screen. */}
                            <Button variant="secondary" icon={<PencilSimple />} aria-label={`Edit alert ${name}`}
                              onClick={() => { form.edit(a); requestAnimationFrame(() => document.getElementById("alert-form-title")?.scrollIntoView({ block: "start", behavior: "smooth" })); }}>Edit</Button>
                            <ConfirmButton size="sm" variant="ghost" shape="square" aria-label={`Delete alert ${name}`} title="Delete alert"
                              disabled={act.busy === a.alert_id} onConfirm={() => act.remove(a)}><X /></ConfirmButton>
                          </span>
                        </Table.Cell>
                      </Table.Row>
                    );
                  })}
                </Table.Body>
              </Table>
            </div>
          )}
      </Card>
      <Card><AlertFormView form={form} /></Card>
    </div>
  );
}

function AlertsPage() {
  const { profile } = useProfile();
  const { alerts, error, reload } = useAlerts();
  const form = useAlertForm(profile, reload);
  // The board's "Alert me for this search" lands here with its filters.
  useEffect(() => {
    let raw: string | null = null;
    try { raw = sessionStorage.getItem("iljobs_alert_prefill"); sessionStorage.removeItem("iljobs_alert_prefill"); } catch { return; }
    if (!raw) return;
    try { form.fill(JSON.parse(raw)); } catch { /* an unreadable handoff is dropped */ }
    requestAnimationFrame(() => document.getElementById("alert-create")?.scrollIntoView({ block: "start" }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // A half-written alert is not lost to a stray click on a link: the
  // browser asks before leaving.
  useUnsaved("alert", !!form.draft.search.trim(), form.submit);
  return (
    <Workspace current="alerts" title="Alerts" note={!alerts ? "" : alerts.length ? plural(alerts.length, "alert") : "No alerts yet"}>
      <Alerts alerts={alerts} error={error} form={form} reload={reload} />
    </Workspace>
  );
}

export default gate("alerts", AlertsPage);
