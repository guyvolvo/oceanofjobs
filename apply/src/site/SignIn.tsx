// The sign-in, for every page: a card (the signed-out /account and /apply
// pages are this card alone) and the same card in a window, opened from
// any "Log in" through requestSignIn(). auth.js does all the work.
import { useEffect, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Input } from "@cloudflare/kumo/components/input";
import { ArrowLeft, GithubLogo, X } from "@phosphor-icons/react";
import { SIGNIN_EVENT } from "./auth";

export const GOOGLE = (
  <svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z" /><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z" /><path fill="#FBBC05" d="M3.964 10.71c-.18-.54-.282-1.117-.282-1.71s.102-1.17.282-1.71V4.958H.957C.348 6.173 0 7.548 0 9s.348 2.827.957 4.042l3.007-2.332z" /><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" /></svg>
);

export function SignIn({ onDone }: { onDone?: () => void }) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
  useEffect(() => { setAuthErrorSink(setError); }, []);
  const sendCode = async () => {
    if (!agreed()) return;
    setError(""); setBusy(true);
    try { await startEmailSignIn(email.trim()); setStep("code"); } catch { setError(SEND_CODE_FAILED); } finally { setBusy(false); }
  };
  const verify = async () => {
    setError(""); setBusy(true);
    try {
      await verifyEmailOtp(code.trim());
      if (onDone) onDone();
      // Every block is built from the token at boot, so boot again.
      else location.reload();
    } catch (err) {
      setError(verifyCodeError(err));
      setBusy(false);
    }
  };
  const redirect = (start: () => unknown) => { setError(""); if (agreed()) { rememberPage(); start(); } };
  return (
    <div className="flex flex-col gap-4">
      <img className="self-center rounded-full" src="/favicon.svg?v=3" width="44" height="44" alt="" />
      <div className="flex flex-col gap-1 text-center">
        <h1 className="m-0 text-[22px] font-medium leading-tight tracking-tight text-kumo-strong">{step === "email" ? "Log in to Ocean of Jobs" : "Check your email"}</h1>
        {step !== "email" && <p className="m-0 text-sm text-kumo-subtle break-words">We sent a code to <strong className="font-medium text-kumo-default">{email.trim()}</strong>.</p>}
      </div>
      {step === "email" ? (
        <>
          {asked ? (
            <div className="flex flex-col gap-2.5 text-[13px]">
              <Checkbox checked={terms} onCheckedChange={(c) => { setTerms(c === true); if (c === true) setTermsError(false); }}
                label={<span>I agree to the <a className="underline text-kumo-link" href="/terms" target="_blank" rel="noopener">Terms of Service</a> and <a className="underline text-kumo-link" href="/privacy" target="_blank" rel="noopener">Privacy Policy</a></span>} />
              <Checkbox checked={news} onCheckedChange={(c) => setNews(c === true)} label="Email me about new features and product updates" />
              {termsError ? <p className="m-0 text-kumo-danger" role="alert">Agree to the Terms of Service and Privacy Policy to continue.</p> : null}
            </div>
          ) : null}
          <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); sendCode(); }}>
            <Input label="Email" type="email" name="email" placeholder="you@example.com" required autoComplete="email"
              spellCheck={false} autoCapitalize="off" value={email} onChange={(e) => setEmail(e.target.value)} error={error || undefined} />
            <Button type="submit" variant="primary" className="w-full justify-center" loading={busy}>Send code</Button>
          </form>
          <div className="flex items-center gap-2.5 text-xs uppercase tracking-wider text-kumo-subtle before:h-px before:flex-1 before:bg-kumo-hairline after:h-px after:flex-1 after:bg-kumo-hairline"><span>or</span></div>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" icon={GOOGLE} aria-label="Continue with Google" className="w-full justify-center" onClick={() => redirect(startGoogleSignIn)}>Google</Button>
            <Button variant="secondary" icon={<GithubLogo weight="fill" />} aria-label="Continue with GitHub" className="w-full justify-center" onClick={() => redirect(startGithubSignIn)}>GitHub</Button>
          </div>
          <p className="m-0 text-center text-[13px] text-kumo-subtle">New here? Logging in creates your account.</p>
        </>
      ) : (
        <>
          <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); verify(); }}>
            <Input label="Code" name="code" placeholder="Code from the email" inputMode="numeric" pattern="[0-9]{4,10}" required
              autoComplete="one-time-code" spellCheck={false} autoCapitalize="off" autoFocus value={code} onChange={(e) => setCode(e.target.value)}
              error={error || undefined} />
            <Button type="submit" variant="primary" className="w-full justify-center" loading={busy}>Log in</Button>
          </form>
          <Button variant="ghost" size="sm" icon={<ArrowLeft />} className="self-center" onClick={() => { setError(""); setCode(""); setStep("email"); }}>
            Use a different email
          </Button>
        </>
      )}
    </div>
  );
}

// The whole page is the sign-in (signed-out /apply and /account).
export function SignInPage() {
  return (
    <div className="mx-auto mt-6 w-full max-w-[420px] rounded-xl border border-kumo-hairline bg-kumo-elevated px-7 pb-6 pt-8">
      <SignIn />
    </div>
  );
}

// The window. Mounted once per page by the header or the workspace;
// opened by requestSignIn() from anywhere.
export function SignInDialog() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = () => setOpen(true);
    addEventListener(SIGNIN_EVENT, on);
    return () => removeEventListener(SIGNIN_EVENT, on);
  }, []);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog className="w-[420px] max-w-[calc(100vw-32px)] px-7 pb-6 pt-6 top-1/2 -translate-y-1/2" aria-label="Log in">
        <div className="flex justify-end -mb-6 -mr-3">
          <Dialog.Close aria-label="Close" render={(p) => <Button {...p} variant="ghost" shape="square" icon={<X />} aria-label="Close" />} />
        </div>
        <SignIn onDone={() => location.reload()} />
      </Dialog>
    </Dialog.Root>
  );
}
