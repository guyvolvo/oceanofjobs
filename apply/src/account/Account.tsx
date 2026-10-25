// The account page. Everything here needs a token, so the page is one of
// two states: a sign-in, or the real thing. Each block fills itself, and
// one that can't says so in its own place without taking the rest down.
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { Loader } from "@cloudflare/kumo/components/loader";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { ArrowLeft, ArrowRight, Bell, GithubLogo, UploadSimple } from "@phosphor-icons/react";
import { api, pub, send, signedIn, ApiError } from "../api";
import { useSiteTheme } from "../theme";
import { boardLink, DAY_NAMES, EMPTY_PROFILE, placeSummary, plural, provider, readCv, setStar, skillsIn, WORKPLACE_LABELS,
  type Alert, type Dashboard, type Job, type Profile, type SavedRow } from "./data";
import { Alerts, useAlertForm, useLocationOptions } from "./Alerts";
import { Overview } from "./Overview";
import { Skills } from "./Skills";
import { Saved } from "./Saved";
import { Card } from "./ui";
import { useLeaveGuard } from "../unsaved";
const Preferences = lazy(() => import("./Preferences").then((m) => ({ default: m.Preferences })));
const Settings = lazy(() => import("./Settings").then((m) => ({ default: m.Settings })));

const SECTIONS = ["overview", "skills", "alerts", "saved", "preferences", "settings"] as const;
type Section = (typeof SECTIONS)[number];
// A hash can also name a part of a section (#aa-settings, from older
// extension builds and the MCP server's refusal message).
const PARTS: Record<string, Section> = {};

// Account settings or auto apply settings: /account or /apply. Links from
// before the two shared a page (/account#aa-settings, #autoapply) open the
// auto apply side.
type Mode = "account" | "apply";
const ApplyDashboard = lazy(() => import("../App").then((m) => ({ default: m.Dashboard })));
const TITLES: Record<Mode, string> = { account: "Account | Ocean of Jobs", apply: "Auto apply | Ocean of Jobs" };
function modeFromPath(): Mode {
  if (location.pathname.startsWith("/account") && (location.hash === "#aa-settings" || location.hash === "#autoapply")) {
    history.replaceState(null, "", location.hash === "#aa-settings" ? "/apply#settings" : "/apply");
  }
  return location.pathname.startsWith("/apply") ? "apply" : "account";
}
const fromHash = (): Section => {
  const h = location.hash.slice(1);
  return (SECTIONS as readonly string[]).includes(h) ? (h as Section) : PARTS[h] || "overview";
};

const STUCK = "This is taking longer than it should. Reload the page to try again.";
const FAILED = "Couldn't load this. Reload the page to try again.";

const GOOGLE = (
  <svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z" /><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z" /><path fill="#FBBC05" d="M3.964 10.71c-.18-.54-.282-1.117-.282-1.71s.102-1.17.282-1.71V4.958H.957C.348 6.173 0 7.548 0 9s.348 2.827.957 4.042l3.007-2.332z" /><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" /></svg>
);

