// The contact page (/contact): the static page's layout (style.css
// .contact-*), its form in Kumo. A third page of this build, copied over
// frontend/contact.html at deploy (deploy-frontend.yml), so /contact
// still serves contact.html. The form posts to /api/contact, which sends
// it on as one email.
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Input, InputArea } from "@cloudflare/kumo/components/input";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { Banner } from "@cloudflare/kumo/components/banner";
import { ArrowUpRight, Bug, CheckCircle, EnvelopeSimple, GithubLogo, LinkedinLogo } from "@phosphor-icons/react";
import "@cloudflare/kumo/styles/standalone";
import "./app.css";
import "./contact.css";

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

// The name and address of whoever is signed in, from the token this tab
// already holds. Both stay editable: someone may want a reply elsewhere.
function signedIn() {
  const t = typeof getAuthTokens === "function" ? getAuthTokens() : null;
  return t?.id_token ? { email: decodeJwtEmail(t.id_token) || "", name: decodeJwtName(t.id_token) || "" } : { email: "", name: "" };
}

function Contact() {
  const [me] = useState(signedIn);
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
    <main className="contact-shell" id="main" tabIndex={-1}>
      <section className="contact-intro">
        <div className="contact-claim">
          <h1>Get in touch</h1>
          <p>Questions, feedback, requests, or bug reports.</p>
        </div>
        <div className="contact-direct">
          <h2>Or reach me directly</h2>
          {WAYS.map((w) => (
            <a key={w.name} className="contact-way" href={w.href} target={w.href.startsWith("http") ? "_blank" : undefined} rel="noopener">
              <span className="contact-way-icon" aria-hidden="true">{w.icon}</span>
              <span className="contact-way-text"><span className="contact-way-name">{w.name}</span><span className="contact-way-value">{w.value}</span></span>
              <ArrowUpRight className="contact-way-go" aria-hidden="true" />
            </a>
          ))}
        </div>
      </section>

      <LayerCard className="contact-card" aria-label="Send a message">
        <div className="oj-card-body">
          {sentTo ? (
            // Replaces the form rather than sitting above it, so the page
            // does not offer to send the same message twice.
            <div className="contact-sent" role="status">
              <CheckCircle size={40} className="contact-sent-mark" />
              <h2 className="oj-card-title">Message sent</h2>
              <p className="oj-note">Thanks, sent to info@oceanofjobs.com</p>
              <div><Button variant="secondary" onClick={() => setSentTo("")}>Send another message</Button></div>
            </div>
          ) : (
            <form className="oj-stack" noValidate onSubmit={(e) => { e.preventDefault(); send(); }}>
              <div className="contact-topic">
                <span className="contact-label" id="topic-label">Select your topic</span>
                <nav className="oj-tabs" aria-labelledby="topic-label">
                  <Tabs variant="segmented" tabs={TOPICS.map((t) => ({ value: t, label: t }))} value={topic} onValueChange={(v) => setTopic(v as Topic)} />
                </nav>
              </div>
              {/* An issue is a better home for a bug than my inbox, so the page says so. */}
              {topic === "Bug report" ? (
                <Banner variant="default" title="Bugs get fixed faster as a GitHub issue."
                  action={<LinkButton variant="secondary" icon={<ArrowUpRight />} href="https://github.com/guyvolvo/oceanofjobs/issues/new" target="_blank" rel="noopener">Open an issue</LinkButton>} />
              ) : null}
              <div className="contact-pair">
                <Input label="Name" autoComplete="name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
                <Input label="Email" description={me.email ? "Filled from your account. For the reply." : "For the reply"} type="email" autoComplete="email"
                  spellCheck={false} maxLength={254} required value={email} error={errors.email}
                  onChange={(e) => { setEmail(e.target.value); setErrors((x) => ({ ...x, email: undefined })); }} />
              </div>
              <InputArea label="Message" placeholder={PLACEHOLDER[topic]} minRows={8} autoResize maxLength={MAX} required
                description={`${message.length} / ${MAX}`} error={errors.message}
                value={message} onValueChange={(v) => { setMessage(v); setErrors((x) => ({ ...x, message: undefined })); }} />
              {/* Never shown; a form filler that fills it is not a person. */}
              <div className="contact-trap" aria-hidden="true">
                <label htmlFor="contact-website">Website</label>
                <input id="contact-website" name="website" type="text" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
              </div>
              <div className="oj-row">
                <Button type="submit" variant="primary" loading={busy}>Send message</Button>
              </div>
            </form>
          )}
        </div>
      </LayerCard>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Contact /></StrictMode>);
