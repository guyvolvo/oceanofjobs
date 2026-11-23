// Who is signed in and which theme is on, read so that a prerendered page
// hydrates cleanly: the server (and the first client render) always see
// "signed out, light", then React re-renders with the browser's answer.
// Both come from the same places the old pages use: auth.js's tokens
// (iljobs_auth_tokens) and <html data-mode>, set before first paint.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { Who } from "../site/auth";

const authListeners = new Set<() => void>();
export const notifyAuth = () => authListeners.forEach((fn) => fn());

function subscribeAuth(fn: () => void) {
  // auth.js has one render sink; every useWho shares it.
  if (typeof setAuthRenderSink === "function") setAuthRenderSink(notifyAuth);
  authListeners.add(fn);
  addEventListener("storage", fn);
  return () => { authListeners.delete(fn); removeEventListener("storage", fn); };
}
const idToken = () => (typeof getAuthTokens === "function" && getAuthTokens()?.id_token) || null;

export function useWho(): Who {
  const token = useSyncExternalStore(subscribeAuth, idToken, () => null);
  const who = useMemo(() => token ? {
    idToken: token,
    email: decodeJwtEmail(token) || "",
    name: decodeJwtName(token) || "",
    picture: (typeof decodeJwtPicture === "function" && decodeJwtPicture(token)) || "",
  } : null, [token]);
  // The head script marks a signed-in page before paint so "Log in" never
  // flashes; once React knows, the mark follows the real state.
  useEffect(() => { document.documentElement.toggleAttribute("data-auth", !!who); }, [who]);
  return who;
}

function subscribeTheme(fn: () => void) {
  const watch = new MutationObserver(fn);
  watch.observe(document.documentElement, { attributeFilter: ["data-mode"] });
  return () => watch.disconnect();
}
export const useDark = () => useSyncExternalStore(subscribeTheme, () => document.documentElement.getAttribute("data-mode") === "dark", () => false);

// The last good answer of each workspace load, kept while moving between
// pages so a page shown again paints at once and asks again behind it.
// Only for the reader who loaded it: another account or a sign-out empties it.
const memo = new Map<string, unknown>();
let memoFor: string | null = null;
function mine() {
  const t = idToken();
  const me = t ? decodeJwtEmail(t) || t : null;
  if (me !== memoFor) { memo.clear(); memoFor = me; }
}
export function recall<T>(key: string): T | undefined { mine(); return memo.get(key) as T | undefined; }
export function remember<T>(key: string, value: T): T { mine(); memo.set(key, value); return value; }
