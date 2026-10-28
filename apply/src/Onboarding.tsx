// The setup guide on Auto apply settings: shown until it is finished or
// skipped (POST /me/apply/onboarded), and again from "Run setup again".
// One question picks the settings, then only the steps this person still
// needs: a resume, the extension, and for full automation Auto-apply mode.
// Nothing is saved until Finish.
import { useEffect, useState, type ReactNode } from "react";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { apply, send, type Plan, type Profile } from "./api";
import { connectExtension, type Ext } from "./ext";
import { ResumeField, type Resume } from "./Agent";
import { SETUP } from "./shared";
const STORE = "https://chromewebstore.google.com/detail/kihjppefdadlodaoecffiemijlielhdi";

// Google's Material Symbols (outlined, 400), as the site's own icons are.
const ICON = {
  autorenew: "M196-331q-20-36-28-72.5t-8-74.5q0-131 94.5-225.5T480-798h43l-80-80 39-39 149 149-149 149-40-40 79-79h-41q-107 0-183.5 76.5T220-478q0 29 5.5 55t13.5 49l-43 43ZM476-40 327-189l149-149 39 39-80 80h45q107 0 183.5-76.5T740-479q0-29-5-55t-15-49l43-43q20 36 28.5 72.5T800-479q0 131-94.5 225.5T480-159h-45l80 80-39 39Z",
  balance: "M80-120v-60h370v-484q-26-9-46.5-29.5T374-740H215l125 302q-1 45-38.5 76.5T210-330q-54 0-91.5-31.5T80-438l125-302h-85v-60h254q12-35 41-57.5t65-22.5q36 0 65 22.5t41 57.5h254v60h-85l125 302q-1 45-38.5 76.5T750-330q-54 0-91.5-31.5T620-438l125-302H586q-9 26-29.5 46.5T510-664v484h370v60H80Zm595-320h150l-75-184-75 184Zm-540 0h150l-75-184-75 184Zm345-280q21 0 35.5-15t14.5-35q0-21-14.5-35.5T480-820q-20 0-35 14.5T430-770q0 20 15 35t35 15Z",
  bolt: "m393-165 279-335H492l36-286-253 366h154l-36 255Zm-73 85 40-280H160l360-520h80l-40 320h240L400-80h-80Zm154-396Z",
  check_circle: "m421-298 283-283-46-45-237 237-120-120-45 45 165 166Zm59 218q-82 0-155-31.5t-127.5-86Q143-252 111.5-325T80-480q0-83 31.5-156t86-127Q252-817 325-848.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 82-31.5 155T763-197.5q-54 54.5-127 86T480-80Zm0-60q142 0 241-99.5T820-480q0-142-99-241t-241-99q-141 0-240.5 99T140-480q0 141 99.5 240.5T480-140Zm0-340Z",
  description: "M319-250h322v-60H319v60Zm0-170h322v-60H319v60ZM220-80q-24 0-42-18t-18-42v-680q0-24 18-42t42-18h361l219 219v521q0 24-18 42t-42 18H220Zm331-554v-186H220v680h520v-494H551ZM220-820v186-186 680-680Z",
  extension: "M356-120H180q-24 0-42-18t-18-42v-176q44-5 75.5-34.5T227-463q0-43-31.5-72.5T120-570v-176q0-24 18-42t42-18h177q11-40 39.5-67t68.5-27q40 0 68.5 27t39.5 67h173q24 0 42 18t18 42v173q40 11 65.5 41.5T897-461q0 40-25.5 67T806-356v176q0 24-18 42t-42 18H570q-5-48-35.5-77.5T463-227q-41 0-71.5 29.5T356-120Zm-176-60h130q25-61 69.89-84t83-23Q501-287 546-264t70 84h130v-235h45q20 0 33-13t13-33q0-20-13-33t-33-13h-45v-239H511v-48q0-20-13-33t-33-13q-20 0-33 13t-13 33v48H180v130q48.15 17.82 77.58 59.69Q287-514.45 287-462.78 287-412 257.5-370T180-310v130Zm285-281Z",
  rocket_launch: "m187-551 106 45q18-36 38.5-71t43.5-67l-79-16-109 109Zm154 81 133 133q57-26 107-59t81-64q81-81 119-166t41-192q-107 3-192 41T464-658q-31 31-64 81t-59 107Zm229-96q-20-20-20-49.5t20-49.5q20-20 49.5-20t49.5 20q20 20 20 49.5T669-566q-20 20-49.5 20T570-566Zm-15 383 109-109-16-79q-32 23-67 43.5T510-289l45 106Zm326-694q9 136-34 248T705-418l-2 2-2 2 22 110q3 15-1.5 29T706-250L535-78l-85-198-170-170-198-85 172-171q11-11 25-15.5t29-1.5l110 22q1-1 2-1.5t2-1.5q99-99 211-142.5T881-877ZM149-325q35-35 85.5-35.5T320-326q35 35 34.5 85.5T319-155q-26 26-80.5 43T75-80q15-109 31.5-164t42.5-81Zm42 43q-14 15-25 47t-19 82q50-8 82-19t47-25q19-17 19.5-42.5T278-284q-19-18-44.5-17.5T191-282Z",
  tune: "M427-120v-225h60v83h353v60H487v82h-60Zm-307-82v-60h247v60H120Zm187-166v-82H120v-60h187v-84h60v226h-60Zm120-82v-60h413v60H427Zm166-165v-225h60v82h187v60H653v83h-60Zm-473-83v-60h413v60H120Z",
};
function Icon({ name }: { name: keyof typeof ICON }) {
  return <svg className="oj-setup-icon" viewBox="0 -960 960 960" aria-hidden="true"><path d={ICON[name]} /></svg>;
}

