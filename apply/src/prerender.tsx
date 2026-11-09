// The build-time render of the pages that ship as real HTML. Built for
// Node by `vite build --ssr` (see package.json "build"); scripts/prerender.mjs
// calls render() for every built page whose root names one of these
// (<div id="root" data-page="...">) and writes the HTML into it. The page's
// own entry then hydrates it: the whole tree (hydrate()), or for the pages
// in ISLAND_PAGES only their islands (shell/island.tsx, hydrateIslands()).
import { StrictMode, type ReactNode } from "react";
// @ts-expect-error this build has no @types/node; the import runs only in the Node prerender
import { createRequire } from "node:module";
import { renderToString } from "react-dom/server";
import { Checkout } from "./checkout/Checkout";
import { Directory } from "./companies/Directory";
import { Board } from "./board/Board";
import { Contact } from "./contact/Contact";
import { Home } from "./home/Home";
import { Legal } from "./legal/Legal";
import { NotFound } from "./notfound/NotFound";
import { collectIslands } from "./shell/island";
import { Pricing } from "./pricing/Pricing";
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
  home: () => <Home />,
  pricing: () => <Pricing />,
  checkout: () => <Checkout />,
  companies: () => <Directory />,
  stats: () => <StatsPage />,
  board: () => <Board />,
};
// Pages whose entry calls hydrateIslands(): the text stays plain HTML.
const ISLAND_PAGES = new Set(["privacy", "terms", "refunds", "contact", "404", "home"]);

const CONTAINER = /(<div class="contents" data-island="[^"]+" data-props="[^"]*">)(<\/div>)/g;

export function render(page: string): string {
  const el = PAGES[page];
  if (!el) throw new Error(`no prerender for data-page="${page}"`);
  if (!ISLAND_PAGES.has(page)) return renderToString(<StrictMode>{el()}</StrictMode>);
  const { html, islands } = collectIslands(() => renderToString(<StrictMode>{el()}</StrictMode>));
  // Each island is its own root, rendered as hydrateIslands() will hydrate it.
  // Each island's useId values are prefixed with its name, so names must not repeat.
  const names = islands.map((x) => x.name);
  if (new Set(names).size !== names.length) throw new Error(`${page}: island names repeat: ${names.join(", ")}`);
  let i = 0;
  const out = html.replace(CONTAINER, (_, open: string, close: string) => {
    const { name, component: C, props } = islands[i++];
    return open + renderToString(<StrictMode><C {...props} /></StrictMode>, { identifierPrefix: `${name}-` }) + close;
  });
  if (i !== islands.length) throw new Error(`${page}: ${islands.length} islands, ${i} containers filled`);
  return out;
}
