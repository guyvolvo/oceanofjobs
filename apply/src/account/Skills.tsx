// Skills: a CV read in this tab (never uploaded), the skills found as
// chips, and Save. Only the list someone saves reaches the server.
import { useState } from "react";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { X } from "@phosphor-icons/react";
import { Card } from "./ui";

export function Skills({ skills, setSkills, onPick, onFile, fileName, cvStatus, save, saving, matchesHref }: {
  skills: string[]; setSkills: (s: string[]) => void; onPick: () => void; onFile: (f: File) => void;
  fileName: string; cvStatus: { text: string; error: boolean } | null; save: () => void; saving: boolean; matchesHref: string;
}) {
  const [dragging, setDragging] = useState(false);
  return (
    <div className="oj-stack">
      <Card>
        <div className={`oj-drop${dragging ? " is-dragging" : ""}`}
          onDragEnter={(e) => { e.preventDefault(); setDragging(true); }}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
          onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer?.files?.[0]; if (f) onFile(f); }}>
          <p className="oj-card-title">Drop a CV here</p>
          <p className="oj-note">PDF or plain text. Read in your browser. Only the skills you save are stored.</p>
          <div className="oj-row">
            <Button variant="secondary" onClick={onPick}>Choose a file</Button>
            {fileName ? <span className="oj-note oj-wrap">{fileName}</span> : null}
          </div>
        </div>
        <p className={cvStatus?.error ? "oj-error" : "oj-note"} aria-live="polite">{cvStatus?.text || ""}</p>
      </Card>

      {skills.length ? (
        <Card title="Skills found">
          <ul className="oj-chips" aria-label="Your skills">
            {skills.map((s) => (
              <li key={s}>
                <button type="button" className="oj-chip" aria-label={`Remove ${s}`} title="Remove"
                  onClick={() => setSkills(skills.filter((x) => x !== s))}>
                  {s}<X size={12} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          <div className="oj-row">
            <Button variant="primary" loading={saving} onClick={save}>Save to profile</Button>
            <LinkButton variant="ghost" href={matchesHref}>See matches</LinkButton>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
