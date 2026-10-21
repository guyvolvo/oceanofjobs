// Your own AI agent (api/agent.py, api/AI_AGENT_DESIGN.md): how AI answers
// sound, facts it may use, fixed answers to common questions, what it must
// never claim, and whether new AI answers wait for the user. The server
// enforces every rule here; the checks below only name the field.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Input, InputArea } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { Radio } from "@cloudflare/kumo/components/radio";
import { Button } from "@cloudflare/kumo/components/button";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Loader } from "@cloudflare/kumo/components/loader";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { Info, Plus, WarningCircle } from "@phosphor-icons/react";
import { apply, send, ApiError } from "./api";

type Topic = "referral_source" | "start_date" | "relocation" | "onsite_days" | "why_company" | "why_role";
type Action = "answer" | "ai" | "ask";
type AgentData = {
  version: number;
  style: { tone: "plain" | "warm" | "formal"; length: "short" | "medium"; language: "question" | "en"; notes: string };
  facts: { id: string; text: string }[];
  topics: Record<Topic, { action: Action; value: string }>;
  never_claim: string[];
  review: "pause" | "use";
  editable: boolean;
};
type Row = { key: number; text: string };
type Form = Omit<AgentData, "facts" | "never_claim" | "editable"> & { facts: Row[]; never: Row[] };

// Questions the agent recognises, in the words forms use. "Why" questions
// are about one company or role, so they can't have one fixed answer.
const TOPICS: [Topic, string, string][] = [
  ["referral_source", "How did you hear about us?", "e.g. LinkedIn"],
  ["start_date", "When can you start?", "e.g. 30 days after an offer"],
  ["relocation", "Are you willing to relocate?", "e.g. No"],
  ["onsite_days", "How many days a week can you work in the office?", "e.g. 3 days a week"],
  ["why_company", "Why do you want to work here?", ""],
  ["why_role", "Why are you interested in this role?", ""],
];
const JOB_TOPICS: Topic[] = ["why_company", "why_role"];
const LIMITS = { notes: 500, facts: 20, fact: 300, never: 30, phrase: 100, value: 300 };
const SOURCE: Record<string, string> = {
  fixed: "Your fixed answer", saved: "One of your saved answers", profile: "From your Settings", ai: "Written by the AI. This used 1 AI answer.",
};
// A job on the board, from its link or its id: oceanofjobs.com/job/<id>.
const jobId = (text: string) => (/(?:\/job\/)?([0-9a-f]{8,32})\b/i.exec(text.trim()) || [])[1]?.toLowerCase() || "";

let nextKey = 0;
const rows = (texts: string[]): Row[] => texts.map((text) => ({ key: nextKey++, text }));

function toForm(a: AgentData): Form {
  return { version: a.version, style: a.style, topics: a.topics, review: a.review, facts: rows(a.facts.map((f) => f.text)), never: rows(a.never_claim) };
}

function Card({ title, note, children }: { title: string; note?: ReactNode | ReactNode[]; children: ReactNode }) {
  return (
    <LayerCard>
      <div className="oj-card-body">
        <h2 className="oj-card-title">{title}</h2>
        {(Array.isArray(note) ? note : note ? [note] : []).map((n, i) => <p key={i} className="oj-note">{n}</p>)}
        {children}
      </div>
    </LayerCard>
  );
}

function List({ items, onChange, max, limit, label, placeholder, area }: {
  items: Row[]; onChange: (r: Row[]) => void; max: number; limit: number; label: string; placeholder: string; area?: boolean;
}) {
  const set = (key: number, text: string) => onChange(items.map((r) => (r.key === key ? { ...r, text } : r)));
  return (
    <div className="oj-stack">
      {items.map((r, i) => (
        <div key={r.key} className="oj-answer">
          {area ? (
            <InputArea aria-label={`${label} ${i + 1}`} placeholder={placeholder} autoResize minRows={2} maxLength={limit} value={r.text} onValueChange={(v) => set(r.key, v)} />
          ) : (
            <Input aria-label={`${label} ${i + 1}`} placeholder={placeholder} maxLength={limit} value={r.text} onChange={(e) => set(r.key, e.target.value)} />
          )}
          <div><Button size="sm" variant="ghost" onClick={() => onChange(items.filter((x) => x.key !== r.key))}>Remove</Button></div>
        </div>
      ))}
      <div>
        <Button size="sm" variant="secondary" icon={<Plus />} disabled={items.length >= max}
          onClick={() => onChange([...items, { key: nextKey++, text: "" }])}>{items.length >= max ? `Up to ${max}` : `Add ${label.toLowerCase()}`}</Button>
      </div>
    </div>
  );
}

