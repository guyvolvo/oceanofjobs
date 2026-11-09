// The home page (/): frontend/index.html in React, the same sections in
// the same order. Prerendered at build time; in the browser only the
// islands come alive (main.tsx): the bar, the search box, the previews,
// the logo band, the recent jobs, the API sample and the footer's poll.
// Everything else stays plain HTML.
import { Island } from "../shell/island";
import { Page } from "../shell/Page";
import { ApiSample } from "./ApiSample";
import { Hero } from "./Hero";
import { HotJobs } from "./HotJobs";
import { LogoBand } from "./LogoBand";
import { Poll } from "./Poll";
import { PricingPanel } from "./Pricing";
import { PRICING_INTRO } from "./plans";

const FEATURES = [
  { title: "Salary disclosure", text: "Most companies do not disclose their salary ranges, that's why there is a salary estimation algorithm to help you decide better." },
  { title: "Real-time data", text: "Jobs appear on Ocean of Jobs a few minutes after companies publish them, and at most 2 hours for companies that post less often." },
  { title: "Smart alerts", text: "Sign-up to set up email alerts based on your preferences." },
  { title: "Public API usage", text: "Free JSON API endpoint that does not require an API key.",
    links: [["API documentation", "/docs/api"], ["OpenAPI specification", "/api/openapi.json"]] },
];

export function Home() {
  return (
    <Page footer footerAside={<Island name="poll" component={Poll} props={{}} />}>
      <div className="home">
        <Hero />
        <Island name="logo-band" component={LogoBand} props={{}} />
        <Island name="hot-jobs" component={HotJobs} props={{}} />

        <section className="home-section" aria-labelledby="privacy-title">
          <div className="home-privacy mx-auto grid max-w-[1180px] grid-cols-1 items-center gap-10 min-[769px]:grid-cols-[300px_minmax(0,1fr)] min-[1025px]:grid-cols-[380px_minmax(0,1fr)] min-[1025px]:gap-16">
            <div className="home-face-panel">
              <svg className="home-face" viewBox="80 20 480 543" aria-hidden="true" focusable="false"><use href="/img/home-face.svg#art" /></svg>
            </div>
            <div>
              <h2 className="home-h2" id="privacy-title">A privacy focused platform for job seekers</h2>
              <p className="home-body">Browse over a million jobs without creating an account. Ocean of Jobs follows a local-first approach: data that can stay on your device stays in your browser by default. If you create an account, you can sync your data across devices.</p>
              <p className="home-body">We don't sell your personal data, and don't use any personalized ads (nor are there any ads in general). If you sign up for job alerts, we store your email address and alert preferences to send them. If you use the <a href="https://chromewebstore.google.com/detail/ocean-of-jobs/kihjppefdadlodaoecffiemijlielhdi" target="_blank" rel="noopener">Auto apply browser extension</a>, you can choose between local storage if you prefer privacy or cloud storage if you prefer efficiency.</p>
            </div>
          </div>
        </section>

        <section className="home-section" aria-labelledby="features-title">
          <div className="mx-auto max-w-[1180px]">
            <h2 className="home-h2" id="features-title">Features</h2>
            <div className="mt-11 grid grid-cols-1 gap-7 min-[641px]:grid-cols-2 min-[641px]:gap-x-6 min-[641px]:gap-y-10 min-[1025px]:grid-cols-4">
              {FEATURES.map((f) => (
                <div key={f.title} className="home-feature py-2 min-[641px]:pr-6">
                  <h3>{f.title}</h3>
                  <p>{f.text}</p>
                  {f.links ? <div className="home-feature-links mt-3 flex flex-wrap gap-x-3.5 gap-y-1.5 text-sm">{f.links.map(([label, href]) => <a key={href} href={href}>{label}</a>)}</div> : null}
                </div>
              ))}
            </div>
          </div>
        </section>

        <ApiSample />

        <section className="home-section" id="pricing" aria-labelledby="pricing-title">
          <div className="mx-auto max-w-[1180px]">
            <h2 className="home-h2" id="pricing-title">Pricing plans</h2>
            <p className="home-body">{PRICING_INTRO}</p>
            <PricingPanel />
            <p className="price3-note">You can cancel a paid plan anytime. Prices are in USD, and taxes are added at checkout. Dodo Payments handles payments.<br /><a href="/refunds">Refund policy</a> · <a href="/terms">Terms of service</a> · Questions? <a href="/contact">Get in touch</a>.</p>
          </div>
        </section>

        <section className="home-section home-last" aria-labelledby="start-title">
          <div className="home-start mx-auto max-w-[1180px]">
            <h2 id="start-title">Start your search.</h2>
            <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
              <a className="home-pill home-pill-md" href="/board">Search jobs<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg></a>
              <a className="home-soft home-soft-md" href="/companies">Browse companies</a>
            </div>
          </div>
        </section>
      </div>
    </Page>
  );
}
