// The contact page (/contact): what this is and the direct ways on the
// left, plain prerendered HTML; the form on the right, the page's island.
import { ArrowUpRight, Bug, EnvelopeSimple, GithubLogo, LinkedinLogo } from "@phosphor-icons/react";
import { Island } from "../shell/island";
import { Page } from "../shell/Page";
import { ContactForm } from "./ContactForm";

const WAYS = [
  { icon: <EnvelopeSimple size={20} />, name: "Email", value: "guyvoloshin@oceanofjobs.com", href: "mailto:guyvoloshin@oceanofjobs.com" },
  { icon: <LinkedinLogo size={20} />, name: "LinkedIn", value: "linkedin.com/in/guyvoloshin", href: "https://www.linkedin.com/in/guyvoloshin" },
  { icon: <GithubLogo size={20} />, name: "GitHub", value: "github.com/guyvolvo", href: "https://github.com/guyvolvo" },
  { icon: <Bug size={20} />, name: "Bug reports", value: "Open an issue in the repository", href: "https://github.com/guyvolvo/oceanofjobs/issues" },
];

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
          <Island name="contact-form" component={ContactForm} props={{}} />
        </section>
      </div>
    </Page>
  );
}