// Signed out: the whole page is one sign-in, with the same three ways in
// as the site's dialog (auth.js does the work).
function SignIn() {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The same two boxes as the site's sign-in window (signin_dialog.js):
  // asked once per browser and policy version, kept for after sign-in.
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
      // Every block is built from the token at boot, so boot again.
      location.reload();
    } catch (err) {
      setError(verifyCodeError(err));
      setBusy(false);
    }
  };
  return (
    <div className="oj-signin">
      <Card>
        <img className="oj-signin-mark" src="/favicon.svg?v=3" width="44" height="44" alt="" />
        <div className="oj-signin-head">
          <h1 id="signin-title">{step === "email" ? "Log in to Ocean of Jobs" : "Check your email"}</h1>
          <p>{step === "email" ? "We'll email you a code. No password needed." : <>We sent a code to <strong>{email.trim()}</strong>.</>}</p>
        </div>
        {step === "email" ? (
          <>
            {asked ? (
              <div className="oj-signin-consent">
                <Checkbox checked={terms} onCheckedChange={(c) => { setTerms(c === true); if (c === true) setTermsError(false); }}
                  label={<span>I agree to the <a className="oj-link" href="/terms" target="_blank" rel="noopener">Terms of Service</a> and <a className="oj-link" href="/privacy" target="_blank" rel="noopener">Privacy Policy</a></span>} />
                <Checkbox checked={news} onCheckedChange={(c) => setNews(c === true)} label="Email me about new features and product updates" />
                {termsError ? <p className="oj-error" role="alert">Agree to the Terms of Service and Privacy Policy to continue.</p> : null}
              </div>
            ) : null}
            <form className="oj-signin-form" onSubmit={(e) => { e.preventDefault(); sendCode(); }}>
              <Input label="Email" type="email" name="email" placeholder="you@example.com" required autoComplete="email"
                spellCheck={false} autoCapitalize="off" value={email} onChange={(e) => setEmail(e.target.value)} error={error || undefined} />
              <Button type="submit" variant="primary" className="oj-signin-wide" loading={busy}>Send code</Button>
            </form>
            <div className="oj-divider"><span>or</span></div>
            <div className="oj-signin-providers">
              <Button variant="secondary" icon={GOOGLE} aria-label="Continue with Google" onClick={() => { setError(""); if (agreed()) startGoogleSignIn(); }}>Google</Button>
              <Button variant="secondary" icon={<GithubLogo weight="fill" />} aria-label="Continue with GitHub" onClick={() => { setError(""); if (agreed()) startGithubSignIn(); }}>GitHub</Button>
            </div>
            <p className="oj-signin-foot">New here? Logging in creates your account.</p>
          </>
        ) : (
          <>
            <form className="oj-signin-form" onSubmit={(e) => { e.preventDefault(); verify(); }}>
              <Input label="Code" name="code" placeholder="Code from the email" inputMode="numeric" pattern="[0-9]{4,10}" required
                autoComplete="one-time-code" spellCheck={false} autoCapitalize="off" autoFocus value={code} onChange={(e) => setCode(e.target.value)}
                error={error || undefined} />
              <Button type="submit" variant="primary" className="oj-signin-wide" loading={busy}>Log in</Button>
            </form>
            <Button variant="ghost" size="sm" icon={<ArrowLeft />} className="oj-signin-back" onClick={() => { setError(""); setCode(""); setStep("email"); }}>
              Use a different email
            </Button>
          </>
        )}
      </Card>
    </div>
  );
}

// The overview's numbers, computed on the box once a day. The last answer
// is kept in this browser for half an hour so the page paints at once,
// and while the box is still computing the page asks again every few
// seconds for a couple of minutes. A failed request gets two slower tries.
const DASH_KEY = "iljobs_dash_v1";
function useDashboard(profile: Profile | null) {
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [loaded, setLoaded] = useState(false);
  const skills = profile?.skills || [];
  const country = profile && profile.country.length === 1 ? profile.country[0] : "";
  const key = `${skills.join(",")}|${country}|${Math.min(3, skills.length)}`;
  useEffect(() => {
    if (!profile) return;
    if (!skills.length) { setDash(null); setLoaded(true); return; }
    let live = true, polls = 0, retries = 0, timer = 0;
    try {
      const c = JSON.parse(localStorage.getItem(DASH_KEY) || "null");
      if (c && c.key === key && Date.now() - c.at < 30 * 60 * 1000) {
        setDash({ history: c.history, matches: c.matches, counts: c.counts, computed_at: c.computedAt });
        setLoaded(true);
      }
    } catch { /* a per-browser nicety only */ }
    const run = async () => {
      let d: Dashboard | null = null;
      try { d = await api<Dashboard>("/me/dashboard"); } catch { d = null; }
      if (!live) return;
      const pending = !!(d && (d.computing || d.updating));
      if (pending && polls < 40) { polls++; timer = window.setTimeout(run, 4000); }
      else if (!d && retries < 2) { retries++; timer = window.setTimeout(run, 20000); }
      // Nothing stored yet: keep the bones up rather than paint empty cards.
      if (pending && !d!.computed_at) return;
      if (d) {
        setDash(d);
        if (d.history) {
          try { localStorage.setItem(DASH_KEY, JSON.stringify({ key, at: Date.now(), history: d.history, matches: (d.matches || []).slice(0, 100), counts: d.counts, computedAt: d.computed_at })); } catch { /* quota */ }
        }
      }
      setLoaded(true);
    };
    run();
    return () => { live = false; clearTimeout(timer); };
  }, [key, !!profile]); // eslint-disable-line react-hooks/exhaustive-deps
  return { dash, loaded };
}

