// Where /login sends a signed-in visitor: ?next= when it is a path on this
// site, else the account. "//evil.com", "/\evil.com" and full URLs are
// other sites, so they never count (tests/test_login_next.mjs).
export function nextPath(search: string): string {
  const next = new URLSearchParams(search).get("next") || "";
  return next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/account";
}