function TryIt({ editable }: { editable: boolean }) {
  const [question, setQuestion] = useState("");
  const [job, setJob] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ answer?: string; source?: string; review?: boolean; refused?: string } | null>(null);
  const run = async () => {
    if (!question.trim()) return;
    setBusy(true);
    try {
      const id = jobId(job);
      const r = await apply<{ answer: string; source: string; always_review?: boolean }>("agent/preview",
        send("POST", { question: question.trim(), ...(id ? { job: { id } } : {}) }));
      setResult({ answer: r.answer, source: r.source, review: r.always_review });
    } catch (e) {
      setResult({ refused: e instanceof ApiError && e.status !== 0 && e.status < 500 ? e.message : "Couldn't reach the AI. Try again." });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Try it" note={["Enter a question like one you'd see on a job application. Save your changes first to test them.",
      "Each answer generated by the AI uses one of your monthly AI answers. Your saved answers and fixed answers don't count toward that limit."]}>
      <div className="oj-row">
        <div className="oj-grow">
          <Input aria-label="Question to try" placeholder="e.g. When can you start?" value={question} disabled={!editable}
            onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); run(); } }} />
        </div>
        <Button variant="secondary" loading={busy} disabled={!editable || !question.trim()} onClick={run}>Try it</Button>
      </div>
      <Input label="Job (optional)" placeholder="Paste a job link from Ocean of Jobs, e.g. oceanofjobs.com/job/486388384e045a4a" value={job}
        disabled={!editable} onChange={(e) => setJob(e.target.value)}
        description="Questions about why you want a job, like &quot;What do you like about this company?&quot;, are drafted from that job's posting." />
      {result ? (
        result.refused ? (
          <p className="oj-note" role="status">No answer: {result.refused}. In a real application, this question would wait for you in Needs attention.</p>
        ) : (
          <div className="oj-stack oj-tight" role="status">
            <p className="oj-try-answer">{result.answer}</p>
            <span className="oj-note">{SOURCE[result.source || ""] || result.source}</span>
            {result.review ? <span className="oj-note">A draft about why you want this job. It always waits for your review, even with Send without review on.</span> : null}
          </div>
        )
      ) : null}
    </Card>
  );
}

