# Frontend standard

The rules for every page built in `apply/` from the UI overhaul on. The
live plain-JS site (`frontend/`) stays the reference for behaviour, copy
and design until a page is switched over.

## Stack

- React 19, TypeScript and Vite, in `apply/`. One build, one HTML entry per
  page.
- Tailwind v4 for layout and styling.
- shadcn/ui is the component layer. Components live in
  `apply/src/components/ui/`, added with `npx shadcn@latest add <name>`.
- React Aria only for the board's location tree, when the board is
  migrated. Never wrap a shadcn component in it.
- TanStack Virtual only for the board's job list, when the board is
  migrated.
- No Kumo (`@cloudflare/kumo`) in new or migrated code, and no MUI. Kumo is
  still installed for the pages that have not moved yet; it goes when the
  last of them does.
- Icons: `@phosphor-icons/react`, the site's set. shadcn components that
  ship with lucide get the Phosphor equivalent.

## Styling comes from tokens only

- Colours, fonts and radii come from `apply/src/styles/tokens.css`. That
  file is generated from `DESIGN.md`'s frontmatter by
  `apply/scripts/tokens.mjs` (`npm run tokens`, and every `npm run build`).
  Change a value in `DESIGN.md`, never in the CSS.
- A colour key ending in `-dark` is the dark value of the key without it.
  Dark mode is `<html data-mode="dark">`, set before first paint by the
  head script in `vite.config.ts`, from the same `iljobs_theme` key the old
  pages use.
- Tailwind's own palette and shadows are switched off in `tokens.css`, so
  `bg-black`, `text-white` or `shadow-lg` produce no CSS. Use the semantic
  names (`bg-background`, `text-foreground`, `text-muted-foreground`,
  `border-border`, `bg-primary`, `text-body`, `text-dim`, `bg-overlay`,
  `text-link-hover`) or add a colour to `DESIGN.md` first.
- No shadows (DESIGN.md "No-Shadow Rule"). Depth is hairlines.
- `apply/src/styles/app.css` lists the folders Tailwind reads (`@source`).
  A migrated page's folder is added there.
- No `prefers-reduced-motion` gates. Animations run whatever the OS says.

## Public pages ship real HTML

- Home, companies, stats, pricing and the legal pages must be
  prerendered. The check is the delivered HTML with no JavaScript run, not
  the browser DOM.
- A page opts in by naming itself on its root in its HTML entry,
  `<div id="root" data-page="privacy"></div>`, and by adding a line to
  `PAGES` in `apply/src/prerender.tsx`. Its `main.tsx` calls
  `hydrate(<ThePage />)` from `apply/src/shell/hydrate.tsx`.
- Anything that only the browser knows (signed-in user, theme, the address
  of a 404) is read after hydration: `useWho()` and `useDark()` in
  `apply/src/shell/state.ts`, or a `useEffect`. The server render and the
  first browser render must be the same.
- Links a crawler needs are in the HTML even when a menu is shut. The
  header's menus are disclosures for that reason, not Radix dropdowns.
- Keep each page's canonical, title, description, Open Graph and Twitter
  tags and JSON-LD the same as the live page's. `npm run check:html`
  (`apply/scripts/nojs_check.py`) compares them, with the word count, the
  links and the `<main>` text, against oceanofjobs.com.
- `/job/<id>`, `/company/...`, `/jobs/*` and `/companies/<letter>` stay
  server-rendered by the API. Link to them; never build them here.

## Page shell

- `apply/src/shell/Page.tsx`: skip link, header, `<main id="main">`, and
  the footer where the live page has one.
- `apply/src/shell/Header.tsx`: the bar, from the one nav list in
  `apply/src/site/nav.tsx`. The account menu, the phone menu and the
  sign-in window load on first use, which keeps Radix out of the first
  load.
- `window.openSignIn` is set by `hydrate()`, so auth.js can reopen the
  sign-in window after a failed Google or GitHub sign-in.

## Budgets and checks before a page switches

- `npm run build` passes (tokens, tsc, client build, SSR build, prerender).
- `npm run check:html` passes against live.
- `node scripts/shots.mjs <dir>`: light and dark, 1440 and 390, no
  horizontal scroll at 390, no console errors on the new page.
- `node scripts/focus.mjs <dir>`: every Tab stop shows focus; menus,
  phone menu and sign-in work from the keyboard.
- `node scripts/sizes.mjs`: first-load JS plus CSS (gzip) no worse than
  the live page's by more than an agreed margin.
- Preview with `npm run preview:site`, which serves the build the way
  CloudFront would route it (`apply/scripts/preview.mjs`).

## Copy

UI copy follows CLAUDE.md (natural-ui-copy plus unslop): plain words, no
em dashes, no exclamation points, straight quotes. A migrated page keeps
the live page's copy word for word unless the owner asks otherwise.

## Adding a shadcn component

`npx shadcn@latest add <name>` works, with two known fixes on this repo
(Windows): it may import `cn` from a package called `cn` and add that
package to `package.json`. Point the import at `@/lib/utils` and run
`npm uninstall cn`. Swap any `lucide-react` icon for its Phosphor
equivalent, and `bg-black/50` for `bg-overlay`.
