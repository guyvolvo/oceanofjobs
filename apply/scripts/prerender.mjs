// Writes each prerendered page's HTML into dist/<page>.html, after
// `vite build` (the browser bundles) and `vite build --ssr src/prerender.tsx
// --outDir dist-ssr` (the same components, for Node). A page opts in with
// <div id="root" data-page="name"></div> in its HTML entry; the others
// (still client-rendered) are left as they are.
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const apply = resolve(import.meta.dirname, "..");
const dist = join(apply, "dist");
const ssr = join(apply, "dist-ssr");
const { render } = await import(pathToFileURL(join(ssr, "prerender.js")).href);

const ROOT = /<div id="root" data-page="([\w-]+)"><\/div>/;
// The crawlable pages: the build fails if any of them is not prerendered.
const REQUIRED = ["home", "companies", "stats", "pricing", "privacy", "terms", "refunds", "contact", "404"];
const done = [];
for (const file of readdirSync(dist).filter((f) => f.endsWith(".html"))) {
  const path = join(dist, file);
  const html = readFileSync(path, "utf8");
  const m = ROOT.exec(html);
  if (!m && html.includes("data-page=")) throw new Error(`${file}: has data-page= but not an empty <div id="root" data-page="..."></div> to fill`);
  if (!m) continue;
  const body = render(m[1]);
  if (body.length < 200) throw new Error(`${file}: prerender of "${m[1]}" is only ${body.length} bytes`);
  writeFileSync(path, html.replace(ROOT, () => `<div id="root" data-page="${m[1]}">${body}</div>`));
  console.log(`prerendered ${file} (${m[1]}, ${(body.length / 1024).toFixed(1)} KB)`);
  done.push(m[1]);
}
const missing = REQUIRED.filter((p) => !done.includes(p));
if (missing.length) throw new Error(`not prerendered: ${missing.join(", ")}. Is the data-page root missing?`);
rmSync(ssr, { recursive: true, force: true });
