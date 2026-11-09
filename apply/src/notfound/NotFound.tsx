// The page CloudFront serves for any address the site does not have,
// /jobs/some-old-role included. The prerendered HTML is the plain "Page
// not found"; once in the browser it says what kind of thing is missing
// when the address makes it clear, and offers the role's words as a
// search instead of guessing which current listing was meant.
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Island } from "../shell/island";
import { Page } from "../shell/Page";

const COPY = {
  page: ["Page not found", "This page does not exist. The link may be mistyped or out of date."],
  job: ["Job not found", "This job is no longer on the board, or the link is out of date. Jobs get filled and taken down, so links to them go stale."],
  company: ["Company not found", "There is no company page at this address. Search for the company to see its open jobs."],
};

// What the address says is missing, and the words of a stale link to it.
export function readPath(path: string): { kind: keyof typeof COPY; words: string } {
  const m = path.match(/^\/(jobs?|listings?|companies|company)\/([^/]+)/i);
  if (!m) return { kind: "page", words: "" };
  let w = m[2];
  try { w = decodeURIComponent(w); } catch { /* a stray percent sign: use the raw slug */ }
  w = w.replace(/\.html?$/i, "").replace(/[-_+.]+/g, " ").replace(/\b[0-9a-f]{8,}\b/gi, "").replace(/\s+/g, " ").trim();
  return { kind: /^(jobs?|listings?)$/i.test(m[1]) ? "job" : "company", words: /[a-z]{3}/i.test(w) ? w : "" };
}

// The page under the bar: an island, since most of it depends on the address.
export function NotFoundBody() {
  const [where, setWhere] = useState<ReturnType<typeof readPath>>({ kind: "page", words: "" });
  const [search, setSearch] = useState("");
  const [canGoBack, setCanGoBack] = useState(false);
  useEffect(() => {
    const w = readPath(location.pathname);
    setWhere(w);
    setSearch(w.words);
    // Only when there is somewhere on this site to go back to.
    setCanGoBack(history.length > 1 && document.referrer.indexOf(location.origin) === 0);
  }, []);
  const [title, lede] = COPY[where.kind];
  return (
      // Left, under the brand, as the old page sat on the board's grid.
      <div className="px-4 pt-12 pb-16 sm:px-[max(40px,calc((100%-1100px)/2))] [&>*]:max-w-[640px]">
        <p className="m-0 mb-5 font-display text-[clamp(96px,22vw,160px)] leading-[0.85] font-normal tracking-[-0.02em] text-foreground" aria-hidden="true">404</p>
        <h1 className="m-0 mb-3 font-display text-[34px] leading-none font-normal">{title}</h1>
        <p className="mt-0 mb-6 font-body text-sm">{lede}</p>
        <form className="mb-4 flex gap-2" action="/board" method="get" role="search">
          <Input type="text" name="search" placeholder="e.g. backend engineer Tel Aviv…" aria-label="Search jobs" autoComplete="off" value={search} onChange={(e) => setSearch(e.target.value)} />
          <Button type="submit">Search</Button>
        </form>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm"><a href="/board">All jobs</a></Button>
          <Button asChild variant="outline" size="sm"><a href="/board?view=matches">Best matches</a></Button>
          {canGoBack ? <Button variant="outline" size="sm" type="button" onClick={() => history.back()}>Go back</Button> : null}
        </div>
      </div>
  );
}

export function NotFound() {
  return <Page><Island name="notfound" component={NotFoundBody} props={{}} /></Page>;
}
