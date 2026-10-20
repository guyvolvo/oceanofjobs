// Workers AI for the box: POST https://oceanofjobs.com/__ai
//
// The API (api/ai_answers.py) drafts answers to application questions
// with a small model. It calls this Worker rather than Cloudflare's REST
// API, so no Cloudflare API token exists for it anywhere: the model is a
// binding (env.AI). The only credential is AI_KEY, a random secret shared
// with the box by scripts/deploy_ai_worker.py and never printed.
//
// The model is fixed here, not chosen by the caller, so a leaked key can
// spend only the cheap model's neurons, which the API counts and
// infra/alarms.tf watches. The route fails open: with the Workers
// allowance spent, /__ai falls through to CloudFront's 404 and the API
// treats the answer as unavailable.
//
// Deployed by scripts/deploy_ai_worker.py.

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8-fast";
const MAX_BODY = 16384;

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

function sameSecret(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/__ai") return reply(404, { error: "not found" });
    if (request.method !== "POST") return reply(405, { error: "POST only" });
    if (!sameSecret(request.headers.get("x-ooj-ai-key") || "", env.AI_KEY || "")) return reply(403, { error: "forbidden" });
    const raw = await request.text();
    if (raw.length > MAX_BODY) return reply(413, { error: "too large" });
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return reply(400, { error: "not JSON" });
    }
    const messages = Array.isArray(body.messages) ? body.messages.slice(0, 4) : null;
    if (!messages || !messages.every((m) => m && typeof m.content === "string" && ["system", "user"].includes(m.role))) {
      return reply(400, { error: "messages must be system and user turns" });
    }
    const maxTokens = Math.min(Number(body.max_tokens) || 200, 300);
    try {
      const out = await env.AI.run(MODEL, { messages, max_tokens: maxTokens });
      return reply(200, { response: out.response ?? "", usage: out.usage ?? null, model: MODEL });
    } catch (e) {
      return reply(502, { error: "model failed", detail: String(e && e.message || e).slice(0, 200) });
    }
  },
};
