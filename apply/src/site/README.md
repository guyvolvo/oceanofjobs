# Building a page on the design-workspace branch

The whole site is this one Vite + React + TypeScript + Tailwind v4 + Kumo build
(`apply/`). Every page is an HTML entry in `apply/` with a `main.tsx` under
`src/<page>/`. Nothing is committed on this branch yet: it is a local design
rework. Do not commit, do not touch `frontend/` (the old pages stay as the
reference to port from), do not touch `docs/` or `extension/`.

## The shell (src/site)

- `boot(page)` mounts a page after the sign-in redirect is handled.
- `PublicPage` ({ current, wide, children }) is the top bar + content + footer.
  Use it for the home page, pricing, checkout, legal pages, 404, contact.
  `PageHead` ({ title, note, actions }) is the title row.
- `Workspace` ({ current, title, note, actions, status, badges, bare, children })
  is the sidebar layout for the product pages (board, companies, stats, and
  everything under /apply and /account). `current` is a key from `nav.tsx`
  GROUPS. `bare` drops the padding so a page can lay itself out edge to edge.
  `status` is the line under the brand ("Pro · 48 applications left").
  `badges` puts counts beside Queue and Needs attention.
- `SignInPage` is the signed-out state of a page that needs an account;
  `requestSignIn()` opens the sign-in window from anywhere (the old pages
  called `window.openSignIn()`).
- `useAuth()` gives `{ email, name, picture, idToken } | null` and re-renders
  on sign-in and sign-out. `useTheme()` gives `[dark, toggle]`.
- `nav.tsx` is the one list of what the site has. Add nothing to it without
  a reason.
- `site.css` carries the palette (Kumo tokens in the site's colours), fonts,
  and a few global rules. Page CSS goes in `src/<page>/<page>.css` and only
  for what Tailwind cannot say (keyframes, complex selectors).
- `globals.d.ts` types the `auth.js` globals (sign-in, tokens). `src/api.ts`
  has `api()` (signed in, /api/me/...), `pub()` (public, retried), `apply()`.

## Rules

- Kumo components first (`@cloudflare/kumo/components/<name>`; `npx
  @cloudflare/kumo doc <Name>` prints a component's props and examples),
  Tailwind utilities for layout, Kumo semantic tokens for colour
  (`text-kumo-subtle`, `bg-kumo-base`, `border-kumo-hairline`, ...). No new
  hex colours; no new fonts. Icons from `@phosphor-icons/react`.
- Port behaviour faithfully: the same API calls, the same URL parameters,
  the same localStorage keys, the same copy unless it fails the copy rules.
  Features are not dropped; if one cannot be ported, say so in the report.
- The old page's CSS is not copied over. Rebuild the look with Tailwind and
  Kumo. Read `DESIGN.md` for the design language (Swiss grid, zero
  decoration, green marks exactly one "this matters" element).
- UI copy follows CLAUDE.md "User-facing copy" and "Writing style: unslop":
  no em dashes, no exclamation points, no hedging, straight quotes, sentence
  case, plain words.
- Code comments: no decorative divider lines; comment the why only.
- Scripts the pages still load as classic scripts (unchanged, from
  `frontend/`): `auth.js`, `consent.js`, `count.js`, `cv_skills.js`. They
  are globals; call them through `globals.d.ts`.
- Each page's HTML entry already exists in `apply/`; its `<script
  type="module">` names `src/<page>/main.tsx`. Keep the entry's head.

## Running and checking

The dev server answers the site's own addresses and proxies the API and the
box-published files to the live site, so pages run on real data:

    cd apply && npx vite --port 5173 --strictPort --host 127.0.0.1

Open http://127.0.0.1:5173/board, /, /companies, /stats, /pricing, /apply,
/account. A dev server is normally already running on 5173; if it answers,
do not start another one.

Type-check with `cd apply && npx tsc --noEmit`. Screenshot a page with
Playwright from `tests/e2e` (it is installed there), at 1440x900 and 390x800:

    cd tests/e2e && node _ws_shot.mjs http://127.0.0.1:5173/board out.png 1440 900

It prints the page's console errors. Fix every error and warning your page
raises. Look at the screenshot before reporting.
