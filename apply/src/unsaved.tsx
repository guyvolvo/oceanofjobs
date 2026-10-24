// Forms with edits not yet saved, each with its own save. A tab switch
// asks first (useLeaveGuard), and closing or leaving the page gets the
// browser's own warning. Its own module so the account page can guard its
// two top tabs without loading the auto apply dashboard.
import { useEffect, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";

const unsaved = new Map<string, () => Promise<boolean>>();
addEventListener("beforeunload", (e) => {
  if (unsaved.size) { e.preventDefault(); e.returnValue = ""; }
});

// save resolves true once the edits are stored, false when they weren't.
export function useUnsaved(key: string, dirty: boolean, save: () => Promise<boolean>) {
  const latest = useRef(save);
  latest.current = save;
  useEffect(() => {
    if (!dirty) return;
    unsaved.set(key, () => latest.current());
    return () => { unsaved.delete(key); };
  }, [key, dirty]);
}

export function useLeaveGuard() {
  const [next, setNext] = useState<(() => void) | null>(null);
  const [saving, setSaving] = useState(false);
  const guard = (go: () => void) => (unsaved.size ? setNext(() => go) : go());
  const leave = () => { const go = next; setNext(null); go?.(); };
  const save = async () => {
    setSaving(true);
    const ok = (await Promise.all([...unsaved.values()].map((s) => s()))).every(Boolean);
    setSaving(false);
    // A failed save stays put: its own error is already on screen.
    if (ok) leave(); else setNext(null);
  };
  const discard = () => { unsaved.clear(); leave(); };
  const dialog = (
    <Dialog.Root open={!!next} onOpenChange={(o) => { if (!o) setNext(null); }}>
      <Dialog className="oj-dialog">
        <Dialog.Title className="oj-card-title">Save your changes?</Dialog.Title>
        <Dialog.Description className="oj-note">You changed some settings on this tab and haven't saved them yet.</Dialog.Description>
        <div className="oj-row oj-dialog-actions">
          <Button variant="ghost" onClick={() => setNext(null)}>Keep editing</Button>
          <Button variant="secondary" onClick={discard}>Discard</Button>
          <Button variant="primary" loading={saving} onClick={save}>Save</Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
  return { guard, dialog };
}
