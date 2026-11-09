// /checkout?plan=basic or ?plan=pro: the API makes a Dodo checkout for
// the signed-in account (api/dodo.py) and this page goes there.
// ?manage=1: the same for Dodo's customer portal. The plan belongs to
// an account, so a signed-out buyer logs in first, in the site's sign-in
// window; Google and GitHub come back to this address and an email code
// reloads it, and either way the page runs again signed in.
import { useEffect, useRef, useState } from "react";
import { Loader } from "@cloudflare/kumo/components/loader";
import { api } from "../api";
import { PublicPage } from "../site/PublicPage";
import { requestSignIn, useAuth } from "../site/auth";
import { boot } from "../site/boot";

const q = new URLSearchParams(location.search);
const manage = q.has("manage");
const plan = q.get("plan");
const valid = manage || plan === "basic" || plan === "pro";
const link = "underline underline-offset-4 hover:text-kumo-link";

function Checkout() {
  const who = useAuth();
  const [error, setError] = useState("");
  const started = useRef(false);

  useEffect(() => {
    if (!valid) return;
    if (!who) { requestSignIn(); return; }
    if (started.current) return;
    started.current = true;
    api<{ url?: string }>(manage ? "/me/billing" : "/me/checkout", { method: "POST", body: JSON.stringify(manage ? {} : { plan }) })
      .then((out) => {
        if (!out?.url) throw new Error("Couldn't open checkout.");
        location.href = out.url;
      })
      .catch((e: Error) => { started.current = false; setError(e.message || "Couldn't open checkout."); });
  }, [who]);

  const waiting = manage ? "Opening billing" : "Opening checkout";
  return (
    <p aria-live="polite" className="m-0 min-h-7 text-base">
      {!valid ? <>Pick a plan on the <a className={link} href="/pricing">pricing page</a>.</>
        : error ? <>{error} <a className={link} href={location.href}>Try again</a></>
        : !who ? <>Log in so the plan goes on your account. <button type="button" className={`${link} cursor-pointer border-0 bg-transparent p-0 font-sans text-base`} onClick={requestSignIn}>Log in</button></>
        : <span className="inline-flex items-center gap-2 text-kumo-subtle"><Loader size="sm" />{waiting}</span>}
    </p>
  );
}

boot(
  <PublicPage current="pricing">
    <div className="pt-8">
      <h1 className="m-0 mb-4 font-sans text-[26px] font-semibold leading-tight tracking-tight text-kumo-strong">Checkout</h1>
      <Checkout />
      <p className="mt-6 mb-2 text-sm text-kumo-subtle"><a className={link} href="/pricing">Back to pricing</a></p>
      <p className="m-0 text-sm text-kumo-subtle">Payments are handled by Dodo Payments, our Merchant of Record. See the <a className={link} href="/terms">terms</a> and <a className={link} href="/refunds">refund policy</a>.</p>
    </div>
  </PublicPage>,
);