export function Agent() {
  const toasts = useKumoToastManager();
  const [form, setForm] = useState<Form | null>(null);
  const [editable, setEditable] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoadFailed(false);
    setConflict(false);
    apply<{ agent: AgentData }>("agent").then((r) => { setForm(toForm(r.agent)); setEditable(r.agent.editable); }).catch(() => setLoadFailed(true));
  }, []);
  useEffect(load, [load]);

  if (loadFailed) {
    return <Banner variant="error" icon={<WarningCircle weight="fill" />} title="Couldn't load your AI agent." action={<Button size="sm" onClick={load}>Try again</Button>} />;
  }
  if (!form) return <div className="oj-row oj-note"><Loader /> Loading your AI agent</div>;

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const setStyle = (patch: Partial<Form["style"]>) => set("style", { ...form.style, ...patch });
  const setTopic = (t: Topic, patch: Partial<Form["topics"][Topic]>) => set("topics", { ...form.topics, [t]: { ...form.topics[t], ...patch } });

  const save = async () => {
    const missing = TOPICS.find(([t]) => form.topics[t].action === "answer" && !form.topics[t].value.trim());
    if (missing) return toasts.add({ variant: "error", title: "Couldn't save", description: `Add your answer to "${missing[1]}", or choose another option.` });
    setBusy(true);
    try {
      const body = {
        version: form.version, style: { ...form.style, notes: form.style.notes.trim() }, topics: form.topics, review: form.review,
        facts: form.facts.map((r) => ({ text: r.text.trim() })).filter((f) => f.text),
        never_claim: form.never.map((r) => r.text.trim()).filter(Boolean),
      };
      const { agent } = await apply<{ agent: AgentData }>("agent", send("PUT", body));
      setForm(toForm(agent));
      toasts.add({ variant: "success", title: "Saved" });
    } catch (e) {
      if (e instanceof ApiError && e.code === "conflict") setConflict(true);
      else toasts.add({ variant: "error", title: "Couldn't save", description: e instanceof ApiError && e.status === 400 ? e.message : "Try again." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="oj-stack" noValidate onSubmit={(e) => { e.preventDefault(); save(); }}>
      {!editable ? (
        <Banner variant="default" icon={<Info weight="fill" />} title="Your own AI agent is part of Basic and Pro"
          description="You can see how it works here. To change it, upgrade your plan." action={<a className="oj-link" href="/pricing">Compare plans</a>} />
      ) : null}
      {conflict ? (
        <Banner variant="alert" icon={<WarningCircle weight="fill" />} title="Your agent was changed in another tab"
          description="Reload to see the latest version, then make your changes again." action={<Button size="sm" onClick={load}>Reload</Button>} />
      ) : null}
      <fieldset className="oj-fieldset" disabled={!editable}>
        <div className="oj-stack">
          <Card title="AI answers">
            <Radio.Group appearance="card" value={form.review} onValueChange={(v) => set("review", v as Form["review"])}>
              <Radio.Legend className="sr-only">When the AI writes a new answer</Radio.Legend>
              <Radio.Item value="pause" label="Review before sending (recommended)"
                description="The job waits in Needs attention until you review the answer. You can approve it as written or make changes. Nothing is sent before you approve it." />
              <Radio.Item value="use" label="Send without review"
                description="New AI answers are sent to employers without your approval. The checks catch many mistakes, but they can't catch everything. An incorrect answer could still be sent in your name. You can see which answers the AI wrote in History." />
            </Radio.Group>
          </Card>

          <Card title="About you" note={["Add facts the AI can use when answering questions. Only include things that are true. For example: \"I led a team of five engineers at Acme from 2021 to 2024.\"",
            <>Salary, notice period, work authorization, and location are managed in <a className="oj-link" href="#settings">Settings</a>.</>]}>
            <List items={form.facts} onChange={(r) => set("facts", r)} max={LIMITS.facts} limit={LIMITS.fact} label="Fact" area
              placeholder="A fact about your experience" />
          </Card>

          <Card title="Common questions" note="Set answers to questions you're often asked. The AI uses your saved answers and facts, and leaves a question unanswered when it doesn't have enough information.">
            <div className="oj-stack">
              {TOPICS.map(([t, label, placeholder]) => {
                const jobTopic = JOB_TOPICS.includes(t);
                const items: Record<string, string> = jobTopic
                  ? { ai: "Let the AI answer from my facts", ask: "Ask me every time" }
                  : { ai: "Let the AI answer from my facts", answer: "Use my answer", ask: "Ask me every time" };
                return (
                  <div key={t} className="oj-form">
                    <Select className="oj-select" label={label} value={form.topics[t].action} items={items}
                      onValueChange={(v) => setTopic(t, { action: (v as Action) || "ai" })} />
                    {form.topics[t].action === "answer" ? (
                      <Input label="Your answer" placeholder={placeholder} maxLength={LIMITS.value} value={form.topics[t].value}
                        onChange={(e) => setTopic(t, { value: e.target.value })} />
                    ) : null}
                  </div>
                );
              })}
            </div>
          </Card>

          <Card title="Never claim" note={`List things the AI must never claim about you, such as having a degree or a security clearance. You can add up to ${LIMITS.never} phrases.`}>
            <List items={form.never} onChange={(r) => set("never", r)} max={LIMITS.never} limit={LIMITS.phrase} label="Phrase" placeholder="e.g. security clearance" />
          </Card>

          <Card title="How answers sound" note="Set the tone and wording you prefer. These instructions affect how answers are written, not what the AI knows about you.">
            <div className="oj-form">
              <Select className="oj-select" label="Tone" value={form.style.tone} items={{ plain: "Plain", warm: "Warm", formal: "Formal" }}
                onValueChange={(v) => setStyle({ tone: (v as Form["style"]["tone"]) || "plain" })} />
              <Select className="oj-select" label="Length" value={form.style.length} items={{ short: "One or two sentences", medium: "Up to four sentences" }}
                onValueChange={(v) => setStyle({ length: (v as Form["style"]["length"]) || "medium" })} />
              <Select className="oj-select" label="Language" value={form.style.language} items={{ question: "Same as the question", en: "Always English" }}
                onValueChange={(v) => setStyle({ language: (v as Form["style"]["language"]) || "question" })} />
              <div className="oj-wide">
                <InputArea label="Style notes" autoResize minRows={2} maxLength={LIMITS.notes} placeholder="e.g. No exclamation marks."
                  value={form.style.notes} onValueChange={(v) => setStyle({ notes: v })} />
              </div>
            </div>
          </Card>
        </div>
      </fieldset>

      <div className="oj-save">
        <Button type="submit" variant="primary" loading={busy} disabled={!editable}>Save</Button>
      </div>

      <TryIt editable={editable} />
    </form>
  );
}
