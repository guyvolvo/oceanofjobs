// /checkout?plan=basic or ?plan=pro: our API makes a Dodo checkout for the
// signed-in account (api/dodo.py: product ids, discount and return URLs
// live there) and this page goes there. ?manage=1: the same for Dodo's
// customer portal. Same calls as frontend/checkout.html: authedFetch from
// auth.js, POST /api/me/checkout {"plan"} or POST /api/me/billing {}.
// The plan belongs to an account, so a signed-out buyer logs in first, in
// the site's sign-in window; Google and GitHub come back to this address
// and an email code reloads it, so the page runs again signed in.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { requestSignIn } from "../site/auth";
import { Page } from "../shell/Page";
import { useWho } from "../shell/state";

const link = "text-foreground underline underline-offset-3 hover:text-link-hover";

// The turning ring while our API makes the checkout; the words are for screen readers.
const Wait = ({ words }: { words: string }) => (
  <span className="flex py-6">
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="size-8 flex-none animate-spin text-muted-foreground [animation-duration:0.9s]">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.5" opacity="0.2" />
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="18 39" />
    </svg>
    <span className="sr-only">{words}</span>
  </span>
);

// The request this page makes for a query string, or null when it names no plan.
export function request(search: string): { path: string; body: string } | null {
  const q = new URLSearchParams(search);
  const manage = q.has("manage");
  const plan = q.get("plan");
  if (!manage && plan !== "basic" && plan !== "pro") return null;
  return { path: manage ? "/me/billing" : "/me/checkout", body: JSON.stringify(manage ? {} : { plan }) };
}

function Status() {
  const who = useWho();
  // Read after hydration: the prerendered HTML has no query string.
  const [req, setReq] = useState<ReturnType<typeof request> | undefined>();
  const [error, setError] = useState("");
  const started = useRef(false);
  useEffect(() => setReq(request(location.search)), []);

  useEffect(() => {
    if (!req || started.current) return;
    if (!who) { requestSignIn(); return; }
    started.current = true;
    (authedFetch(req.path, { method: "POST", body: req.body }) as unknown as Promise<{ url?: string } | null>)
      .then((out) => {
        if (!out || !out.url) throw new Error("Couldn't open checkout.");
        location.href = out.url;
      })
      .catch((e: Error) => setError(e?.message || "Couldn't open checkout."));
  }, [req, who]);

  let say: ReactNode = null;
  if (req === null) say = <>Pick a plan on the <a className={link} href="/pricing">pricing page</a>.</>;
  else if (error) say = <>{error} <a className={link} href={location.href}>Try again</a></>;
  else if (req && !who) say = <>Log in so the plan goes on your account. <a className={link} href="/account" onClick={(e) => { e.preventDefault(); requestSignIn(); }}>Log in</a></>;
  else if (req) say = <Wait words={req.path === "/me/billing" ? "Opening billing…" : "Opening checkout…"} />;
  return <p aria-live="polite" className="mt-0 mb-3.5">{say}</p>;
}

export function Checkout() {
  return (
    <Page current="pricing" footer>
      <div className="h-[72px] max-[900px]:h-8" />
      <section className="px-10 pb-28 max-[640px]:px-4 max-[640px]:pb-20">
        {/* One reading column, centred, as the live page's .legal-doc. */}
        <div className="mx-auto max-w-[760px] text-base leading-[1.65] text-body">
          <h1 className="m-0 max-w-[720px] font-heading text-[40px] leading-[1.1] font-medium tracking-[-0.03em] text-foreground max-[640px]:text-[32px]">Checkout</h1>
          <Status />
          <p className="mt-3 mb-7 text-sm text-dim"><a className={link} href="/pricing">Back to pricing</a></p>
          <p className="mt-3 mb-7 text-sm text-dim">Payments are handled by Dodo Payments, our Merchant of Record. See the <a className={link} href="/terms">terms</a> and <a className={link} href="/refunds">refund policy</a>.</p>
        </div>
      </section>
    </Page>
  );
}
