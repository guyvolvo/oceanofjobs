// The auto apply profile, as the account page used to edit it: the same
// fields, choices, ranges and wording (api/apply.py clean_profile is the
// server side of every rule here).
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Input, InputArea } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { Radio } from "@cloudflare/kumo/components/radio";
import { Button } from "@cloudflare/kumo/components/button";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Loader } from "@cloudflare/kumo/components/loader";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { Plus, WarningCircle } from "@phosphor-icons/react";
import { apply, send, type Profile } from "./api";

const EEO = [["gender", "Gender"], ["race", "Race or ethnicity"], ["veteran", "Veteran status"], ["disability", "Disability"]] as const;
type EeoKey = (typeof EEO)[number][0];
type Form = {
  first_name: string; last_name: string; email: string; phone: string; location: string;
  linkedin: string; github: string; website: string;
  countries: string; sponsorship: "yes" | "no" | "skip"; notice: string; salary: string;
  eeo: Record<EeoKey, { pick: "skip" | "decline" | "answer"; text: string }>;
  mode: "queue" | "auto"; sources: string[]; unknowns: "skip" | "ai";
  min_match: string; daily: string; per_company: string; blocked: string;
  answers: { id: number; question: string; answer: string }[];
};

let nextId = 0;
const str = (n: number | null) => (n === null ? "" : String(n));

function toForm(p: Profile): Form {
  const g = p.settings.guardrails;
  return {
    ...p.contact, ...p.links,
    countries: p.work.authorized_countries.join(", "),
    sponsorship: p.work.needs_sponsorship === null ? "skip" : p.work.needs_sponsorship ? "yes" : "no",
    notice: p.work.notice_period, salary: p.work.salary,
    eeo: Object.fromEntries(EEO.map(([k]) => {
      const v = p.eeo[k];
      return [k, { pick: v === null ? "skip" : v === "decline" ? "decline" : "answer", text: v && v !== "decline" ? v : "" }];
    })) as Form["eeo"],
    mode: p.settings.mode, sources: p.settings.sources, unknowns: p.settings.unknowns,
    min_match: str(g.min_match), daily: str(g.daily_limit), per_company: str(g.one_per_company_days),
    blocked: g.blocked_companies.join("\n"),
    answers: p.answers.map((a) => ({ id: nextId++, ...a })),
  };
}

const num = (s: string) => (s.trim() === "" ? null : Number(s));

function fromForm(f: Form): Profile {
  return {
    contact: { first_name: f.first_name.trim(), last_name: f.last_name.trim(), email: f.email.trim(), phone: f.phone.trim(), location: f.location.trim() },
    links: { linkedin: f.linkedin.trim(), github: f.github.trim(), website: f.website.trim() },
    work: {
      authorized_countries: f.countries.split(/[\s,]+/).filter(Boolean).map((c) => c.toUpperCase()),
      needs_sponsorship: f.sponsorship === "skip" ? null : f.sponsorship === "yes",
      notice_period: f.notice.trim(), salary: f.salary.trim(),
    },
    eeo: Object.fromEntries(EEO.map(([k]) => {
      const e = f.eeo[k];
      return [k, e.pick === "decline" ? "decline" : e.pick === "answer" ? e.text.trim() || null : null];
    })) as Profile["eeo"],
    answers: f.answers.map((a) => ({ question: a.question.trim(), answer: a.answer.trim() })).filter((a) => a.question && a.answer),
    settings: {
      mode: f.mode, sources: f.sources, unknowns: f.unknowns,
      guardrails: {
        min_match: num(f.min_match), daily_limit: num(f.daily), one_per_company_days: num(f.per_company),
        blocked_companies: f.blocked.split(/\s+/).filter(Boolean),
      },
    },
  };
}

// The same ranges api/apply.py enforces, checked here so the message
// can name the field instead of passing on "51 is outside 1 to 50".
const RANGES = [["min_match", "Minimum skills match", 0, 100], ["daily", "Maximum applications per day", 1, 50],
  ["per_company", "Days between applications to the same company", 1, 365]] as const;

