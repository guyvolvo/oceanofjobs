// Forms with edits not yet saved, each with its own save. Every link
// between workspace pages is a full page load, so leaving or closing the
// page gets the browser's own warning. An in-page action that would drop
// the edits asks first through useLeaveGuard, which can run the saves.
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useReturnFocus } from "./fields";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";

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
  const back = useReturnFocus(!!next);
  const dialog = (
    <Dialog open={!!next} onOpenChange={(o) => { if (!o) setNext(null); }}>
      <DialogContent onCloseAutoFocus={back}>
        <DialogTitle>Save your changes?</DialogTitle>
        <DialogDescription>You changed some settings on this tab and haven't saved them yet.</DialogDescription>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setNext(null)}>Keep editing</Button>
          <Button variant="outline" onClick={discard}>Discard</Button>
          <Button disabled={saving} onClick={save}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
  return { guard, dialog };
}
