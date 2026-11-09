// The sign-in window, opened by any "Log in" through requestSignIn() and
// by auth.js after a failed Google or GitHub sign-in (window.openSignIn,
// set in hydrate.tsx). auth.js does all the work; this is the window.
// Same steps and copy as src/site/SignIn.tsx and frontend/signin_dialog.js.
// Loaded on demand (Header.tsx), so its Radix dialog is not in the first load.
import { useId, useState, type ComponentType, type ReactNode } from "react";
import { ArrowLeft, GithubLogo } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Google's mark in its own colours, which a brand mark keeps whatever the theme.
export const GOOGLE = (
  <svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z" /><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z" /><path fill="#FBBC05" d="M3.964 10.71c-.18-.54-.282-1.117-.282-1.71s.102-1.17.282-1.71V4.958H.957C.348 6.173 0 7.548 0 9s.348 2.827.957 4.042l3.007-2.332z" /><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" /></svg>
);

type Text = ComponentType<{ className?: string; children?: ReactNode }>;
// Title and Description are the dialog's own; a page that is the sign-in
// alone (src/site/SignIn.tsx) passes a heading and a paragraph instead.
export function SignInSteps({ error, setError, Title = DialogTitle, Description = DialogDescription }: {
  error: string; setError: (e: string) => void; Title?: Text; Description?: Text;
}) {
  const id = useId();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  // Asked once per browser and policy version, kept for after sign-in.
  const [asked] = useState(() => !consentAgreedHere());
  const [terms, setTerms] = useState(false);
  const [news, setNews] = useState(false);
  const [termsError, setTermsError] = useState(false);
  const agreed = () => {
    if (!asked) return true;
    if (!terms) { setTermsError(true); return false; }
    rememberConsent(news);
    return true;
  };
  const sendCode = async () => {
    if (!agreed()) return;
    setError(""); setBusy(true);
    try { await startEmailSignIn(email.trim()); setStep("code"); } catch { setError(SEND_CODE_FAILED); } finally { setBusy(false); }
  };
  const verify = async () => {
    setError(""); setBusy(true);
    try {
      await verifyEmailOtp(code.trim());
      // Every block is built from the token at load, so load again.
      location.reload();
    } catch (err) {
      setError(verifyCodeError(err));
      setBusy(false);
    }
  };
  const redirect = (start: () => unknown) => { setError(""); if (agreed()) { rememberPage(); start(); } };
  const errorLine = error ? <p className="m-0 text-sm text-destructive" role="alert">{error}</p> : null;
  return (
    <div className="flex flex-col gap-4">
      <img className="self-center" src="/favicon.svg?v=3" width="44" height="44" alt="" />
      <div className="flex flex-col gap-1 text-center">
        <Title className="m-0 font-heading text-[22px] font-medium leading-tight">{step === "email" ? "Log in to Ocean of Jobs" : "Check your email"}</Title>
        {step === "email"
          ? <Description className="sr-only">Log in with an email code, Google or GitHub.</Description>
          : <Description className="m-0 text-sm text-muted-foreground break-words">We sent a code to <strong className="font-medium text-foreground">{email.trim()}</strong>.</Description>}
      </div>
      {step === "email" ? (
        <>
          {asked ? (
            <div className="flex flex-col gap-2.5 text-[13px]">
              <div className="flex items-start gap-2">
                <Checkbox id={`${id}-terms`} checked={terms} onCheckedChange={(c) => { setTerms(c === true); if (c === true) setTermsError(false); }} />
                <Label htmlFor={`${id}-terms`} className="text-[13px] font-normal leading-snug">
                  <span>I agree to the <a className="underline underline-offset-2" href="/terms" target="_blank" rel="noopener">Terms of Service</a> and <a className="underline underline-offset-2" href="/privacy" target="_blank" rel="noopener">Privacy Policy</a></span>
                </Label>
              </div>
              <div className="flex items-start gap-2">
                <Checkbox id={`${id}-news`} checked={news} onCheckedChange={(c) => setNews(c === true)} />
                <Label htmlFor={`${id}-news`} className="text-[13px] font-normal leading-snug">Email me about new features and product updates</Label>
              </div>
              {termsError ? <p className="m-0 text-destructive" role="alert">Agree to the Terms of Service and Privacy Policy to continue.</p> : null}
            </div>
          ) : null}
          <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); sendCode(); }}>
            <Label htmlFor={`${id}-email`}>Email</Label>
            <Input id={`${id}-email`} type="email" name="email" placeholder="you@example.com" required autoComplete="email"
              spellCheck={false} autoCapitalize="off" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!error || undefined} />
            {errorLine}
            <Button type="submit" className="mt-1 w-full border-[var(--ooj-green-text)] bg-[var(--ooj-green-text)] text-[var(--ooj-dark-ink)] hover:border-[var(--ooj-green-text)] hover:bg-[var(--ooj-green-text)] hover:brightness-108" disabled={busy}>Send code</Button>
          </form>
          <div className="flex items-center gap-2.5 text-xs text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border"><span>or</span></div>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" aria-label="Continue with Google" onClick={() => redirect(startGoogleSignIn)}>{GOOGLE}Google</Button>
            <Button variant="outline" aria-label="Continue with GitHub" onClick={() => redirect(startGithubSignIn)}><GithubLogo weight="fill" />GitHub</Button>
          </div>
          <p className="m-0 text-center text-[13px] text-muted-foreground">New here? Logging in creates your account.</p>
        </>
      ) : (
        <>
          <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); verify(); }}>
            <Label htmlFor={`${id}-code`}>Code</Label>
            <Input id={`${id}-code`} name="code" placeholder="Code from the email" inputMode="numeric" pattern="[0-9]{4,10}" required
              autoComplete="one-time-code" spellCheck={false} autoCapitalize="off" autoFocus value={code} onChange={(e) => setCode(e.target.value)}
              aria-invalid={!!error || undefined} />
            {errorLine}
            <Button type="submit" className="mt-1 w-full" disabled={busy}>Log in</Button>
          </form>
          <Button variant="ghost" size="sm" className="self-center" onClick={() => { setError(""); setCode(""); setStep("email"); }}>
            <ArrowLeft />Use a different email
          </Button>
        </>
      )}
    </div>
  );
}

// The window itself, loaded on the first "Log in" (Header.tsx SignInHost
// owns the open state and auth.js's error line, so neither waits for it).
export default function SignInWindow({ open, onOpenChange, error, setError }: { open: boolean; onOpenChange: (o: boolean) => void; error: string; setError: (e: string) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[420px] max-w-[calc(100vw-32px)] px-7 pb-6 pt-8">
        <SignInSteps error={error} setError={setError} />
      </DialogContent>
    </Dialog>
  );
}
