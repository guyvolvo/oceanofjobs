// Who is signed in, for React. auth.js owns the tokens and has one render
// sink it calls after a sign-in or sign-out; this fans it out to every
// component that asked, and lets any of them open the sign-in window.
import { useEffect, useState } from "react";

export type Who = { email: string; name: string; picture: string; idToken: string } | null;

export function readWho(): Who {
  if (typeof getAuthTokens !== "function") return null;
  const t = getAuthTokens();
  if (!t?.id_token) return null;
  return {
    idToken: t.id_token,
    email: decodeJwtEmail(t.id_token) || "",
    name: decodeJwtName(t.id_token) || "",
    picture: (typeof decodeJwtPicture === "function" && decodeJwtPicture(t.id_token)) || "",
  };
}

const listeners = new Set<() => void>();
let wired = false;
function wire() {
  if (wired || typeof setAuthRenderSink !== "function") return;
  wired = true;
  setAuthRenderSink(() => listeners.forEach((fn) => fn()));
}

export function useAuth(): Who {
  const [who, setWho] = useState<Who>(readWho);
  useEffect(() => {
    wire();
    const on = () => setWho(readWho());
    listeners.add(on);
    return () => { listeners.delete(on); };
  }, []);
  return who;
}

// Opens the sign-in window wherever one is mounted (SiteHeader and
// Workspace each mount one). The old pages called window.openSignIn().
export const SIGNIN_EVENT = "ooj-signin";
export const requestSignIn = () => dispatchEvent(new Event(SIGNIN_EVENT));

// The sign-in window's choices (terms, product updates) go to the account
// on the first page that loads signed in. Once per page load.
let consentSynced = false;
export function syncConsentOnce() {
  if (consentSynced || typeof syncConsent !== "function") return;
  consentSynced = true;
  syncConsent().catch(() => { /* asked again next page */ });
}
