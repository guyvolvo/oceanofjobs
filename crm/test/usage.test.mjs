// crm/lib/usage.mjs without the network: which MCP clients are checks,
// days filled with zeros, and extension and MCP tokens counted.
import test from "node:test";
import assert from "node:assert/strict";
import { isChecker, connections } from "../lib/usage.mjs";

test("directories and monitors are checks, assistants are sessions", () => {
  for (const c of ["mcpbeat", "glimind-probe", "alalanet-prober", "glama", "hostedmcp-liveness", "koskamo-mcp-directory-check", "noufl-verifier", "mcpwatch", "atpp-scan", "mcp-observatory", "", null]) {
    assert.equal(isChecker(c), true, String(c));
  }
  for (const c of ["codex-mcp-client", "coda-agent-runtime", "claude-ai", "cursor-vscode", "rmcp"]) assert.equal(isChecker(c), false, c);
});

test("tokens are counted per kind, active means used in the last 7 days", () => {
  const now = Date.parse("2026-11-24T12:00:00Z");
  const got = connections([
    { tokens: [{ scope: "extension", last_used_at: "2026-11-23T10:00:00Z" }, { scope: "mcp", last_used_at: "2026-11-01T10:00:00Z" }] },
    { tokens: [{ scope: "extension", last_used_at: "" }, { scope: "", last_used_at: "2026-11-24T09:00:00Z" }] },
    { tokens: [] },
  ], now);
  assert.deepEqual(got, { extension: { connected: 2, active: 1 }, mcp: { connected: 2, active: 1 } });
});
