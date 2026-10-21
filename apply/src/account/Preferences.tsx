// Preferences: what the reader wants, as opposed to what they can do
// (Skills). One row per thing: its value in a line, and opened, the
// control for that one value with Save. Opening a row is not a
// commitment: Cancel and closing both go back to what was last saved.
// Every save PUTs the whole profile, skills included, so this tab and
// Skills can't wipe each other.
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { Radio } from "@cloudflare/kumo/components/radio";
import { Select } from "@cloudflare/kumo/components/select";
import { CaretRight } from "@phosphor-icons/react";
import { cadenceSummary, DAY_NAMES, placeSummary, WORKPLACE_LABELS, zoneLabel, zones, type Cadence, type Profile } from "./data";
import { PlacePicker, useLocationOptions, WORKPLACE } from "./Alerts";
import { Picker, Card } from "./ui";

type Row = "workplace" | "location" | "cadence";
type Prefs = Pick<Profile, "workplace" | "country" | "city" | "cadence" | "digest_time" | "digest_tz" | "digest_day">;
const pick = (p: Profile): Prefs => ({ workplace: [...p.workplace], country: [...p.country], city: [...p.city], cadence: p.cadence,
  digest_time: p.digest_time, digest_tz: p.digest_tz, digest_day: p.digest_day });

export function Preferences({ profile, save, onEditing }: {
  profile: Profile; save: (prefs: Prefs) => Promise<void>; onEditing: (open: boolean) => void;
}) {
  const [open, setOpen] = useState<Row | null>(null);
  const [draft, setDraft] = useState<Prefs>(() => pick(profile));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const places = useLocationOptions();
  useEffect(() => { onEditing(!!open); }, [open, onEditing]);
  useEffect(() => () => onEditing(false), [onEditing]);

  const toggle = (row: Row) => { setDraft(pick(profile)); setError(""); setOpen(open === row ? null : row); };
  const cancel = () => { setDraft(pick(profile)); setError(""); setOpen(null); };
  const submit = async () => {
    setBusy(true);
    try {
      await save(draft);
      setOpen(null);
      setError("");
    } catch (err) {
      setError((err as Error).message || "Could not save.");
    } finally {
      setBusy(false);
    }
  };
  const actions = (clear?: () => void) => (
    <div className="oj-row">
      <Button size="sm" variant="primary" loading={busy} onClick={submit}>Save</Button>
      <Button size="sm" variant="ghost" onClick={cancel}>Cancel</Button>
      {clear ? <Button size="sm" variant="ghost" onClick={clear}>Clear</Button> : null}
      {error ? <span className="oj-error" role="status">{error}</span> : null}
    </div>
  );
  const shown = open ? draft : pick(profile);
  const workplaceText = shown.workplace.length ? shown.workplace.map((w) => WORKPLACE_LABELS[w] || w).join(", ") : "Any";
  const zoneList = zones(draft.digest_tz);
  const zoneItems = Object.fromEntries(zoneList.map((z) => [z, zoneLabel(z)]));

  return (
    <div className="oj-stack">
      <Card title="What you're looking for">
        <PrefRow id="workplace" label="Workplace" summary={workplaceText} open={open === "workplace"} onToggle={() => toggle("workplace")}>
          <Picker label="Workplace" placeholder="Workplace" options={WORKPLACE} value={draft.workplace} onChange={(v) => setDraft((d) => ({ ...d, workplace: v }))} />
          {actions(() => setDraft((d) => ({ ...d, workplace: [] })))}
        </PrefRow>
        <PrefRow id="location" label="Locations" summary={placeSummary(shown, places.labels)} open={open === "location"} onToggle={() => toggle("location")}>
          <PlacePicker options={places.options} country={draft.country} city={draft.city}
            onChange={(country, city) => setDraft((d) => ({ ...d, country, city }))} />
          {actions(() => setDraft((d) => ({ ...d, country: [], city: [] })))}
        </PrefRow>
      </Card>
      <Card title="Alert settings">
        <PrefRow id="cadence" label="Alert intervals" summary={cadenceSummary({ ...profile, ...shown })} open={open === "cadence"} onToggle={() => toggle("cadence")}>
          <Radio.Group legend="Alert intervals" value={draft.cadence} onValueChange={(v) => setDraft((d) => ({ ...d, cadence: v as Cadence }))}>
            <Radio.Item value="instant" label="Instant" />
            <Radio.Item value="daily" label="Daily at" />
            <Radio.Item value="weekly" label="Weekly at" />
          </Radio.Group>
          {draft.cadence !== "instant" ? (
            <div className="oj-form">
              {draft.cadence === "weekly" ? (
                <Select className="oj-select" label="Day" value={String(draft.digest_day)}
                  onValueChange={(v) => setDraft((d) => ({ ...d, digest_day: Number(v) }))}
                  items={Object.fromEntries(DAY_NAMES.map((n, i) => [String(i), n]))} />
              ) : null}
              <Input label="Time" type="time" value={draft.digest_time}
                onChange={(e) => { const v = e.target.value; if (/^\d\d:\d\d$/.test(v)) setDraft((d) => ({ ...d, digest_time: v })); }} />
              <Select className="oj-select" label="Time zone" value={draft.digest_tz}
                onValueChange={(v) => setDraft((d) => ({ ...d, digest_tz: String(v) }))} items={zoneItems} />
            </div>
          ) : null}
          {actions()}
        </PrefRow>
      </Card>
    </div>
  );
}

function PrefRow({ id, label, summary, open, onToggle, children }: {
  id: string; label: string; summary: string; open: boolean; onToggle: () => void; children: ReactNode;
}) {
  return (
    <div className={`oj-pref${open ? " is-open" : ""}`}>
      <button type="button" className="oj-pref-head" aria-expanded={open} aria-controls={`pref-edit-${id}`} onClick={onToggle}>
        <span className="oj-pref-text">
          <span className="oj-pref-label">{label}</span>
          <span className="oj-note">{summary}</span>
        </span>
        <CaretRight className="oj-pref-chev" size={16} aria-hidden="true" />
      </button>
      {open ? <div className="oj-pref-edit oj-stack" id={`pref-edit-${id}`}>{children}</div> : null}
    </div>
  );
}
