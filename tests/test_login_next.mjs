// Where /login sends someone once signed in (apply/src/login/next.ts):
// only paths on this site, never another site. Run: node tests/test_login_next.mjs
import assert from "node:assert/strict";
import { nextPath } from "../apply/src/login/next.ts";

assert.equal(nextPath(""), "/account");
assert.equal(nextPath("?next=/apply/settings"), "/apply/settings");
assert.equal(nextPath("?next=%2Fboard%3Fview%3Dmatches"), "/board?view=matches");
for (const bad of ["//evil.com", "/\\evil.com", "https://evil.com", "javascript:alert(1)", "evil.com"]) {
  assert.equal(nextPath("?next=" + encodeURIComponent(bad)), "/account", bad);
}
console.log("all passed");
