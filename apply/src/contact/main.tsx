// The contact page (/contact): the form posts to /api/contact, which
// sends it on as one email. The direct ways sit beside it.
import { useEffect, useState } from "react";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Input, InputArea } from "@cloudflare/kumo/components/input";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { Banner } from "@cloudflare/kumo/components/banner";
import { ArrowUpRight, Bug, CheckCircle, EnvelopeSimple, GithubLogo, LinkedinLogo } from "@phosphor-icons/react";
import { PublicPage } from "../site/PublicPage";
import { readWho } from "../site/auth";
import { boot } from "../site/boot";

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

function Contact() {
  // The name and address of whoever is signed in, from the token this
  // tab already holds. Both stay editable: someone may want a reply elsewhere.
  const [me] = useState(() => readWho() || { email: "", name: "" });
  const [topic, setTopic] = useState<Topic>("Question");
  const [name, setName] = useState(me.name);
  const [email, setEmail] = useState(me.email);
  const [message, setMessage] = useState("");
  const [website, setWebsite] = useState("");
  const [errors, setErrors] = useState<{ email?: string; message?: string }>({});
  const [sentTo, setSentTo] = useState("");
  const [busy, setBusy] = useState(false);

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

  return (
    <div className="grid gap-10 pt-10 pb-4 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] md:gap-14">
      <section className="flex flex-col gap-10">
        <div>
          <h1 className="m-0 font-sans text-[26px] font-semibold leading-tight tracking-tight text-kumo-strong">Get in touch</h1>
          <p className="mt-2 mb-0 max-w-[460px] text-lg text-kumo-subtle">Questions, feedback, requests, or bug reports.</p>
        </div>
        <div>
          <h2 className="m-0 mb-2 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">Or reach me directly</h2>
          {WAYS.map((w) => (
            <a key={w.name} className="group -mx-2 flex items-center gap-3 rounded-lg px-2 py-2.5 no-underline hover:bg-kumo-tint" href={w.href} target={w.href.startsWith("http") ? "_blank" : undefined} rel="noopener">
              <span className="inline-grid place-items-center text-kumo-strong" aria-hidden="true">{w.icon}</span>
              <span className="flex min-w-0 flex-col gap-0.5"><span className="text-sm font-semibold text-kumo-strong group-hover:text-kumo-brand">{w.name}</span><span className="text-sm text-kumo-subtle [overflow-wrap:anywhere]">{w.value}</span></span>
              <ArrowUpRight className="ml-auto flex-none text-kumo-subtle" aria-hidden="true" />
            </a>
          ))}
        </div>
      </section>

      <LayerCard className="min-w-0 self-start p-5 sm:p-7" aria-label="Send a message">
        {sentTo ? (
          // Replaces the form rather than sitting above it, so the page
          // does not offer to send the same message twice.
          <div className="flex min-h-[340px] flex-col items-start justify-center gap-3" role="status">
            <CheckCircle size={40} className="text-kumo-success" />
            <h2 className="m-0 text-lg font-medium text-kumo-strong">Message sent</h2>
            <p className="m-0 text-kumo-subtle">Thanks, sent to info@oceanofjobs.com</p>
            <div><Button variant="secondary" onClick={() => setSentTo("")}>Send another message</Button></div>
          </div>
        ) : (
          <form className="flex flex-col gap-4" noValidate onSubmit={(e) => { e.preventDefault(); send(); }}>
            <div className="flex flex-col gap-2">
              <span className="font-medium text-kumo-strong" id="topic-label">Select your topic</span>
              <nav aria-labelledby="topic-label">
                <Tabs variant="segmented" tabs={TOPICS.map((t) => ({ value: t, label: t }))} value={topic} onValueChange={(v) => setTopic(v as Topic)} />
              </nav>
            </div>
            {/* An issue is a better home for a bug than my inbox, so the page says so. */}
            {topic === "Bug report" ? (
              <Banner variant="default" title="Bugs get fixed faster as a GitHub issue."
                action={<LinkButton variant="secondary" icon={<ArrowUpRight />} href="https://github.com/guyvolvo/oceanofjobs/issues/new" target="_blank" rel="noopener">Open an issue</LinkButton>} />
            ) : null}
            <div className="grid items-start gap-3 sm:grid-cols-2">
              <Input label="Name" autoComplete="name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
              <Input label="Email" description={me.email ? "Filled from your account. For the reply." : "For the reply"} type="email" autoComplete="email"
                spellCheck={false} maxLength={254} required value={email} error={errors.email}
                onChange={(e) => { setEmail(e.target.value); setErrors((x) => ({ ...x, email: undefined })); }} />
            </div>
            <InputArea label="Message" placeholder={PLACEHOLDER[topic]} minRows={8} autoResize maxLength={MAX} required
              description={`${message.length} / ${MAX}`} error={errors.message}
              value={message} onValueChange={(v) => { setMessage(v); setErrors((x) => ({ ...x, message: undefined })); }} />
            {/* Never shown; a form filler that fills it is not a person. */}
            <div className="absolute -left-[9999px] h-px w-px overflow-hidden" aria-hidden="true">
              <label htmlFor="contact-website">Website</label>
              <input id="contact-website" name="website" type="text" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
            </div>
            <div><Button type="submit" variant="primary" loading={busy}>Send message</Button></div>
          </form>
        )}
      </LayerCard>
    </div>
  );
}

boot(<PublicPage current="contact" wide><Contact /></PublicPage>);
