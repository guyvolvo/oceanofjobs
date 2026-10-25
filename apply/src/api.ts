// The API under /api/me/apply/, signed in with the site's own tokens.
// auth.js (loaded by index.html before this bundle) owns them; this is
// the same refresh-then-fetch that app.js's authedFetch does, in TS.

type Tokens = { id_token: string; access_token: string; refresh_token: string };
declare function getAuthTokens(): Tokens | null;
declare function setAuthTokens(t: Tokens): void;
declare function cognitoRequest(target: string, body: object): Promise<{ AuthenticationResult: { IdToken: string; AccessToken: string } }>;
declare function signOut(): void;
declare const COGNITO_CLIENT_ID: string;

export type Plan = "free" | "basic" | "pro";
export type Summary = {
  plan: Plan; period: "month" | "day"; limit: number; daily_max: number | null;
  used: number; in_progress: number; remaining: number; applied_today: number; filled_today: number;
  unconfirmed: number; needs_input: number; queued: number; disputes_left: number;
  ai: { used: number; limit: number | null }; tz: string;
};
export type Status = "submitted" | "unconfirmed" | "filled" | "in_progress" | "needs_input" | "failed" | "skipped" | "abandoned" | "not_sent_disputed";
export type HistoryRow = {
  job_id: string; attempt_id: string | null; company: string; title: string; url: string;
  link: string; status: Status; reason: string; at: string; disputable: boolean;
};
export type Need = { attempt_id: string; job_id: string; title: string; company: string; link: string; questions: string[];
  drafts?: Record<string, string>; ready?: boolean };
export type QueueItem = { job_id: string; added_at: string; position: number; title: string; company: string; link: string; ats: string };
export type Profile = {
  contact: { first_name: string; last_name: string; email: string; phone: string; location: string };
  links: { linkedin: string; github: string; website: string };
  work: { authorized_countries: string[]; needs_sponsorship: boolean | null; notice_period: string; salary: string };
  eeo: Record<"gender" | "race" | "veteran" | "disability", string | null>;
  answers: { question: string; answer: string }[];
  settings: {
    mode: "queue" | "auto"; sources: string[]; unknowns: "skip" | "ai";
    guardrails: { min_match: number | null; daily_limit: number | null; blocked_companies: string[]; one_per_company_days: number | null };
  };
};

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

export function signedIn(): boolean {
  return typeof getAuthTokens === "function" && !!getAuthTokens()?.id_token;
}

async function freshTokens(): Promise<Tokens | null> {
  const tokens = getAuthTokens();
  if (!tokens) return null;
  const payload = JSON.parse(atob(tokens.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  if (payload.exp * 1000 - Date.now() > 60_000) return tokens;
  try {
    const t = (await cognitoRequest("InitiateAuth", {
      ClientId: COGNITO_CLIENT_ID, AuthFlow: "REFRESH_TOKEN_AUTH", AuthParameters: { REFRESH_TOKEN: tokens.refresh_token },
    })).AuthenticationResult;
    const refreshed = { id_token: t.IdToken, access_token: t.AccessToken, refresh_token: tokens.refresh_token };
    setAuthTokens(refreshed);
    return refreshed;
  } catch (err) {
    // Only a refresh token Cognito refuses ends the session; a timeout
    // or a throttle fails this one request and keeps the tokens.
    if (!String((err as { code?: string })?.code || "").endsWith("NotAuthorizedException")) {
      throw new ApiError("Couldn't reach the sign-in service. Try again.", 0);
    }
    signOut();
    return null;
  }
}

// path is under /api, e.g. "/me/apply/summary".
export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const tokens = await freshTokens();
  if (!tokens) throw new ApiError("Signed out", 401);
  const res = await fetch(`/api${path}`, {
    ...init,
    signal: init.signal || AbortSignal.timeout(20000),
    headers: { "Content-Type": "application/json", ...(init.headers || {}), Authorization: `Bearer ${tokens.id_token}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error || `HTTP ${res.status}`, res.status, body.code);
  }
  return (res.status === 204 ? null : await res.json()) as T;
}

// A public route (no token), retried like the board's getJSON: a dropped
// connection, a 5xx or a 429 gets three more tries, a 4xx is final.
const RETRY_WAITS = [600, 1500, 3500];
export async function pub<T = unknown>(path: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`/api${path}`);
    } catch (err) {
      if (attempt >= RETRY_WAITS.length) throw err;
      await new Promise((r) => setTimeout(r, RETRY_WAITS[attempt]));
      continue;
    }
    if (res.ok) return res.json() as Promise<T>;
    if ((res.status >= 500 || res.status === 429) && attempt < RETRY_WAITS.length) {
      await new Promise((r) => setTimeout(r, RETRY_WAITS[attempt]));
      continue;
    }
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error || `HTTP ${res.status}`, res.status);
  }
}

export const apply = <T = unknown>(path: string, init?: RequestInit) => api<T>(`/me/apply/${path}`, init);
export const send = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });
