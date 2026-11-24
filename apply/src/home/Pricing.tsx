// The plans compared: one table on the dither panel, and the same plans as
// stacked cards for a phone (home.css swaps them under 700px). Shared by
// the home page's pricing section and /pricing.
import { CheckCircle } from "@/components/icons";
import type { ReactNode } from "react";
import { FEATURES, HOT_PLAN, PLANS, type Plan } from "./plans";

const Check = () => <CheckCircle className="ptable-yes" weight="fill" />;
const Yes = () => <><Check /><span className="sr-only">Included</span></>;

function Cell({ v }: { v: boolean | string }) {
  if (v === true) return <Yes />;
  if (v === false) return <><span aria-hidden="true">&mdash;</span><span className="sr-only">Not included</span></>;
  return <>{v}</>;
}

function Name({ p, as: Tag = "span", id }: { p: Plan; as?: "span" | "h3"; id?: string }) {
  return <Tag className="ptable-plan" id={id}>{p.name}{p.badge ? <> <span className="price3-badge">{p.badge}</span></> : null}</Tag>;
}

const Price = ({ p, as: Tag = "span" }: { p: Plan; as?: "span" | "p" }) => <Tag className="ptable-price">{p.price}<small>/month</small></Tag>;

function Cta({ p }: { p: Plan }) {
  return (
    <>
      <a className={p.cta.primary ? "home-pill" : "home-soft home-soft-sm"} href={p.cta.href}>{p.cta.label}</a>
      <p className="ptable-terms" data-deal={p.terms.deal ? "" : undefined}>{p.terms.before}{p.terms.deal ? <strong className="price3-deal">{p.terms.deal}</strong> : null}</p>
    </>
  );
}

export function PricingPanel({ children }: { children?: ReactNode }) {
  const hot = (p: Plan) => (p.key === HOT_PLAN ? "ptable-hot" : undefined);
  return (
    <div className="price3-panel">
      <div className="ptable-card">
        <div className="ptable-scroll">
          <table className="ptable">
            <caption className="sr-only">Compare plans</caption>
            <thead>
              <tr>
                <th scope="col" className="ptable-feature">Feature</th>
                {PLANS.map((p) => <th key={p.key} scope="col" className={hot(p)}><Name p={p} /><Price p={p} /></th>)}
              </tr>
            </thead>
            <tbody>
              {FEATURES.map((f) => (
                <tr key={f.name}>
                  <th scope="row">{f.name}{f.note ? <small>{f.note}</small> : null}</th>
                  {PLANS.map((p) => <td key={p.key} className={hot(p)}><Cell v={f[p.key]} /></td>)}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row"><span className="sr-only">Get the plan</span></th>
                {PLANS.map((p) => <td key={p.key} className={hot(p)}><Cta p={p} /></td>)}
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
      <div className="pcards">
        {PLANS.map((p) => (
          <section key={p.key} className={`pcard ${hot(p) || ""}`} aria-labelledby={`m-plan-${p.key}`}>
            <Name p={p} as="h3" id={`m-plan-${p.key}`} />
            <Price p={p} as="p" />
            <p className="pcard-desc">{p.desc}</p>
            {p.plus ? <p className="pcard-plus">{p.plus}</p> : null}
            <ul className="pcard-list">{p.features.map((f) => <li key={f}><Check /><span>{f}</span></li>)}</ul>
            <Cta p={p} />
          </section>
        ))}
      </div>
      {children}
    </div>
  );
}
