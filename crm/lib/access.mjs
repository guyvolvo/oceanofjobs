// The second lock. Cloudflare Access already stops anyone who isn't the
// owner before this Worker runs; this checks Access's signed token again on
// every request, so a misrouted request, a forgotten route or a disabled
// Access app still gets nothing.
//
// The token (Cf-Access-Jwt-Assertion) is an RS256 JWT signed by the team's
// keys at https://<team>.cloudflareaccess.com/cdn-cgi/access/certs. It must
// carry this app's audience tag (ACCESS_AUD), come from that team, be in
// date, and name the one allowed address (OWNER_EMAIL).

const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const json = (s) => JSON.parse(new TextDecoder().decode(b64url(s)));

let keys = null; // { at, byKid }
const KEYS_FOR = 10 * 60 * 1000;

async function teamKeys(env, fetchImpl = fetch, force = false) {
  if (!force && keys && Date.now() - keys.at < KEYS_FOR) return keys.byKid;
  const res = await fetchImpl(`https://${env.ACCESS_TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error("couldn't load the Access keys");
  const { keys: list } = await res.json();
  const byKid = {};
  for (const jwk of list || []) {
    if (jwk.kty === "RSA") byKid[jwk.kid] = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  }
  keys = { at: Date.now(), byKid };
  return byKid;
}

// The verified owner's email, or null. Never throws for a bad token.
export async function owner(request, env, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!env.ACCESS_TEAM || !env.ACCESS_AUD || !env.OWNER_EMAIL) return null; // not configured: nobody gets in
  const token = request.headers.get("Cf-Access-Jwt-Assertion") || "";
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let head, claims;
  try {
    head = json(parts[0]);
    claims = json(parts[1]);
  } catch {
    return null;
  }
  if (head.alg !== "RS256" || !head.kid) return null;
  let key;
  try {
    key = (await teamKeys(env, fetchImpl))[head.kid] || (await teamKeys(env, fetchImpl, true))[head.kid];
  } catch {
    return null;
  }
  if (!key) return null;
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return null;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const sec = now / 1000;
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (claims.iss !== `https://${env.ACCESS_TEAM}.cloudflareaccess.com`) return null;
  if (!(claims.exp > sec) || (claims.nbf && claims.nbf > sec + 60)) return null;
  const email = String(claims.email || "").toLowerCase();
  if (!email || email !== String(env.OWNER_EMAIL).toLowerCase()) return null;
  return email;
}

export function _resetKeys() { keys = null; }
