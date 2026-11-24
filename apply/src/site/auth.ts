// Who is signed in, for React, and the sign-in window's opener. auth.js
// owns the tokens and has one render sink, which src/shell/state.ts holds;
// useAuth is that same store, so a sign-out (here, in the account menu or
// in another tab) reaches every component at once.
export { useWho as useAuth } from "../shell/state";

export type Who = { email: string; name: string; picture: string; idToken: string } | null;

// Every "Log in" goes to the sign-in page, which comes back here once
// signed in (src/login). frontend/signin_dialog.js does the same for
// window.openSignIn().
export const requestSignIn = () => {
  if (location.pathname !== "/login") location.assign("/login?next=" + encodeURIComponent(location.pathname + location.search + location.hash));
};

// The sign-in window's choices (terms, product updates) go to the account
// on the first page that loads signed in. Once per page load.
let consentSynced = false;
export function syncConsentOnce() {
  if (consentSynced || typeof syncConsent !== "function") return;
  consentSynced = true;
  syncConsent().catch(() => { /* asked again next page */ });
}