type Choice = "control" | "balance" | "automation";
const CHOICES: [Choice, keyof typeof ICON, string][] = [
  ["control", "tune", "I prefer having full control over what data I send to the hiring team"],
  ["balance", "balance", "I prefer a balance of control and automation over what data I send to the hiring team"],
  ["automation", "bolt", "I prefer full automation for the job application process including usage of AI to fill out blank fields on forms"],
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
  // Each step: the step's icon, then its title.
  const head = (icon: keyof typeof ICON, title: string) => (
    <div className="oj-setup-head"><span className="oj-setup-badge"><Icon name={icon} /></span>
      <Dialog.Title className="oj-card-title">{title}</Dialog.Title></div>
  );

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) skip(); }}>
      <Dialog className="oj-dialog oj-setup">
        <div className="oj-setup-top">
          {step !== "welcome" && step !== "done" ? <span className="oj-note">Step {at} of {steps.length - 2}</span> : null}
        </div>
        {step === "welcome" ? <>
          {head("rocket_launch", "Set up auto apply")}
          <p className="oj-note">Answer one question and we'll set up the extension for you.</p>
          {actions(<Button variant="primary" onClick={next}>Next</Button>, <Button variant="secondary" onClick={skip}>Skip</Button>)}
        </> : null}

        {step === "choose" ? <>
          {head("tune", "Choose your preference:")}
          <fieldset className="oj-setup-choices">
            <legend className="sr-only">Choose your preference</legend>
            {CHOICES.map(([value, icon, label]) => (
              <label key={value} className={`oj-setup-choice${choice === value ? " on" : ""}`}>
                <input type="radio" name="setup-choice" value={value} checked={choice === value} onChange={() => setChoice(value)} />
                <Icon name={icon} />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>
          {choice === "automation" && !paid ? (
            <p className="oj-note">Submitting for you needs Basic or Pro, so on your plan the extension fills the form and you submit. <a className="oj-link" href="/pricing">Compare plans</a></p>
          ) : null}
          {actions(<Button variant="primary" disabled={!choice} onClick={next}>Next</Button>, <Button variant="secondary" onClick={back}>Back</Button>)}
        </> : null}

        {step === "resume" ? <>
          {head("description", "Add your resume")}
          <p className="oj-note">The extension attaches it to applications{choice === "control" ? "" : " and the AI answers from it"}.</p>
          <ResumeField resume={resume} onChange={setResume} />
          {actions(<Button variant="primary" onClick={next}>{resume ? "Next" : "Later"}</Button>, <Button variant="secondary" onClick={back}>Back</Button>)}
        </> : null}

        {step === "extension" ? <>
          {head("extension", "Connect the extension")}
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
          {head("autorenew", "Turn on Auto-apply mode?")}
          <p className="oj-note">The extension finds jobs that match your preferences and applies to them on its own, up to your plan's limit.</p>
          {!resume ? <p className="oj-note">Auto-apply mode needs your resume. You can turn it on later in Settings.</p> : null}
          {actions(
            <Button variant="primary" disabled={!resume} onClick={() => { setAutoApply(true); next(); }}>Turn on</Button>,
            <Button variant="secondary" onClick={() => { setAutoApply(false); next(); }}>Not now</Button>)}
        </> : null}

        {step === "done" ? <>
          {head("check_circle", "You're set")}
          <ul className="oj-setup-list">{summary.map((l) => <li key={l}>{l}</li>)}</ul>
          {choice !== "control" ? <p className="oj-note">Add facts the AI can use in <a className="oj-link" href="#agent" onClick={() => finish()}>AI agent</a>.</p> : null}
          <p className="oj-note">You can change any of this in Settings.</p>
          {actions(<Button variant="primary" loading={busy} onClick={finish}>Finish</Button>, <Button variant="secondary" onClick={back}>Back</Button>)}
        </> : null}
      </Dialog>
    </Dialog.Root>
  );
}
