// Changes the CRM can't make itself, asked of the website's server: the
// waitlists live in the members' table, which the CRM's AWS user only
// reads. The server's /api/admin/waitlist (api/handler.py) accepts only a
// request signed with a key derived from the unsubscribe secret both
// hold; it goes straight to the server, like the MCP Worker's requests.
const BOX = "https://box.oceanofjobs.com";

async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
}
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

export async function signature(secret, ts, body) {
  const key = await hmac(new TextEncoder().encode(secret), "ooj-crm-admin-v1");
  return hex(await hmac(key, `${ts}\n${body}`));
}

export async function waitlistChange(env, payload, { fetchImpl = fetch, now = Date.now() } = {}) {
  const body = JSON.stringify(payload);
  const ts = Math.floor(now / 1000);
  const res = await fetchImpl(`${env.BOX_URL || BOX}/api/admin/waitlist`, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json", "x-otj-origin-key": env.ORIGIN_KEY || "", "user-agent": "ooj-crm",
      "X-OOJ-Time": String(ts), "X-OOJ-Sig": await signature(env.UNSUBSCRIBE_SECRET || "", ts, body) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `The server refused the change (${res.status}).`), { status: res.status >= 500 ? 502 : res.status });
  return data;
}
