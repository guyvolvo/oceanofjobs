// The board's URL state (store.ts): a URL read in and written back out,
// the bad values a shared link can carry, and the reset Back and a saved
// search do. store.ts is bundled with rolldown (Vite's own bundler) with
// its browser-only imports stubbed, so no browser is needed.
// usage: cd apply && node --test scripts/board_url.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";

const STUBS = {
  react: "export const useSyncExternalStore = () => 0;",
  api: "export const signedIn = () => false; export const api = async () => ({});",
  auth: "export const requestSignIn = () => {};",
};
const bundle = await rolldown({
  input: fileURLToPath(new URL("../src/board/store.ts", import.meta.url)),
  logLevel: "silent",
  plugins: [{
    name: "stubs",
    resolveId(id) {
      if (id === "react") return "\0stub:react";
      if (id === "../api") return "\0stub:api";
      if (id === "../site/auth") return "\0stub:auth";
    },
    load(id) { if (id.startsWith("\0stub:")) return STUBS[id.slice(6)]; },
  }],
});
const { output } = await bundle.generate({ format: "esm" });
const store = await import(`data:text/javascript;base64,${Buffer.from(output[0].code).toString("base64")}`);
const { F, applyStateFromUrl, buildShareParams } = store;
const share = () => buildShareParams().toString();
const read = (q, reset = true) => { applyStateFromUrl(q, { reset }); return share(); };

test("a URL written back out is the same URL", () => {
  const q = "search=python&company=google.com&workplace=remote&max_age_days=7&roles=tech&sort=age&dir=desc";
  assert.equal(read(`?${q}`), q);
  assert.equal(read(`?${share()}`), q);
  assert.equal(read("?department=Data%20%26%20AI&country=IL&city=IL%3ATel+Aviv&salary_min=20000&salary_known=1&starred=1"),
    "department=Data+%26+AI&country=IL&city=IL%3ATel+Aviv&salary_min=20000&salary_known=1&starred=1");
});

test("the defaults are left out", () => {
  assert.equal(read(""), "");
  assert.equal(read("?roles=all&sort=age&dir=asc&confidence=all"), "");
  // A search sorts by relevance unless the link says otherwise.
  assert.equal(read("?search=react"), "search=react");
});

test("q and keywords become the search", () => {
  assert.equal(read("?q=python&keywords=django;flask%20web"), `search=${encodeURIComponent('python django "flask web"').replace(/%20/g, "+")}`);
});

test("bad values are dropped", () => {
  assert.equal(read("?max_age_days=banana&sort=%3Cscript%3E&dir=up&salary_min=-5&salary_known=maybe&offset=abc"), "");
  assert.equal(F.offset, 0);
  assert.equal(F.sort, "age");
  assert.equal(read("?offset=-50"), "");
  assert.equal(F.offset, 0);
});

test("reset: Back and a saved search keep nothing the URL leaves out", () => {
  read("?company=google.com&search=python&max_age_days=3&sort=age");
  assert.equal(read("?workplace=remote"), "workplace=remote");
  assert.deepEqual(F.company, []);
  assert.equal(F.search, "");
  assert.equal(F.sortExplicit, false);
});

test("without reset (boot) what the URL leaves out stays", () => {
  read("?country=IL");
  assert.equal(read("?workplace=remote", false), "country=IL&workplace=remote");
});

test("skills in the URL start a clean match view", () => {
  read("?search=python&company=google.com");
  assert.equal(read("?skills=python,sql", false), "skills=python%2Csql&sort=match");
});
