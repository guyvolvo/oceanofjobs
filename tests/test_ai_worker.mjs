// The Workers AI Worker (infra/ai-worker.mjs): only the box's key gets
// an answer, the model is always the cheap one, and odd input is refused.
// Run:  node --test tests/test_ai_worker.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../infra/ai-worker.mjs";

const calls = [];
const env = { AI_KEY: "k".repeat(43), AI: { run: async (model, input) => { calls.push({ model, input }); return { response: "30 days", usage: { prompt_tokens: 600, completion_tokens: 3 } }; } } };
const req = (body, headers = { "x-ooj-ai-key": env.AI_KEY }, method = "POST", path = "/__ai") =>
  worker.fetch(new Request("https://oceanofjobs.com" + path, { method, headers: { "content-type": "application/json", ...headers }, body: method === "POST" ? JSON.stringify(body) : undefined }), env);
const ok = { messages: [{ role: "system", content: "s" }, { role: "user", content: "q" }], model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", max_tokens: 5000 };

test("the box's key gets an answer with its token counts, from the fixed small model", async () => {
  const res = await req(ok);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { response: "30 days", usage: { prompt_tokens: 600, completion_tokens: 3 }, model: "@cf/meta/llama-3.1-8b-instruct-fp8-fast" });
  assert.equal(calls.at(-1).model, "@cf/meta/llama-3.1-8b-instruct-fp8-fast", "a caller cannot pick a bigger model");
  assert.equal(calls.at(-1).input.max_tokens, 300, "and output is capped");
});

test("no key, a wrong key or a key of another length is refused before the model runs", async () => {
  const before = calls.length;
  for (const h of [{}, { "x-ooj-ai-key": "x".repeat(43) }, { "x-ooj-ai-key": env.AI_KEY + "x" }]) assert.equal((await req(ok, h)).status, 403);
  assert.equal(calls.length, before);
});

test("a Worker with no key configured refuses everything", async () => {
  const res = await worker.fetch(new Request("https://oceanofjobs.com/__ai", { method: "POST", headers: { "x-ooj-ai-key": "" }, body: "{}" }), { AI: env.AI });
  assert.equal(res.status, 403);
});

test("only system and user turns, only POST, only /__ai", async () => {
  assert.equal((await req({ messages: [{ role: "assistant", content: "x" }] })).status, 400);
  assert.equal((await req({ messages: "x" })).status, 400);
  assert.equal((await req(null, undefined, "GET")).status, 405);
  assert.equal((await req(ok, undefined, "POST", "/__ai/other")).status, 404);
});
