// The pricing page: the plans as one table on a desktop and as cards on
// a phone (the table has no room there), then the questions. The plans
// themselves are data in ../home/plans.ts, shared with the home page.
import { Badge } from "@cloudflare/kumo/components/badge";
import { LinkButton } from "@cloudflare/kumo/components/button";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Table } from "@cloudflare/kumo/components/table";
import { CheckCircle, Minus } from "@phosphor-icons/react";
import { FAQ, FEATURES, PLANS, type Plan } from "../home/plans";
import { PublicPage } from "../site/PublicPage";
import { boot } from "../site/boot";

const Yes = () => <><CheckCircle size={20} weight="fill" className="text-kumo-brand" aria-hidden="true" /><span className="sr-only">Included</span></>;
const No = () => <><Minus size={16} className="text-kumo-inactive" aria-hidden="true" /><span className="sr-only">Not included</span></>;
const cell = (v: boolean | string) => (v === true ? <Yes /> : v === false ? <No /> : v);
const hot = (p: Plan) => (p.badge ? "bg-kumo-tint" : "");

function Price({ plan }: { plan: Plan }) {
  return <span className="block font-display text-[28px] font-medium leading-none tracking-tight text-kumo-strong">{plan.price}<small className="ml-0.5 font-sans text-sm font-normal text-kumo-subtle">/month</small></span>;
}

function Terms({ plan }: { plan: Plan }) {
  return <p className="mt-2 mb-0 text-[13px] text-kumo-subtle">{plan.terms.before}{plan.terms.deal ? <strong className="font-semibold text-kumo-strong">{plan.terms.deal}</strong> : null}</p>;
}

function Cta({ plan }: { plan: Plan }) {
  return <LinkButton href={plan.cta.href} variant={plan.cta.primary ? "primary" : "secondary"} className="w-full justify-center">{plan.cta.label}</LinkButton>;
}

function PlanTable() {
  return (
    <LayerCard className="hidden md:block p-0 overflow-hidden">
      <Table layout="fixed">
        <caption className="sr-only">Compare plans</caption>
        <Table.Header>
          <Table.Row>
            <Table.Head className="w-[34%] align-bottom">Feature</Table.Head>
            {PLANS.map((p) => (
              <Table.Head key={p.key} className={`align-bottom py-4 ${hot(p)}`}>
                <span className="mb-2 flex items-center gap-2 text-base font-medium text-kumo-strong">{p.name}{p.badge ? <Badge variant="success">{p.badge}</Badge> : null}</span>
                <Price plan={p} />
              </Table.Head>
            ))}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {FEATURES.map((f) => (
            <Table.Row key={f.name}>
              <Table.Cell className="whitespace-normal"><span className="text-kumo-strong">{f.name}</span>{f.note ? <small className="block text-[13px] text-kumo-subtle">{f.note}</small> : null}</Table.Cell>
              {PLANS.map((p) => <Table.Cell key={p.key} className={`whitespace-normal ${hot(p)}`}>{cell(f[p.key])}</Table.Cell>)}
            </Table.Row>
          ))}
        </Table.Body>
        <Table.Footer>
          <Table.Row>
            <Table.Cell><span className="sr-only">Get the plan</span></Table.Cell>
            {PLANS.map((p) => <Table.Cell key={p.key} className={`whitespace-normal align-top py-4 ${hot(p)}`}><Cta plan={p} /><Terms plan={p} /></Table.Cell>)}
          </Table.Row>
        </Table.Footer>
      </Table>
    </LayerCard>
  );
}

function PlanCards() {
  return (
    <div className="grid gap-4 md:hidden">
      {PLANS.map((p) => (
        <LayerCard key={p.key} render={<section aria-labelledby={`plan-${p.key}`} />} className={`p-5 ${hot(p)}`}>
          <h2 id={`plan-${p.key}`} className="m-0 flex items-center gap-2 text-base font-medium text-kumo-strong">{p.name}{p.badge ? <Badge variant="success">{p.badge}</Badge> : null}</h2>
          <p className="my-2"><Price plan={p} /></p>
          <p className="my-2 text-kumo-subtle">{p.desc}</p>
          {p.plus ? <p className="mt-3 mb-1 text-sm font-medium text-kumo-strong">{p.plus}</p> : null}
          <ul className="m-0 mb-4 list-none p-0">
            {p.features.map((f) => <li key={f} className="flex items-start gap-2 py-1"><CheckCircle size={18} weight="fill" className="mt-0.5 flex-none text-kumo-brand" aria-hidden="true" /><span>{f}</span></li>)}
          </ul>
          <Cta plan={p} />
          <Terms plan={p} />
        </LayerCard>
      ))}
    </div>
  );
}

const link = "underline underline-offset-4 hover:text-kumo-link";

boot(
  <PublicPage current="pricing" wide>
    <section aria-labelledby="pricing-title" className="pt-10">
      <h1 id="pricing-title" className="m-0 font-sans text-[26px] font-semibold leading-tight tracking-tight text-kumo-strong">Pricing plans</h1>
      <p className="mt-3 mb-8 max-w-[70ch] text-base text-kumo-default">Searching jobs, setting alerts, using the REST API, and connecting AI assistants through MCP are all free. The Ocean of Jobs browser extension fills out applications in your browser and can submit them for you. Filling is free on every plan; paid plans submit more.</p>
      <PlanTable />
      <PlanCards />
      <p className="mt-6 text-sm text-kumo-subtle">
        You can cancel a paid plan anytime. Prices are in USD, and taxes are added at checkout. Dodo Payments handles payments.<br />
        <a className={link} href="/refunds">Refund policy</a> · <a className={link} href="/terms">Terms of service</a> · Questions? <a className={link} href="/contact">Get in touch</a>.
      </p>
    </section>
    <section aria-labelledby="faq-title" className="pt-14">
      <h2 id="faq-title" className="m-0 mb-6 font-sans text-[22px] font-semibold leading-tight tracking-tight text-kumo-strong">Frequently asked questions</h2>
      <div className="grid gap-x-10 gap-y-8 md:grid-cols-2">
        {FAQ.map((f) => (
          <div key={f.q}>
            <h3 className="m-0 mb-2 text-base font-medium text-kumo-strong">{f.q}</h3>
            <p className="m-0 text-kumo-default">{f.q.startsWith("Can I cancel") ? <>{f.a.replace(/refund policy\.$/, "")}<a className={link} href="/refunds">refund policy</a>.</> : f.a}</p>
          </div>
        ))}
      </div>
      <p className="mt-8 text-sm text-kumo-subtle"><a className={link} href="/refunds">Refund policy</a> · <a className={link} href="/terms">Terms of service</a></p>
    </section>
  </PublicPage>,
);
