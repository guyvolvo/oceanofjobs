// DESIGN.md's frontmatter -> src/styles/tokens.css: the only place the React
// pages get a colour, a font or a radius from. Run by `npm run tokens` (and
// before every build), so a change to DESIGN.md reaches the pages.
//
// Colours: every `name` becomes --ooj-name; a `name-dark` sibling is its
// value under [data-mode="dark"]. The semantic names shadcn/ui reads
// (--background, --primary, ...) point at those, per SEMANTIC below.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const designPath = resolve(here, "../../DESIGN.md");
const outPath = resolve(here, "../src/styles/tokens.css");

// shadcn's semantic token -> a DESIGN.md colour name. The public pages use
// the landing page's palette (DESIGN.md "Public page palette").
const SEMANTIC = {
  background: "page-ground", foreground: "page-text",
  card: "paper", "card-foreground": "page-text",
  popover: "page-ground", "popover-foreground": "page-text",
  primary: "page-text", "primary-foreground": "page-ground",
  secondary: "page-soft", "secondary-foreground": "page-text",
  muted: "page-soft", "muted-foreground": "page-muted",
  accent: "page-soft-hover", "accent-foreground": "page-text",
  destructive: "alert-red", border: "page-line", input: "ink", ring: "signal-green",
  body: "page-body", dim: "page-dim", "link-hover": "page-link-hover", overlay: "scrim",
};
// Tailwind/shadcn font and radius names -> DESIGN.md typography roles and rounded keys.
const FONTS = { sans: "display-feature-card", heading: "page-heading", display: "display-wordmark", body: "body", ui: "ui", mono: "data-mono" };
const RADII = { xs: "micro", sm: "default", md: "default", lg: "menu", xl: "card-soft", "2xl": "note" };

// The frontmatter is plain two-space YAML: sections, keys, and one more level.
export function parseFrontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) throw new Error("DESIGN.md has no frontmatter");
  const out = {};
  let section, item;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^( *)([\w-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, indent, key, raw] = kv;
    const value = raw.replace(/^"(.*)"$/, "$1").replace(/\\"/g, '"');
    if (indent.length === 0) out[(section = key)] = raw ? value : {};
    else if (indent.length === 2) {
      if (raw) out[section][key] = value;
      else out[section][(item = key)] = {};
    } else if (indent.length === 4) out[section][item][key] = value;
  }
  return out;
}

export function build(design) {
  const { colors, typography, rounded } = design;
  const light = Object.keys(colors).filter((k) => !k.endsWith("-dark"));
  const dark = light.filter((k) => colors[`${k}-dark`]);
  for (const [k, v] of Object.entries(SEMANTIC)) if (!colors[v]) throw new Error(`--${k}: DESIGN.md has no colour "${v}"`);
  for (const [k, v] of Object.entries(FONTS)) if (!typography[v]?.fontFamily) throw new Error(`font ${k}: DESIGN.md has no typography "${v}"`);
  for (const [k, v] of Object.entries(RADII)) if (!rounded[v]) throw new Error(`radius ${k}: DESIGN.md has no rounded "${v}"`);
  const lines = [
    "/* Generated from DESIGN.md by scripts/tokens.mjs (npm run tokens). Do not edit by hand. */",
    ":root {",
    ...light.map((k) => `  --ooj-${k}: ${colors[k]};`),
    ...Object.entries(SEMANTIC).map(([k, v]) => `  --${k}: var(--ooj-${v});`),
    "}",
    ':root[data-mode="dark"] {',
    "  color-scheme: dark;",
    ...dark.map((k) => `  --ooj-${k}: ${colors[`${k}-dark`]};`),
    "}",
    // Tailwind's own palette and shadows are switched off, so a colour that
    // is not in DESIGN.md (bg-black, text-white) and a shadow (the
    // No-Shadow Rule) produce no CSS at all.
    "@theme {",
    "  --color-*: initial;",
    "  --shadow-*: initial;",
    "  --inset-shadow-*: initial;",
    "  --drop-shadow-*: initial;",
    "}",
    "@theme inline {",
    ...Object.keys(SEMANTIC).map((k) => `  --color-${k}: var(--${k});`),
    ...Object.entries(FONTS).map(([k, v]) => `  --font-${k}: ${typography[v].fontFamily};`),
    ...Object.entries(RADII).map(([k, v]) => `  --radius-${k}: ${rounded[v]};`),
    "}",
    "",
  ];
  return lines.join("\n");
}

const css = build(parseFrontmatter(readFileSync(designPath, "utf8")));
if (process.argv.includes("--check")) {
  // CI-style check: the committed file is what DESIGN.md generates.
  if (readFileSync(outPath, "utf8") !== css) { console.error("tokens.css is stale: run npm run tokens"); process.exit(1); }
  console.log("tokens.css matches DESIGN.md");
} else {
  writeFileSync(outPath, css);
  console.log(`wrote ${outPath}`);
}
