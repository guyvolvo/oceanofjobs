# src/site

The workspace layout and the helpers shared with src/shell.

- `boot(page)` mounts a page that renders in the browser only (/apply, /account).
  Prerendered pages use `hydrate()` from `src/shell/hydrate.tsx` instead.
- `Workspace` is the sidebar layout of the product pages (board, companies,
  stats, and everything under /apply and /account). `current` is a key from
  `nav.tsx` GROUPS.
- `SignInPage` is the signed-out state of a page that needs an account.
  `requestSignIn()` opens the sign-in window from anywhere.
- `useAuth()` gives the signed-in reader or null. For the theme, use `useDark()`
  from `src/shell/state.ts` and `toggleTheme` from `src/shell/Header.tsx`.
- `globals.d.ts` types the `auth.js` globals.

The rules for new code are in `docs/FRONTEND_STANDARD.md`.
