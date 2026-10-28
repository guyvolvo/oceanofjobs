// The setup guide on Auto apply settings: shown until it is finished or
// skipped (POST /me/apply/onboarded), and again from "Run setup again".
// One question picks the settings, then only the steps this person still
// needs: a resume, the extension, and for full automation Auto-apply mode.
// Nothing is saved until Finish.
import { useEffect, useState, type ReactNode } from "react";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Radio } from "@cloudflare/kumo/components/radio";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { apply, send, type Plan, type Profile } from "./api";
import { connectExtension, type Ext } from "./ext";
import { ResumeField, type Resume } from "./Agent";
import { SETUP } from "./shared";
const STORE = "https://chromewebstore.google.com/detail/kihjppefdadlodaoecffiemijlielhdi";

type Choice = "control" | "balance" | "automation";
const CHOICES: [Choice, string][] = [
  ["control", "I prefer having full control over what data I send to the hiring team"],
  ["balance", "I prefer a balance of control and automation over what data I send to the hiring team"],
  ["automation", "I prefer full automation for the job application process including usage of AI to fill out blank fields on forms"],
];
type Step = "welcome" | "choose" | "resume" | "extension" | "autoapply" | "done";

export function Onboarding({ plan, ext, onDone }: { plan?: Plan; ext: Ext; onDone: () => void }) {
  const toasts = useKumoToastManager();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("welcome");
  const [choice, setChoice] = useState<Choice | null>(null);
  const [resume, setResume] = useState<Resume>(null);
  const [autoApply, setAutoApply] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    apply<{ onboarded?: boolean }>("profile").then((r) => { if (r.onboarded === false) setOpen(true); }, () => {});
    apply<{ agent: { resume: Resume } }>("agent").then((r) => setResume(r.agent.resume), () => {});
    const again = () => { setStep("welcome"); setChoice(null); setAutoApply(false); setOpen(true); };
    addEventListener(SETUP, again);
    return () => removeEventListener(SETUP, again);
  }, []);

  const paid = plan === "basic" || plan === "pro";
  const full = choice === "automation" && paid && !!resume;
  // The steps after the question, only the ones still to do.
  const steps: Step[] = ["welcome", "choose", ...(resume ? [] : ["resume" as Step]),
    ...(ext.connected ? [] : ["extension" as Step]), ...(choice === "automation" ? ["autoapply" as Step] : []), "done"];
  const at = steps.indexOf(step);
  const next = () => setStep(steps[Math.min(at + 1, steps.length - 1)]);
  const back = () => setStep(steps[Math.max(at - 1, 0)]);

  const record = (c: string) => apply("onboarded", send("POST", { choice: c }));
  const skip = async () => { setOpen(false); await record("skipped").catch(() => {}); };
  const finish = async () => {
    if (!choice) return;
    setBusy(true);
    try {
      const { profile } = await apply<{ profile: Profile }>("profile");
      const settings = { ...profile.settings, fill: full ? "full" : "half", unknowns: choice === "control" ? "skip" : "ai",
        ...(choice === "automation" && autoApply && resume ? { mode: "auto" } : {}) };
      await apply("profile", send("PUT", { profile: { ...profile, settings } }));
      await record(choice);
      toasts.add({ variant: "success", title: "Auto apply is set up" });
      setOpen(false);
      onDone();
    } catch {
      toasts.add({ variant: "error", title: "Couldn't save your settings. Try again." });
    } finally {
      setBusy(false);
    }
  };
  const connect = async () => {
    setConnecting(true);
    try { await connectExtension(); } catch { toasts.add({ variant: "error", title: "Couldn't connect the extension. Try again." }); } finally { setConnecting(false); }
  };

  const summary = choice ? [
    full ? "Fill application: Full automatic. It fills the form and submits it."
      : "Fill application: Half automatic. It fills the form, you review and submit.",
    choice === "control" ? "Questions you haven't answered: the job is skipped for you to review."
      : full ? "Questions you haven't answered: AI writes an answer and it's used."
        : "Questions you haven't answered: AI drafts an answer for you to approve.",
    `Auto-apply mode: ${choice === "automation" && autoApply && resume ? "on" : "off"}.`,
  ] : [];

  const actions = (primary: ReactNode, secondary?: ReactNode) => (
    <div className="oj-row oj-dialog-actions">{secondary}{primary}</div>
  );

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) skip(); }}>
      <Dialog className="oj-dialog oj-setup">
        {step === "welcome" ? <>
          <Dialog.Title className="oj-card-title">Set up auto apply</Dialog.Title>
          <p className="oj-note">Answer one question and we'll set up the extension for you.</p>
          {actions(<Button variant="primary" onClick={next}>Next</Button>, <Button variant="secondary" onClick={skip}>Skip</Button>)}
        </> : null}

        {step === "choose" ? <>
          <Dialog.Title className="oj-card-title">Choose your preference:</Dialog.Title>
          <Radio.Group appearance="card" value={choice ?? ""} onValueChange={(v) => setChoice(v as Choice)}>
            <Radio.Legend className="sr-only">Choose your preference</Radio.Legend>
            {CHOICES.map(([value, label]) => <Radio.Item key={value} value={value} label={label} />)}
          </Radio.Group>
          {choice === "automation" && !paid ? (
            <p className="oj-note">Submitting for you needs Basic or Pro, so on your plan the extension fills the form and you submit. <a className="oj-link" href="/pricing">Compare plans</a></p>
          ) : null}
          {actions(<Button variant="primary" disabled={!choice} onClick={next}>Next</Button>, <Button variant="secondary" onClick={back}>Back</Button>)}
        </> : null}

        {step === "resume" ? <>
          <Dialog.Title className="oj-card-title">Add your resume</Dialog.Title>
          <p className="oj-note">The extension attaches it to applications{choice === "control" ? "" : " and the AI answers from it"}.</p>
          <ResumeField resume={resume} onChange={setResume} />
          {actions(<Button variant="primary" onClick={next}>{resume ? "Next" : "Later"}</Button>, <Button variant="secondary" onClick={back}>Back</Button>)}
        </> : null}

        {step === "extension" ? <>
          <Dialog.Title className="oj-card-title">Connect the extension</Dialog.Title>
          {!ext.installed ? <>
            <p className="oj-note">Add the Ocean of Jobs extension to Chrome, then come back to this tab.</p>
            <div><LinkButton variant="secondary" href={STORE} target="_blank" rel="noopener">Get the extension</LinkButton></div>
          </> : ext.connected ? <p className="oj-note">The extension is connected to your account.</p> : <>
            <p className="oj-note">The extension is installed. Connect it to your account.</p>
            <div><Button variant="secondary" loading={connecting} onClick={connect}>Connect the extension</Button></div>
          </>}
          {actions(<Button variant="primary" onClick={next}>{ext.connected ? "Next" : "Later"}</Button>, <Button variant="secondary" onClick={back}>Back</Button>)}
        </> : null}

        {step === "autoapply" ? <>
          <Dialog.Title className="oj-card-title">Turn on Auto-apply mode?</Dialog.Title>
          <p className="oj-note">The extension finds jobs that match your preferences and applies to them on its own, up to your plan's limit.</p>
          {!resume ? <p className="oj-note">Auto-apply mode needs your resume. You can turn it on later in Settings.</p> : null}
          {actions(
            <Button variant="primary" disabled={!resume} onClick={() => { setAutoApply(true); next(); }}>Turn on</Button>,
            <Button variant="secondary" onClick={() => { setAutoApply(false); next(); }}>Not now</Button>)}
        </> : null}

        {step === "done" ? <>
          <Dialog.Title className="oj-card-title">You're set</Dialog.Title>
          <ul className="oj-setup-list">{summary.map((l) => <li key={l}>{l}</li>)}</ul>
          {choice !== "control" ? <p className="oj-note">Add facts the AI can use in <a className="oj-link" href="#agent" onClick={() => finish()}>AI agent</a>.</p> : null}
          <p className="oj-note">You can change any of this in Settings.</p>
          {actions(<Button variant="primary" loading={busy} onClick={finish}>Finish</Button>, <Button variant="secondary" onClick={back}>Back</Button>)}
        </> : null}
      </Dialog>
    </Dialog.Root>
  );
}
