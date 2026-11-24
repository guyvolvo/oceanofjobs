// Where /login sends a signed-in visitor: ?next= when it is a path on this
// site; else the page on this site they came from; else the account.
// "//evil.com", "/\evil.com" and full URLs are other sites, so they never
// count (tests/test_login_next.mjs).
const local = (p: string) => p.startsWith("/") && !p.startsWith("//") && !p.startsWith("/\\");

export function nextPath(search: string, referrer = "", origin = "https://oceanofjobs.com"): string {
  const next = new URLSearchParams(search).get("next") || "";
  if (local(next)) return next;
  try {
    const from = new URL(referrer);
    if (from.origin === origin && from.pathname !== "/login") return from.pathname + from.search + from.hash;
  } catch { /* no referrer, or not a URL */ }
  return "/account";
}
