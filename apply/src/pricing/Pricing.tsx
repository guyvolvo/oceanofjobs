// The pricing page (/pricing): the plans as one table on a desktop and as
// cards on a phone (the table has no room there), then the questions.
// Same copy, prices and links as frontend/pricing.html; the plans are data
// in ../home/plans.ts, shared with the home page.
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FAQ, FEATURES, HOT_PLAN, PLANS, PRICING_INTRO, type Plan } from "../home/plans";
import { Page } from "../shell/Page";

// Included: a check knocked out of a filled circle, ink on ink.
const Check = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 20 20" aria-hidden="true" className={cn("block size-5 flex-none", className)}>
    <circle cx="10" cy="10" r="10" className="fill-foreground" />
    <path d="M5.8 10.4l2.8 2.8 5.6-6" className="fill-none stroke-background" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const cell = (v: boolean | string) => v === true ? <><Check /><span className="sr-only">Included</span></>
  : v === false ? <><span aria-hidden="true">&mdash;</span><span className="sr-only">Not included</span></> : v;
const hot = (p: Plan) => p.key === HOT_PLAN && "bg-muted";
const link = "underline underline-offset-3 hover:text-link-hover";

const Badge = ({ children }: { children: string }) => (
  <span className="inline-block rounded-full bg-accent px-[9px] py-1 text-xs font-medium whitespace-nowrap">{children}</span>
);
const Name = ({ plan, as: Tag = "span", id }: { plan: Plan; as?: "span" | "h3"; id?: string }) => (
  <Tag id={id} className={cn("m-0 flex items-center gap-2 text-[15px] leading-[1.2] font-medium", Tag === "h3" && "font-heading")}>{plan.name}{plan.badge ? <Badge>{plan.badge}</Badge> : null}</Tag>
);
const Price = ({ plan, className }: { plan: Plan; className?: string }) => (
  <span className={cn("mt-2.5 block text-[32px] leading-none font-medium tracking-[-0.03em]", className)}>
    {plan.price}<small className="ml-1.5 font-mono text-[13px] font-normal tracking-normal text-muted-foreground">/month</small>
  </span>
);
const Cta = ({ plan }: { plan: Plan }) => (
  <Button asChild variant={plan.cta.primary ? "default" : "secondary"}
    className="h-[42px] rounded-full border-0 px-[18px] font-sans text-sm font-medium">
    <a href={plan.cta.href}>{plan.cta.label}</a>
  </Button>
);
const Terms = ({ plan }: { plan: Plan }) => (
  <p className="mt-2.5 mb-0 text-[13px] text-dim">{plan.terms.before}{plan.terms.deal ? <strong className="font-semibold text-foreground">{plan.terms.deal}</strong> : null}</p>
);