function Card({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <LayerCard>
      <div className="oj-card-body">
        <h2 className="oj-card-title">{title}</h2>
        {note ? <p className="oj-note">{note}</p> : null}
        {children}
      </div>
    </LayerCard>
  );
}

export function Settings() {
  const toasts = useKumoToastManager();
  const [form, setForm] = useState<Form | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoadFailed(false);
    apply<{ profile: Profile }>("profile").then((r) => setForm(toForm(r.profile))).catch(() => setLoadFailed(true));
  }, []);
  useEffect(load, [load]);

  if (loadFailed) {
    return <Banner variant="error" icon={<WarningCircle weight="fill" />} title="Couldn't load your auto apply settings."
      action={<Button size="sm" onClick={load}>Try again</Button>} />;
  }
  if (!form) return <div className="oj-row oj-note"><Loader /> Loading your settings</div>;

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const text = (k: "first_name" | "last_name" | "email" | "phone" | "location" | "linkedin" | "github" | "website" | "countries" | "notice" | "salary",
    label: string, placeholder: string, type = "text") => (
    <Input label={label} type={type} placeholder={placeholder} autoComplete="off" value={form[k]} onChange={(e) => set(k, e.target.value)} />
  );
  const limit = (k: "min_match" | "daily" | "per_company", label: string, placeholder: string) => (
    <Input label={label} type="number" inputMode="numeric" placeholder={placeholder} autoComplete="off" value={form[k]} error={errors[k]}
      onChange={(e) => { set(k, e.target.value); setErrors((x) => ({ ...x, [k]: undefined })); }} />
  );
  const setEeo = (k: EeoKey, patch: Partial<Form["eeo"][EeoKey]>) => set("eeo", { ...form.eeo, [k]: { ...form.eeo[k], ...patch } });
  const setAnswer = (id: number, patch: Partial<Form["answers"][number]>) =>
    set("answers", form.answers.map((a) => (a.id === id ? { ...a, ...patch } : a)));

  const save = async () => {
    const bad: Record<string, string> = {};
    for (const [k, label, lo, hi] of RANGES) {
      const n = num(form[k]);
      if (n !== null && !(Number.isInteger(n) && n >= lo && n <= hi)) bad[k] = `${label} must be ${lo} to ${hi}.`;
    }
    setErrors(bad);
    if (Object.keys(bad).length) {
      return toasts.add({ variant: "error", title: "Couldn't save", description: Object.values(bad)[0] });
    }
    setBusy(true);
    try {
      const { profile } = await apply<{ profile: Profile }>("profile", send("PUT", { profile: fromForm(form) }));
      setForm(toForm(profile));
      toasts.add({ variant: "success", title: "Saved" });
    } catch {
      toasts.add({ variant: "error", title: "Couldn't save", description: "Try again." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="oj-stack" noValidate onSubmit={(e) => { e.preventDefault(); save(); }}>
      <Card title="Personal details" note="Used to fill in application forms. Your details are saved to your account so you can use them on any computer.">
        <div className="oj-form">
          {text("first_name", "First name", "")}
          {text("last_name", "Last name", "")}
          {text("email", "Email", "you@example.com", "email")}
          {text("phone", "Phone", "+972 50 000 0000", "tel")}
          {text("location", "Location", "Tel Aviv, Israel")}
          {text("linkedin", "LinkedIn", "https://linkedin.com/in/…", "url")}
          {text("github", "GitHub", "https://github.com/…", "url")}
          {text("website", "Website", "https://…", "url")}
        </div>
      </Card>

      <Card title="Work details">
        <div className="oj-form">
          {text("countries", "Authorized to work in", "Country codes, e.g. IL, US")}
          <Select label="Need visa sponsorship" value={form.sponsorship} onValueChange={(v) => set("sponsorship", (v as Form["sponsorship"]) || "skip")}
            items={{ yes: "Yes", no: "No", skip: "Don't fill in" }} />
          {text("notice", "Notice period", "e.g. 30 days")}
          {text("salary", "Salary expectation", "e.g. 35,000 ILS a month")}
        </div>
      </Card>

      <Card title="Optional demographic questions">
        <div className="oj-form">
          {EEO.map(([k, label]) => (
            <div key={k} className="oj-stack oj-tight">
              <Select label={label} value={form.eeo[k].pick} onValueChange={(v) => setEeo(k, { pick: (v as Form["eeo"][EeoKey]["pick"]) || "skip" })}
                items={{ skip: "Don't fill in", decline: "Prefer not to answer", answer: "Your answer" }} />
              {form.eeo[k].pick === "answer" ? (
                <Input aria-label={`${label} answer`} placeholder="Your answer" autoComplete="off" value={form.eeo[k].text}
                  onChange={(e) => setEeo(k, { text: e.target.value })} />
              ) : null}
            </div>
          ))}
        </div>
      </Card>

      <section id="aa-settings">
        <Card title="Application settings">
          <Radio.Group legend="Mode" appearance="card" value={form.mode} onValueChange={(v) => set("mode", v as Form["mode"])}>
            <Radio.Item value="queue" label="Only jobs I queue" description="The extension applies only to jobs you add to your queue." />
            <Radio.Item value="auto" label="Apply automatically" description="The extension applies to jobs that match your preferences, within your plan's limit and any limits you set below." />
          </Radio.Group>
          <Checkbox.Group legend="Where to find jobs" value={form.sources} onValueChange={(v) => set("sources", v as string[])}
            description={<>Your preferences are on your <a className="oj-link" href="/account#preferences">account page</a>.</>}>
            <Checkbox.Item value="board" label="Jobs I add to my queue on Ocean of Jobs" />
            <Checkbox.Item value="matches" label="Jobs matching my preferences" />
            <Checkbox.Item value="ats_pages" label="Jobs I open on Greenhouse, Ashby or Workable" />
            <Checkbox.Item value="mcp" label="Jobs queued by my AI assistant through MCP" />
          </Checkbox.Group>
          <Radio.Group legend="If a form asks a question I haven't answered" appearance="card" value={form.unknowns} onValueChange={(v) => set("unknowns", v as Form["unknowns"])}>
            <Radio.Item value="skip" label="Skip the job" description="Leave it for me to review." />
            <Radio.Item value="ai" label="Draft an answer with AI" description="AI drafts an answer from my details, uses it, and adds it to my saved answers so I can check it later. Included on Basic and Pro. On Free, add your own AI key in the extension's options." />
          </Radio.Group>
        </Card>
      </section>

      <Card title="Application limits" note="Optional. These apply on top of your plan's limit. Leave a field empty for no extra limit.">
        <div className="oj-form">
          {limit("min_match", "Minimum skills match (%)", "e.g. 60")}
          {limit("daily", "Maximum applications per day (up to 50)", "e.g. 10")}
          {limit("per_company", "Days between applications to the same company", "e.g. 30")}
          <div className="oj-wide">
            <InputArea label="Never apply to" rows={2} placeholder="Company domains, one per line, e.g. mycurrentemployer.com"
              value={form.blocked} onValueChange={(v) => set("blocked", v)} />
          </div>
        </div>
      </Card>

      <Card title="Saved answers" note="Save answers to common application questions. The extension reuses them when a question matches and lets you add new answers as you go.">
        {form.answers.map((a) => (
          <div key={a.id} className="oj-answer">
            <Input aria-label="Question" placeholder="Question, e.g. Why do you want to work here?" value={a.question}
              onChange={(e) => setAnswer(a.id, { question: e.target.value })} />
            <InputArea aria-label="Answer" placeholder="Your answer" rows={2} value={a.answer} onValueChange={(v) => setAnswer(a.id, { answer: v })} />
            <div><Button size="sm" variant="ghost" onClick={() => set("answers", form.answers.filter((x) => x.id !== a.id))}>Remove</Button></div>
          </div>
        ))}
        <div>
          <Button size="sm" variant="secondary" icon={<Plus />}
            onClick={() => set("answers", [...form.answers, { id: nextId++, question: "", answer: "" }])}>Add an answer</Button>
        </div>
      </Card>

      <div className="oj-save">
        <Button type="submit" variant="primary" loading={busy}>Save</Button>
      </div>
    </form>
  );
}
