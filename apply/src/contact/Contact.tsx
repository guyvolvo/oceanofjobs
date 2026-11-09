// The contact page (/contact): what this is and the direct ways on the
// left, the form on the right. The form posts to /api/contact, which
// sends it on as one email. Same copy and behaviour as the live page
// (origin/main apply/src/Contact.tsx), on shadcn/ui.
import { useEffect, useId, useState, type ReactNode } from "react";
import { ArrowUpRight, Bug, CheckCircle, EnvelopeSimple, GithubLogo, LinkedinLogo } from "@phosphor-icons/react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Page } from "../shell/Page";
import { useWho } from "../shell/state";

const MAX = 2000;
const TOPICS = ["Question", "Feedback", "Feature request", "Bug report"] as const;
type Topic = (typeof TOPICS)[number];
// One placeholder per topic, asking for the thing that helps: a bug is
// useless without what you expected.
const PLACEHOLDER: Record<Topic, string> = {
  "Question": "e.g. Is the API free for commercial use?",
  "Feedback": "e.g. The salary filter hides roles without a figure.",
  "Feature request": "e.g. Let me filter jobs by company size.",
  "Bug report": "What happened, and what did you expect? e.g. Saving a job did nothing.",
};
const WAYS = [
  { icon: <EnvelopeSimple size={20} />, name: "Email", value: "guyvoloshin@oceanofjobs.com", href: "mailto:guyvoloshin@oceanofjobs.com" },
  { icon: <LinkedinLogo size={20} />, name: "LinkedIn", value: "linkedin.com/in/guyvoloshin", href: "https://www.linkedin.com/in/guyvoloshin" },
  { icon: <GithubLogo size={20} />, name: "GitHub", value: "github.com/guyvolvo", href: "https://github.com/guyvolvo" },
  { icon: <Bug size={20} />, name: "Bug reports", value: "Open an issue in the repository", href: "https://github.com/guyvolvo/oceanofjobs/issues" },
];

