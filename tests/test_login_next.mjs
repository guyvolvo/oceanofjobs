// Where /login sends someone once signed in (apply/src/login/next.ts):
// ?next=, else the page on this site they came from, else the account.
// Never another site. Run: node tests/test_login_next.mjs
import assert from "node:assert/strict";
import { nextPath } from "../apply/src/login/next.ts";

assert.equal(nextPath(""), "/account");
assert.equal(nextPath("?next=/apply/settings"), "/apply/settings");
assert.equal(nextPath("?next=%2Fboard%3Fview%3Dmatches"), "/board?view=matches");
for (const bad of ["//evil.com", "/\\evil.com", "https://evil.com", "javascript:alert(1)", "evil.com"]) {
  assert.equal(nextPath("?next=" + encodeURIComponent(bad)), "/account", bad);
}
// No ?next=: back to the page on this site the reader came from.
assert.equal(nextPath("", "https://oceanofjobs.com/board?country=IL"), "/board?country=IL");
assert.equal(nextPath("", "https://oceanofjobs.com/job/abc#apply"), "/job/abc#apply");
assert.equal(nextPath("", "https://evil.com/board"), "/account");
assert.equal(nextPath("", "https://oceanofjobs.com/login?next=x"), "/account");
assert.equal(nextPath("?next=/pricing", "https://oceanofjobs.com/board"), "/pricing");
console.log("all passed");