function PlanTable() {
  const th = "border-b px-5 py-4 text-left align-top font-normal";
  return (
    <div className="overflow-hidden rounded-[16px] border bg-background max-[700px]:hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-[15px] leading-[1.4]">
          <caption className="sr-only">Compare plans</caption>
          <thead>
            <tr>
              <th scope="col" className={cn(th, "pt-7 pb-5 align-bottom text-sm text-muted-foreground")}>Feature</th>
              {PLANS.map((p) => (
                <th key={p.key} scope="col" className={cn(th, "pt-7 pb-5 align-bottom", hot(p))}><Name plan={p} /><Price plan={p} /></th>
              ))}
            </tr>
          </thead>
          <tbody>
            {FEATURES.map((f) => (
              <tr key={f.name}>
                <th scope="row" className={cn(th, "w-[30%] font-medium")}>{f.name}{f.note ? <small className="mt-1 block text-[13px] font-normal text-muted-foreground">{f.note}</small> : null}</th>
                {PLANS.map((p) => <td key={p.key} className={cn(th, hot(p))}>{cell(f[p.key])}</td>)}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" className={cn(th, "border-b-0 pt-6 pb-7")}><span className="sr-only">Get the plan</span></th>
              {PLANS.map((p) => <td key={p.key} className={cn(th, "border-b-0 pt-6 pb-7", hot(p))}><Cta plan={p} /><Terms plan={p} /></td>)}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// The same plans for a phone, where the table has no room.
function PlanCards() {
  return (
    <div className="hidden gap-3 max-[700px]:grid">
      {PLANS.map((p) => (
        <section key={p.key} aria-labelledby={`m-plan-${p.key}`} className={cn("rounded-[16px] border bg-background p-5", p.key === HOT_PLAN && "bg-[linear-gradient(var(--muted),var(--muted))]")}>
          <Name plan={p} as="h3" id={`m-plan-${p.key}`} />
          <p className="m-0"><Price plan={p} className="text-[28px]" /></p>
          <p className="mt-2 mb-0 text-sm leading-[1.45] text-muted-foreground">{p.desc}</p>
          {p.plus ? <p className="mt-4 mb-0 text-[13px] text-muted-foreground">{p.plus}</p> : null}
          <ul className={cn("mt-3 mb-[18px] flex list-none flex-col gap-2.5 p-0 text-sm leading-[1.4]", !p.plus && "mt-4")}>
            {p.features.map((f) => <li key={f} className="flex items-start gap-2.5"><Check className="mt-px size-[18px]" /><span>{f}</span></li>)}
          </ul>
          <Cta plan={p} />
          <Terms plan={p} />
        </section>
      ))}
    </div>
  );
}

const section = "px-10 pb-28 max-[640px]:px-4 max-[640px]:pb-20";
const wrap = "mx-auto max-w-[1180px]";
const h = "m-0 max-w-[720px] font-heading text-[40px] leading-[1.1] font-medium tracking-[-0.03em] max-[640px]:text-[32px]";

export function Pricing() {
  return (
    <Page current="pricing" footer>
      <div className="h-[72px] max-[900px]:h-8" />
      <section id="pricing" aria-labelledby="pricing-title" className={section}>
        <div className={wrap}>
          <h1 id="pricing-title" className={h}>Pricing plans</h1>
          <p className="mt-3.5 mb-0 max-w-[620px] text-[17px] leading-[1.55] text-body">{PRICING_INTRO}</p>
          {/* The plans on a dither panel, as on the home page. */}
          <div className="relative isolate mt-[68px] before:pointer-events-none before:absolute before:-inset-6 before:-z-10 before:rounded-[16px] before:bg-[url(/img/dither-pricing.png)] before:bg-[length:1920px_1200px] before:bg-center before:opacity-90 before:brightness-90 before:[image-rendering:pixelated] max-[640px]:before:inset-x-[-16px]">
            <PlanTable />
            <PlanCards />
          </div>
          <p className="mt-10 mb-0 text-[13px] text-dim">
            You can cancel a paid plan anytime. Prices are in USD, and taxes are added at checkout. Dodo Payments handles payments.<br />
            <a className={link} href="/refunds">Refund policy</a> · <a className={link} href="/terms">Terms of service</a> · Questions? <a className={link} href="/contact">Get in touch</a>.
          </p>
        </div>
      </section>
      <section aria-labelledby="faq-title" className={section}>
        <div className={wrap}>
          <h2 id="faq-title" className={h}>Frequently asked questions</h2>
          <div className="mt-9 grid grid-cols-2 gap-x-12 gap-y-8 max-[900px]:grid-cols-1">
            {FAQ.map((f) => (
              <div key={f.q} className="py-2 pr-6 max-[640px]:pr-0">
                <h3 className="m-0 font-heading text-xl leading-[1.25] font-medium tracking-[-0.02em]">{f.q}</h3>
                <p className="mt-2 mb-0 text-sm leading-[1.6] text-muted-foreground">
                  {f.a.endsWith("refund policy.") ? <>{f.a.slice(0, -"refund policy.".length)}<a className={cn(link, "text-foreground")} href="/refunds">refund policy</a>.</> : f.a}
                </p>
              </div>
            ))}
          </div>
          <p className="mt-10 mb-0 text-[13px] text-dim"><a className={link} href="/refunds">Refund policy</a> · <a className={link} href="/terms">Terms of service</a></p>
        </div>
      </section>
    </Page>
  );
}
