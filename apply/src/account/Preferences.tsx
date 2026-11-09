// /account/preferences: what the reader wants, as opposed to what they can
// do (Resume skills). One row per thing: its value in a line, and opened,
// the control for that one value with Save. Opening a row is not a
// commitment: Cancel and closing both go back to what was last saved.
// Every save PUTs the whole profile, skills included, so this page and
// Resume skills can't wipe each other.
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { FieldLegend, FieldSet } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { LoadingButton, SelectField, TextField } from "../fields";
import { CaretRight } from "@phosphor-icons/react";
import { useUnsaved } from "../unsaved";
import { Workspace } from "../site/Workspace";
import { cadenceSummary, DAY_NAMES, PROFILE_FAILED, placeSummary, plural, useProfile, WORKPLACE_LABELS, zoneLabel, zones, type Cadence, type Profile } from "./data";
import { PlacePicker, useLocationOptions, WORKPLACE } from "./Alerts";
import { Card, ERROR, FORM, gate, LABEL, Loading, NOTE, Picker, ROW, SettingsNav, STACK, TEXT } from "./ui";

type Row = "workplace" | "location" | "cadence";
type Prefs = Pick<Profile, "workplace" | "country" | "city" | "cadence" | "digest_time" | "digest_tz" | "digest_day">;
const pick = (p: Profile): Prefs => ({ workplace: [...p.workplace], country: [...p.country], city: [...p.city], cadence: p.cadence,
  digest_time: p.digest_time, digest_tz: p.digest_tz, digest_day: p.digest_day });

function Preferences({ profile, save, onEditing }: {
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
    <div className={ROW}>
      <LoadingButton loading={busy} onClick={submit}>Save</LoadingButton>
      <Button variant="outline" onClick={cancel}>Cancel</Button>
      {clear ? <Button variant="ghost" onClick={clear}>Clear</Button> : null}
      {error ? <span className={ERROR} role="status">{error}</span> : null}
    </div>
  );
  const shown = open ? draft : pick(profile);
  const workplaceText = shown.workplace.length ? shown.workplace.map((w) => WORKPLACE_LABELS[w] || w).join(", ") : "Any";
  const zoneList = zones(draft.digest_tz);
  const zoneItems = Object.fromEntries(zoneList.map((z) => [z, zoneLabel(z)]));

  return (
    <div className={STACK}>
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
          <FieldSet>
            <FieldLegend className="sr-only">Alert intervals</FieldLegend>
            <RadioGroup value={draft.cadence} onValueChange={(v) => setDraft((d) => ({ ...d, cadence: v as Cadence }))}>
              {([["instant", "Instant"], ["daily", "Daily at"], ["weekly", "Weekly at"]] as const).map(([v, l]) => (
                <div key={v} className="flex items-center gap-2"><RadioGroupItem value={v} id={`cadence-${v}`} /><Label htmlFor={`cadence-${v}`} className="font-normal">{l}</Label></div>
              ))}
            </RadioGroup>
          </FieldSet>
          {draft.cadence !== "instant" ? (
            <div className={FORM}>
              {draft.cadence === "weekly" ? (
                <SelectField label="Day" value={String(draft.digest_day)}
                  onValueChange={(v) => setDraft((d) => ({ ...d, digest_day: Number(v) }))}
                  items={Object.fromEntries(DAY_NAMES.map((n, i) => [String(i), n]))} />
              ) : null}
              <TextField label="Time" type="time" value={draft.digest_time}
                onChange={(e) => { const v = e.target.value; if (/^\d\d:\d\d$/.test(v)) setDraft((d) => ({ ...d, digest_time: v })); }} />
              <SelectField label="Time zone" value={draft.digest_tz}
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
    <div className="border-t first:border-t-0">
      <button type="button" aria-expanded={open} aria-controls={`pref-edit-${id}`} onClick={onToggle}
        className="flex w-full cursor-pointer items-center justify-between gap-3 border-0 bg-transparent px-0 py-3 text-left font-[inherit] text-[length:inherit] text-[color:inherit] focus-visible:rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        <span className={TEXT}>
          <span className={LABEL}>{label}</span>
          <span className={NOTE}>{summary}</span>
        </span>
        <CaretRight className={`flex-none text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} size={16} aria-hidden="true" />
      </button>
      {open ? <div className={`${STACK} pb-4`} id={`pref-edit-${id}`}>{children}</div> : null}
    </div>
  );
}

// The title row's one-line summary of the profile.
function line(p: Profile) {
  return [
    p.workplace.length ? p.workplace.map((w) => WORKPLACE_LABELS[w] || w).join(", ") : "",
    p.country.length + p.city.length ? plural(p.country.length + p.city.length, "place") : "",
    ({ daily: `daily at ${p.digest_time}`, weekly: `weekly on ${DAY_NAMES[p.digest_day] || "Monday"}` } as Record<string, string>)[p.cadence] || "instant alerts",
  ].filter(Boolean).join(" · ");
}

function PreferencesPage() {
  const { profile, put, failed } = useProfile();
  const [open, setOpen] = useState(false);
  // A row open to edit is not lost to a stray click on a link: the
  // browser asks before leaving. Nothing here mounts the save dialog.
  useUnsaved("prefs", open, async () => false);
  return (
    <Workspace current="settings" title="Preferences" note={profile ? line(profile) : ""}>
      <SettingsNav />
      {failed ? <Card note={PROFILE_FAILED} /> : profile ? <Preferences profile={profile} onEditing={setOpen} save={async (prefs) => { await put(prefs); }} /> : <Loading />}
    </Workspace>
  );
}

export default gate("settings", PreferencesPage);
