// The Billing tab: the plan in force, what Dodo last said about the paid
// one (GET /me/billing, api/dodo.py state), and the way to Dodo's customer
// portal (/checkout?manage=1) to cancel, change the card or get invoices.
import { useEffect, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Loader } from "@cloudflare/kumo/components/loader";
import { api } from "../api";
import { Card } from "./ui";

type State = {
  paid: { plan: string; status: string; period_end: string } | null;
  license: { plan: string; until: string } | null;
  customer: boolean;
};
const NAME: Record<string, string> = { free: "Free", basic: "Basic", pro: "Pro" };
const day = (iso: string) => new Date(iso.length === 10 ? iso + "T12:00:00Z" : iso)
  .toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
// apply.plan_of: a paid plan counts while active, in its trial or in Dodo's grace period.
const LIVE = ["active", "trialing", "past_due"];

function paidLine(p: NonNullable<State["paid"]>): string {
  const on = p.period_end ? day(p.period_end) : "";
  switch (p.status) {
    case "trialing": return on ? `Free trial. The first payment is on ${on}.` : "Free trial.";
    case "active": return on ? `Renews on ${on}.` : "Active.";
    case "past_due": return "Your last payment didn't go through. Update your card to keep your plan.";
    case "on_hold": return "On hold because a payment didn't go through. Update your card to continue.";
    case "paused": return "Paused.";
    default: return "Canceled.";
  }
}

export function Billing() {
  const [s, setS] = useState<State | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { api<State>("/me/billing").then(setS, () => setFailed(true)); }, []);

  if (failed) return <Card title="Billing" note="Couldn't load your plan. Reload the page to try again." />;
  if (!s) return <Card title="Billing"><div className="oj-row oj-note"><Loader /> Loading</div></Card>;

  const paid = s.paid && LIVE.includes(s.paid.status) ? s.paid.plan : "free";
  const given = s.license && (!s.license.until || s.license.until >= new Date().toISOString().slice(0, 10)) ? s.license.plan : "free";
  const plan = [paid, given].includes("pro") ? "pro" : [paid, given].includes("basic") ? "basic" : "free";
  // A line names its plan only when it isn't the one shown above it.
  const named = (p: string, line: string) => (p === plan ? line : `${NAME[p] || p}: ${line}`);
  const lines = [
    s.paid ? named(s.paid.plan, paidLine(s.paid)) : "",
    s.license && given !== "free" ? named(s.license.plan, `Given to you${s.license.until ? ` until ${day(s.license.until)}` : ""}.`) : "",
  ].filter(Boolean);

  return (
    <div className="oj-stack">
      <Card title="Plan" action={plan === "free" ? <Button variant="primary" onClick={() => { location.href = "/pricing"; }}>See plans</Button> : undefined}>
        <div className="oj-pref-text">
          <span className="oj-pref-label">{NAME[plan]}</span>
          {lines.length ? lines.map((l) => <span key={l} className="oj-note">{l}</span>)
            : <span className="oj-note">You're on the free plan.</span>}
        </div>
      </Card>
      {s.customer ? (
        <Card title="Payments" note="Cancel your plan, change your card or download invoices on the billing page.">
          <div><Button variant="secondary" onClick={() => { location.href = "/checkout?manage=1"; }}>Manage billing</Button></div>
        </Card>
      ) : null}
    </div>
  );
}