// A label, its field, and the line under it: a hint, or the error in its place.
function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? <p id={`${id}-note`} className="m-0 text-[13px] text-destructive" role="alert">{error}</p>
        : hint ? <p id={`${id}-note`} className="m-0 text-[13px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function ContactForm() {
  const id = useId();
  const who = useWho();
  const [topic, setTopic] = useState<Topic>("Question");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [website, setWebsite] = useState("");
  const [errors, setErrors] = useState<{ email?: string; message?: string }>({});
  const [sentTo, setSentTo] = useState("");
  const [busy, setBusy] = useState(false);

  // The name and address of whoever is signed in, from the token this tab
  // already holds. Both stay editable: someone may want a reply elsewhere.
  useEffect(() => {
    if (!who) return;
    setName((n) => n || who.name);
    setEmail((e) => e || who.email);
  }, [who]);

  // A message in progress is not lost to a stray click on a link.
  useEffect(() => {
    if (!message.trim()) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [message]);

  const send = async () => {
    const bad: typeof errors = {};
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email.trim())) bad.email = "An email address is needed for the reply.";
    if (message.trim().length < 10) bad.message = "Add a little more: at least 10 characters.";
    setErrors(bad);
    if (Object.keys(bad).length) return;
    setBusy(true);
    try {
      const r = await fetch("/api/contact", { method: "POST", headers: { "Content-Type": "application/json" },
        // The topic also rides as the message's first line: the API ignores
        // the field, so the line is what carries it into the inbox.
        body: JSON.stringify({ name: name.trim(), email: email.trim(), topic, message: `Topic: ${topic}\n\n${message.trim()}`, website }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setSentTo(email.trim());
      setMessage("");
    } catch {
      setErrors({ message: "Not sent. Try again, or email guyvoloshin@oceanofjobs.com." });
    } finally {
      setBusy(false);
    }
  };

  if (sentTo) {
    // Replaces the form rather than sitting above it, so the page does not
    // offer to send the same message twice.
    return (
      <div className="flex min-h-[340px] flex-col items-start justify-center gap-3" role="status">
        <CheckCircle size={40} className="text-ring" />
        <h2 className="m-0 text-lg font-medium">Message sent</h2>
        <p className="m-0 text-muted-foreground">Thanks, sent to info@oceanofjobs.com</p>
        <div><Button variant="outline" onClick={() => setSentTo("")}>Send another message</Button></div>
      </div>
    );
  }
  return (
    <form className="flex flex-col gap-4" noValidate onSubmit={(e) => { e.preventDefault(); send(); }}>
      <div className="flex flex-col gap-2">
        <span className="font-medium" id={`${id}-topic`}>Select your topic</span>
        {/* Separate buttons, not one joined strip: on a phone the four wrap to two rows. */}
        <ToggleGroup type="single" variant="outline" spacing={2} aria-labelledby={`${id}-topic`} value={topic}
          onValueChange={(v) => { if (v) setTopic(v as Topic); }} className="w-full flex-wrap">
          {TOPICS.map((t) => (
            <ToggleGroupItem key={t} value={t} className="h-9 flex-auto font-ui text-[13px] font-bold data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">{t}</ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      {/* An issue is a better home for a bug than my inbox, so the page says so. */}
      {topic === "Bug report" ? (
        <Alert role="note" className="flex flex-wrap items-center justify-between gap-3 bg-background">
          <AlertTitle className="line-clamp-none">Bugs get fixed faster as a GitHub issue.</AlertTitle>
          <Button asChild variant="outline"><a href="https://github.com/guyvolvo/oceanofjobs/issues/new" target="_blank" rel="noopener"><ArrowUpRight />Open an issue</a></Button>
        </Alert>
      ) : null}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))] items-start gap-3">
        <Field id={`${id}-name`} label="Name">
          <Input id={`${id}-name`} autoComplete="name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field id={`${id}-email`} label="Email" hint={who?.email ? "Filled from your account. For the reply." : "For the reply"} error={errors.email}>
          <Input id={`${id}-email`} type="email" autoComplete="email" spellCheck={false} maxLength={254} required value={email}
            aria-invalid={!!errors.email || undefined} aria-describedby={`${id}-email-note`}
            onChange={(e) => { setEmail(e.target.value); setErrors((x) => ({ ...x, email: undefined })); }} />
        </Field>
      </div>
      <Field id={`${id}-message`} label="Message" hint={`${message.length} / ${MAX}`} error={errors.message}>
        <Textarea id={`${id}-message`} placeholder={PLACEHOLDER[topic]} rows={8} className="min-h-[188px]" maxLength={MAX} required value={message}
          aria-invalid={!!errors.message || undefined} aria-describedby={`${id}-message-note`}
          onChange={(e) => { setMessage(e.target.value); setErrors((x) => ({ ...x, message: undefined })); }} />
      </Field>
      {/* Never shown; a form filler that fills it is not a person. */}
      <div className="absolute -left-[9999px] h-px w-px overflow-hidden" aria-hidden="true">
        <label htmlFor={`${id}-website`}>Website</label>
        <input id={`${id}-website`} name="website" type="text" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
      </div>
      <div><Button type="submit" disabled={busy}>Send message</Button></div>
    </form>
  );
}

export function Contact() {
  return (
    <Page current="contact">
      <div className="mx-auto grid max-w-[1320px] items-start gap-10 px-[clamp(20px,4vw,64px)] pt-[clamp(40px,6vw,80px)] pb-[clamp(48px,7vw,96px)] min-[901px]:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] min-[901px]:gap-[clamp(40px,6vw,96px)]">
        <section className="flex flex-col gap-10">
          <div>
            <h1 className="m-0 mb-4 font-display text-[clamp(40px,6vw,72px)] leading-[0.95] font-normal tracking-[-0.04em]">Get in touch</h1>
            <p className="m-0 max-w-[460px] text-lg leading-[1.45]">Questions, feedback, requests, or bug reports.</p>
          </div>
          <div>
            <h2 className="m-0 border-b border-foreground px-2 pb-2.5 font-display text-sm font-medium">Or reach me directly</h2>
            {WAYS.map((w) => (
              <a key={w.name} className="group grid grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-3.5 border-b px-2 py-3.5 text-foreground hover:bg-muted" href={w.href}
                target={w.href.startsWith("http") ? "_blank" : undefined} rel="noopener">
                <span className="inline-grid size-5 place-items-center" aria-hidden="true">{w.icon}</span>
                <span className="flex min-w-0 flex-col gap-0.5"><span className="text-sm font-bold group-hover:text-link-hover">{w.name}</span><span className="text-sm [overflow-wrap:anywhere]">{w.value}</span></span>
                <ArrowUpRight size={15} aria-hidden="true" />
              </a>
            ))}
          </div>
        </section>
        <section className="-order-1 min-w-0 self-stretch rounded-xl border bg-card p-[clamp(20px,3vw,32px)] min-[901px]:order-none" aria-label="Send a message">
          <ContactForm />
        </section>
      </div>
    </Page>
  );
}