function greeting(name: string) {
  const h = new Date().getHours();
  const part = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  const first = name.split(" ")[0];
  return first ? `${part}, ${first}` : part;
}

function Dashboard({ onSignedOut }: { onSignedOut: () => void }) {
  const toasts = useKumoToastManager();
  const idToken = getAuthTokens()?.id_token || "";
  const email = decodeJwtEmail(idToken) || "signed in";
  const name = decodeJwtName(idToken) || "";
  const signedInWith = provider(idToken);

  const [mode, setMode] = useState<Mode>(modeFromPath);
  // Opened on the auto apply side, the hash is that side's: the account side starts at its overview.
  const [section, setSection] = useState<Section>(() => (location.pathname.startsWith("/apply") ? "overview" : fromHash()));
  const [profile, setProfile] = useState<Profile | null>(null);
  const [spec, setSpec] = useState<unknown>(null);
  const [skills, setSkills] = useState<string[]>([]);
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [alertsError, setAlertsError] = useState("");
  const [savedJobs, setSavedJobs] = useState<Job[] | null>(null);
  const [savedCount, setSavedCount] = useState(0);
  const [savedError, setSavedError] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const [overviewForm, setOverviewForm] = useState(false);
  const [cv, setCv] = useState<{ name: string; status: { text: string; error: boolean } | null }>({ name: "", status: null });
  const [savingSkills, setSavingSkills] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const prefsOpen = useRef(false);
  const { dash, loaded } = useDashboard(profile);
  const places = useLocationOptions();

  const reloadAlerts = useCallback(async () => {
    const list = (await api<{ alerts: Alert[] }>("/me/alerts")).alerts || [];
    setAlerts(list);
    setAlertsError("");
    return list;
  }, []);
  const form = useAlertForm(profile, reloadAlerts);

  const loadSaved = useCallback(async () => {
    let ids: string[];
    try {
      ids = ((await api<{ saved: SavedRow[] }>("/me/saved")).saved || []).map((r) => r.job_id).filter(Boolean);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onSignedOut();
      setSavedError("Couldn't load your saved jobs.");
      return;
    }
    setSavedCount(ids.length);
    if (!ids.length) { setSavedJobs([]); setSavedError(""); return; }
    try {
      const q = new URLSearchParams({ ids: ids.slice(0, 200).join(","), include_closed: "1", include_outdated: "1", limit: "200" });
      const jobs = (await pub<{ jobs: Job[] }>(`/jobs?${q}`)).jobs || [];
      // The account knows the order they were starred in; restore it.
      const rank = new Map(ids.map((id, i) => [id, i]));
      jobs.sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));
      setSavedJobs(jobs);
      setSavedError("");
    } catch {
      setSavedError("Couldn't load your saved jobs.");
    }
  }, [onSignedOut]);

  // Three independent fetches, started together, each with a watchdog:
  // a request that never settles still ends in a sentence, not a spinner.
  useEffect(() => {
    const stuck = window.setTimeout(() => {
      setAlertsError((e) => e || STUCK);
      setSavedError((e) => e || STUCK);
    }, 15000);
    const profileDone = api<{ profile: Profile; skill_spec: unknown }>("/me/profile").then((d) => {
      const p = { ...EMPTY_PROFILE, ...(d.profile || {}) };
      setProfile(p); setSkills(p.skills); setSpec(d.skill_spec || null);
    }).catch(() => {
      // A profile that won't load isn't worth blocking the page for; the
      // pickers just have nothing to offer until the next load.
      setProfile({ ...EMPTY_PROFILE });
    });
    const alertsDone = reloadAlerts().catch((err) => { console.error("account: alerts failed", err); setAlertsError(FAILED); });
    Promise.allSettled([profileDone, alertsDone, loadSaved()]).then(() => {
      // Cognito refusing a refresh token signs the reader out from under
      // the page; say so rather than show every list empty.
      if (!signedIn()) onSignedOut();
    });
    return () => clearTimeout(stuck);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (alerts) setAlertsError((e) => (e === STUCK ? "" : e));
  }, [alerts]);
  useEffect(() => {
    if (savedJobs) setSavedError((e) => (e === STUCK ? "" : e));
  }, [savedJobs]);

  // The hash is the section, so /account#alerts opens there and Back walks
  // out of a section the way it came in.
  useEffect(() => {
    const on = () => {
      const m = modeFromPath();
      setMode(m);
      document.title = TITLES[m];
      if (m === "account") { setSection(fromHash()); scrollTo(0, 0); }
    };
    addEventListener("popstate", on);
    addEventListener("hashchange", on);
    const part = location.hash.slice(1);
    if (PARTS[part]) requestAnimationFrame(() => document.getElementById(part)?.scrollIntoView({ block: "start" }));
    return () => { removeEventListener("popstate", on); removeEventListener("hashchange", on); };
  }, []);
  const leaveGuard = useLeaveGuard();
  const switchMode = (m: string) => leaveGuard.guard(() => {
    history.pushState(null, "", m === "apply" ? "/apply" : `/account${section === "overview" ? "" : `#${section}`}`);
    setMode(m as Mode);
    document.title = TITLES[m as Mode];
    scrollTo(0, 0);
  });
  const go = (s: string) => {
    if (s !== "overview") setOverviewForm(false);
    if (location.hash !== `#${s}`) history.pushState({ acct: s }, "", `#${s}`);
    setSection(s as Section);
    scrollTo(0, 0);
  };

  // The board's "Alert me for this search" lands here with its filters.
  useEffect(() => {
    let raw: string | null = null;
    try { raw = sessionStorage.getItem("iljobs_alert_prefill"); sessionStorage.removeItem("iljobs_alert_prefill"); } catch { return; }
    if (!raw) return;
    try { form.fill(JSON.parse(raw)); } catch { /* an unreadable handoff is dropped */ }
    if (section !== "alerts") go("alerts");
    requestAnimationFrame(() => document.getElementById("alert-create")?.scrollIntoView({ block: "start" }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // An edit in progress (a preference row open, an alert half written)
  // is not lost to a stray click on a link.
  const searchRef = useRef("");
  searchRef.current = form.draft.search;
  useEffect(() => {
    const on = (e: BeforeUnloadEvent) => { if (prefsOpen.current || searchRef.current.trim()) { e.preventDefault(); e.returnValue = ""; } };
    addEventListener("beforeunload", on);
    return () => removeEventListener("beforeunload", on);
  }, []);
  const onPrefsEditing = useCallback((open: boolean) => { prefsOpen.current = open; }, []);

  // Every save PUTs the whole profile, the skills being edited included.
  const putProfile = async (patch: Partial<Profile>) => {
    const res = await api<{ profile: Profile }>("/me/profile", send("PUT", { ...(profile || EMPTY_PROFILE), skills, ...patch }));
    const p = { ...EMPTY_PROFILE, ...(res.profile || res) };
    setProfile(p);
    setSkills(p.skills);
    return p;
  };
  const saveSkills = async () => {
    setSavingSkills(true);
    try {
      await putProfile({});
      toasts.add({ variant: "success", title: "Saved." });
    } catch (err) {
      toasts.add({ variant: "error", title: (err as Error).message || "Could not save." });
    } finally {
      setSavingSkills(false);
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
  const pickCv = () => fileRef.current?.click();

  const toggleSave = async (j: Job, on: boolean) => {
    setStar(j.id, on);
    try {
      await api(`/me/saved/${encodeURIComponent(j.id)}`, { method: on ? "PUT" : "DELETE" });
      loadSaved();
    } catch {
      setStar(j.id, !on);
    }
  };
  const removeSaved = async (id: string) => {
    setRemoving(id);
    try {
      await api(`/me/saved/${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch {
      setRemoving(null);
      return void toasts.add({ variant: "error", title: "Couldn't remove that job. Try again." });
    }
    // The board reads the same list from this browser, so its star goes too.
    setStar(id, false);
    setRemoving(null);
    const rest = (savedJobs || []).filter((j) => j.id !== id);
    setSavedJobs(rest);
    setSavedCount((n) => Math.max(0, n - 1));
    if (!rest.length) loadSaved();
  };
  const addSkill = async (sk: string) => {
    try { await putProfile({ skills: [...new Set([...skills, sk])] }); return true; } catch { return false; }
  };

  const logOut = () => { signOut(); location.href = "/"; };
  const newAlert = () => {
    if (section === "overview") {
      setOverviewForm(true);
      requestAnimationFrame(() => document.getElementById("alert-create")?.scrollIntoView({ block: "nearest" }));
    } else {
      go("alerts");
      requestAnimationFrame(() => document.getElementById("alert-f-search")?.focus());
    }
  };

  const p = profile || EMPTY_PROFILE;
  const country = p.country.length === 1 ? p.country[0] : "";
  const openHref = skills.length ? `/board?view=matches&skills=${encodeURIComponent(skills.join(","))}${country ? `&country=${country}` : ""}` : "/board?view=matches";
  const count = (n: number, label: string) => (n ? `${label} (${n})` : label);
  const tabs = [
    { value: "overview", label: "Overview" },
    { value: "skills", label: count(skills.length, "Skills") },
    { value: "alerts", label: count(alerts?.length || 0, "Alerts") },
    { value: "saved", label: count(savedCount, "Saved jobs") },
    { value: "preferences", label: "Preferences" },
    { value: "settings", label: "Settings" },
  ];
  const prefsLine = [
    p.workplace.length ? p.workplace.map((w) => WORKPLACE_LABELS[w] || w).join(", ") : "",
    p.country.length + p.city.length ? plural(p.country.length + p.city.length, "place") : "",
    ({ daily: `daily at ${p.digest_time}`, weekly: `weekly on ${DAY_NAMES[p.digest_day] || "Monday"}` } as Record<string, string>)[p.cadence] || "instant alerts",
  ].filter(Boolean).join(" · ");
  const head: Partial<Record<Section, { status?: string; action?: ReactNode }>> = {
    skills: { status: skills.length ? `${plural(skills.length, "skill")} matched against every listing` : "No skills yet",
      action: <Button variant="secondary" icon={<UploadSimple />} onClick={pickCv}>Scan a resume</Button> },
    alerts: { status: alerts?.length ? plural(alerts.length, "alert") : "No alerts yet" },
    saved: { status: savedCount ? plural(savedCount, "saved job") : "Nothing saved yet", action: <LinkButton variant="ghost" href="/board">Open the board</LinkButton> },
    preferences: { status: profile ? prefsLine : "" },
  };
  const waiting = <div className="oj-row oj-note"><Loader /> Loading</div>;
  const h = head[section];

  return (
    <>
      <input ref={fileRef} type="file" accept=".pdf,.txt,.md,application/pdf,text/plain" hidden aria-label="Choose a resume file"
        onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) { if (section !== "skills") go("skills"); await takeCv(f); } }} />
      <header className="oj-head oj-hero">
        <div className="oj-row oj-hero-id">
          <span className="oj-avatar" dangerouslySetInnerHTML={{ __html: avatarHtml(email, idToken) }} />
          <div>
            <h1>{greeting(name)}</h1>
            <p className="oj-wrap">{name ? `${name} · ` : ""}{email}{signedInWith ? <span className="oj-provider-mark"> · {GOOGLE} Signed in with {signedInWith}</span> : null}</p>
          </div>
        </div>
        <div className="oj-row oj-hero-actions">
          <Button variant="secondary" icon={<UploadSimple />} onClick={() => { go("skills"); pickCv(); }}>Add skills from a resume</Button>
          <Button variant="secondary" icon={<Bell />} onClick={newAlert}>New alert</Button>
          <LinkButton variant="primary" href={openHref}>See best matches <ArrowRight /></LinkButton>
        </div>
      </header>
      {leaveGuard.dialog}
      <nav className="oj-tabs oj-mode" aria-label="Settings">
        <Tabs variant="segmented" tabs={[{ value: "account", label: "Account settings" }, { value: "apply", label: "Auto apply settings" }]}
          value={mode} onValueChange={switchMode} />
      </nav>
      {mode === "apply" ? (
        <Suspense fallback={<div className="oj-row oj-note"><Loader /> Loading</div>}>
          <ApplyDashboard onSignedOut={onSignedOut} />
        </Suspense>
      ) : (<>
      <nav className="oj-tabs" aria-label="Account sections">
        <Tabs variant="segmented" tabs={tabs} value={section} onValueChange={go} />
      </nav>
      <div role="tabpanel" aria-label={tabs.find((t) => t.value === section)?.label} className="oj-stack">
        {h ? (
          <div className="oj-row oj-row-between oj-section-head">
            <span className="oj-note">{h.status}</span>
            {h.action}
          </div>
        ) : null}
        <Suspense fallback={waiting}>
          {section === "overview" && (
            <Overview skills={skills} savedSkills={p.skills} places={placeSummary(p, places.labels)} dash={dash} dashLoaded={!!profile && loaded}
              savedJobs={savedJobs} alerts={alerts} form={form} formOpen={overviewForm} setFormOpen={setOverviewForm}
              reloadAlerts={reloadAlerts} addSkill={addSkill} toggleSave={toggleSave} />
          )}
          {section === "skills" && (
            <Skills skills={skills} setSkills={setSkills} onPick={pickCv} onFile={takeCv} fileName={cv.name} cvStatus={cv.status}
              save={saveSkills} saving={savingSkills} matchesHref={boardLink(p, skills)} />
          )}
          {section === "alerts" && <Alerts alerts={alerts} error={alertsError} form={form} reload={reloadAlerts} />}
          {section === "saved" && <Saved jobs={savedJobs} error={savedError} removing={removing} remove={removeSaved} />}
          {section === "preferences" && (profile
            ? <Preferences profile={profile} onEditing={onPrefsEditing} save={async (prefs) => { await putProfile(prefs); }} />
            : waiting)}
          {section === "settings" && <Settings email={email} logOut={logOut} />}
        </Suspense>
      </div>
      </>)}
    </>
  );
}

export function Account() {
  const [authed, setAuthed] = useState(signedIn);
  useSiteTheme();
  useEffect(() => {
    // Signed in or out in another tab, or from the header's own menu.
    const on = (e: StorageEvent) => { if (e.key === "iljobs_auth_tokens") setAuthed(signedIn()); };
    addEventListener("storage", on);
    const header = authRenderSink;
    setAuthRenderSink(() => { header(); setAuthed(signedIn()); });
    return () => { removeEventListener("storage", on); setAuthRenderSink(header); };
  }, []);
  const out = useCallback(() => setAuthed(false), []);
  return <main className="oj-main" id="main" tabIndex={-1}>{authed ? <Dashboard onSignedOut={out} /> : <SignIn />}</main>;
}
