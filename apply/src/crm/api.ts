// The CRM's own API (crm/worker.mjs). Cloudflare Access's cookie goes with
// every same-origin request; writes add X-CRM, which the Worker requires.
export class CrmError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function crm<T = unknown>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: method === "GET" ? {} : { "X-CRM": "1", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new CrmError((data as { error?: string }).error || `HTTP ${res.status}`, res.status);
  }
  return res.json() as Promise<T>;
}

export type Contact = {
  id: string; email: string; verified: boolean; provider: string; status: string; enabled: boolean;
  created: string | null; updated: string | null;
  newsletter: boolean; newsletter_source: string | null; newsletter_at: string | null; unsubscribed_at: string | null;
  agreed_version: string | null; agreed_at: string | null; plan: string; license: { plan: string; until: string } | null;
  waitlist: string[]; tags: string[];
};
export type Billing = {
  plan: string;
  paid: { plan: string; status: string; period_end: string; subscription_id: string; customer_id: string; event_at: string } | null;
  license: { plan: string; until: string; note: string; by: string; at: string } | null;
  ledgers: { key: string; held: number; charged: number }[];
};
export type DirectEmail = { sk: string; subject: string; body: string; to: string };
export type Filter = { newsletter?: boolean; waitlist?: string; plan?: string; tag?: string; signed_up_after?: string; search?: string };
export type Segment = { sk: string; name: string; filter: Filter; updated: string };
export type Campaign = { sk: string; subject: string; body: string; segment: string; status: "draft" | "sending" | "sent";
  created: string; updated: string; sent: number; sent_at?: string; changelog?: string; to?: string[] };
export type Entry = { sk: string; date: string; title: string; body: string; created: string; published_at: string };

export const day = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");
export const plural = (n: number, one: string, many = one + "s") => `${n.toLocaleString()} ${n === 1 ? one : many}`;
export function describe(f: Filter = {}) {
  const parts = [];
  if (f.newsletter === true) parts.push("newsletter on");
  if (f.newsletter === false) parts.push("newsletter off");
  if (f.waitlist) parts.push(f.waitlist === "any" ? "on a waitlist" : `${f.waitlist} waitlist`);
  if (f.plan) parts.push(`${f.plan} plan`);
  if (f.tag) parts.push(`tagged ${f.tag}`);
  if (f.signed_up_after) parts.push(`joined after ${day(f.signed_up_after)}`);
  if (f.search) parts.push(`matching "${f.search}"`);
  return parts.length ? parts.join(", ") : "everyone";
}
