// /account/skills: a CV read in this tab (never uploaded), the skills
// found as chips, and Save. Only the list someone saves reaches the
// server.
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { LoadingButton } from "../fields";
import { UploadSimple, X } from "@/components/icons";
import { Workspace } from "../site/Workspace";
import { plural } from "../shared";
import { useUnsaved } from "../unsaved";
import { boardLink, EMPTY_PROFILE, PROFILE_FAILED, readCv, skillsIn, useProfile } from "./data";
import { Card, ERROR, gate, NOTE, ROW, SettingsNav, STACK, TITLE } from "./ui";

const CHIP = "inline-flex cursor-pointer items-center gap-1.5 rounded-full border bg-secondary px-2.5 py-1 font-[inherit] text-[length:inherit] text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

function Skills({ skills, setSkills, onPick, onFile, fileName, cvStatus, save, saving, matchesHref }: {
  skills: string[]; setSkills: (s: string[]) => void; onPick: () => void; onFile: (f: File) => void;
  fileName: string; cvStatus: { text: string; error: boolean } | null; save: () => void; saving: boolean; matchesHref: string;
}) {
  const [dragging, setDragging] = useState(false);
  return (
    <div className={STACK}>
      <Card>
        <div className={cn("flex flex-col items-start gap-2 rounded-lg border border-dashed p-6", dragging ? "border-ring bg-[var(--ooj-green-tint)]" : "border-input/30 bg-muted")}
          onDragEnter={(e) => { e.preventDefault(); setDragging(true); }}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
          onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer?.files?.[0]; if (f) onFile(f); }}>
          <p className={TITLE}>Drop a resume here</p>
          <p className={NOTE}>PDF or plain text. Read in your browser. Only the skills you save are stored.</p>
          <div className={ROW}>
            <Button variant="outline" onClick={onPick}>Choose a file</Button>
            {fileName ? <span className={`${NOTE} [overflow-wrap:anywhere]`}>{fileName}</span> : null}
          </div>
        </div>
        <p className={cvStatus?.error ? ERROR : NOTE} aria-live="polite">{cvStatus?.text || ""}</p>
      </Card>

      {skills.length ? (
        <Card title="Skills found">
          <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="Your skills">
            {skills.map((s) => (
              <li key={s}>
                <button type="button" className={CHIP} aria-label={`Remove ${s}`} title="Remove"
                  onClick={() => setSkills(skills.filter((x) => x !== s))}>
                  {s}<X size={12} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          <div className={ROW}>
            <LoadingButton loading={saving} onClick={save}>Save to profile</LoadingButton>
            <Button variant="ghost" asChild><a href={matchesHref}>See matches</a></Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function SkillsPage() {
  const { profile, spec, put, failed } = useProfile();
  const [skills, setSkills] = useState<string[]>([]);
  const [cv, setCv] = useState<{ name: string; status: { text: string; error: boolean } | null }>({ name: "", status: null });
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // Edits start from the saved list once it arrives.
  useEffect(() => { if (profile) setSkills(profile.skills); }, [profile]);

  const save = async () => {
    setSaving(true);
    try {
      await put({ skills });
      toast.success("Saved.");
      return true;
    } catch (err) {
      toast.error((err as Error).message || "Could not save.");
      return false;
    } finally {
      setSaving(false);
    }
  };
  // The CV is read in this tab and never uploaded.
  const status = (text: string, error = false) => setCv((c) => ({ ...c, status: { text, error } }));
  const takeCv = async (file: File) => {
    setCv({ name: file.name, status: { text: "Reading…", error: false } });
    try {
      const text = await readCv(file);
      // No rules is "this didn't load", not "your CV has no skills".
      if (!spec) return status("The skill list did not load, so nothing can be matched. Reload the page and try again.", true);
      const found = skillsIn(text, spec);
      // Merge rather than replace: a second CV, or a skill added by hand,
      // is not silently lost.
      setSkills((s) => [...new Set([...s, ...found])].slice(0, 40));
      status(found.length ? `Found ${plural(found.length, "skill")}.`
        // No text at all is a scanned image, not a CV without skills.
        : text.trim() ? "No known skills found in that file." : "No text in that file. A scanned image cannot be read.");
    } catch {
      status("Could not read that file. PDF or plain text.", true);
    }
  };
  const pick = () => fileRef.current?.click();
  // Skills found in a CV live only here until Save: leaving asks first.
  useUnsaved("skills", !!profile && skills.join(",") !== profile.skills.join(","), save);

  return (
    <Workspace current="settings" title="Resume skills" note={skills.length ? `${plural(skills.length, "skill")} matched against every listing` : "No skills yet"}
      actions={<Button variant="outline" onClick={pick}><UploadSimple />Scan a resume</Button>}>
      <SettingsNav />
      <input ref={fileRef} type="file" accept=".pdf,.txt,.md,application/pdf,text/plain" hidden aria-label="Choose a resume file"
        onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) await takeCv(f); }} />
      {failed ? <Card note={PROFILE_FAILED} /> : <Skills skills={skills} setSkills={setSkills} onPick={pick} onFile={takeCv} fileName={cv.name} cvStatus={cv.status}
        save={save} saving={saving} matchesHref={boardLink(profile || EMPTY_PROFILE, skills)} />}
    </Workspace>
  );
}

export default gate("settings", SkillsPage);
