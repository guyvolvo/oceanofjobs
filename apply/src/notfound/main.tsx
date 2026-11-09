// The page CloudFront serves for any address the site does not have,
// /jobs/some-old-role included. It says what kind of thing is missing
// when the address makes it clear, and offers the role's words as a
// search instead of guessing which current listing was meant.
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { PublicPage } from "../site/PublicPage";
import { boot } from "../site/boot";

const m = location.pathname.match(/^\/(jobs?|listings?|companies|company)\/([^/]+)/i);
const kind = m ? (/^(jobs?|listings?)$/i.test(m[1]) ? "job" : "company") : "page";
const COPY = {
  page: ["Page not found", "This page does not exist. The link may be mistyped or out of date."],
  job: ["Job not found", "This job is no longer on the board, or the link is out of date. Jobs get filled and taken down, so links to them go stale."],
  company: ["Company not found", "There is no company page at this address. Search for the company to see its open jobs."],
}[kind];

function words() {
  if (!m) return "";
  let w = m[2];
  try { w = decodeURIComponent(w); } catch { /* a stray percent sign: use the raw slug */ }
  w = w.replace(/\.html?$/i, "").replace(/[-_+.]+/g, " ").replace(/\b[0-9a-f]{8,}\b/gi, "").replace(/\s+/g, " ").trim();
  return /[a-z]{3}/i.test(w) ? w : "";
}

// Only when there is somewhere on this site to go back to.
const canGoBack = history.length > 1 && document.referrer.indexOf(location.origin) === 0;

boot(
  <PublicPage>
    <div className="max-w-[640px] pt-10 pb-16">
      <p className="m-0 font-display text-[clamp(96px,22vw,160px)] font-normal leading-[0.85] tracking-[-0.02em] text-kumo-strong" aria-hidden="true">404</p>
      <h1 className="mt-6 mb-2 font-sans text-[26px] font-semibold leading-tight tracking-tight text-kumo-strong">{COPY[0]}</h1>
      <p className="m-0 mb-6 text-kumo-subtle">{COPY[1]}</p>
      <form className="flex items-end gap-2" action="/board" method="get" role="search">
        <div className="min-w-0 flex-1"><Input className="w-full" name="search" aria-label="Search jobs" placeholder="e.g. backend engineer Tel Aviv" autoComplete="off" defaultValue={words()} /></div>
        <Button type="submit" variant="primary">Search</Button>
      </form>
      <div className="mt-4 flex flex-wrap gap-2">
        <LinkButton variant="secondary" size="sm" href="/board">All jobs</LinkButton>
        <LinkButton variant="secondary" size="sm" href="/board?view=matches">Best matches</LinkButton>
        {canGoBack ? <Button variant="secondary" size="sm" onClick={() => history.back()}>Go back</Button> : null}
      </div>
    </div>
  </PublicPage>,
);
