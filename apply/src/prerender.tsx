// The build-time render of the pages that ship as real HTML. Built for
// Node by `vite build --ssr` (see package.json "build"); scripts/prerender.mjs
// calls render() for every built page whose root names one of these
// (<div id="root" data-page="...">) and writes the HTML into it. The page's
// own entry then hydrates the same element tree in the browser.
import { StrictMode, type ReactNode } from "react";
// @ts-expect-error this build has no @types/node; the import runs only in the Node prerender
import { createRequire } from "node:module";
import { renderToString } from "react-dom/server";
import { Contact } from "./contact/Contact";
import { Legal } from "./legal/Legal";
import { NotFound } from "./notfound/NotFound";
import { StatsPage } from "./stats/Stats";

// Stats reads the query builder from the global its classic script sets in
// the browser (frontend/qb.js); in Node the same file is a CommonJS module.
// Resolved from dist-ssr/prerender.js.
(globalThis as { QB?: unknown }).QB ??= createRequire(import.meta.url)("../../frontend/qb.js");

const PAGES: Record<string, () => ReactNode> = {
  privacy: () => <Legal doc="privacy" />,
  terms: () => <Legal doc="terms" />,
  refunds: () => <Legal doc="refunds" />,
  contact: () => <Contact />,
  "404": () => <NotFound />,
  stats: () => <StatsPage />,
};

export function render(page: string): string {
  const el = PAGES[page];
  if (!el) throw new Error(`no prerender for data-page="${page}"`);
  return renderToString(<StrictMode>{el()}</StrictMode>);
}
