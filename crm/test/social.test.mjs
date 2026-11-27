// Social posting without the networks: node --test crm/test/social.test.mjs
// DynamoDB and the three networks' APIs are an in-memory stand-in (fake fetch).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as Social from "../lib/social.mjs";

const realFetch = globalThis.fetch;
const ENV = { CRM_TABLE: "crm", AWS_ACCESS_KEY_ID: "k", AWS_SECRET_ACCESS_KEY: "s", SOCIAL_KEY: "test-key",
  INSTAGRAM_APP_ID: "ig", INSTAGRAM_APP_SECRET: "igs", TIKTOK_CLIENT_KEY: "tt", TIKTOK_CLIENT_SECRET: "tts" };
const IMG = { url: "https://oceanofjobs.com/mail/social/a.jpg", type: "image", mime: "image/jpeg", bytes: 1000 };

// The CRM table plus whatever the test answers for network calls.
function fake(net) {
  const rows = [];
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const target = (init.headers || {})["x-amz-target"] || "";
    const ok = (o) => new Response(JSON.stringify(o), { status: 200 });
    if (target) {
      const b = JSON.parse(init.body);
      const same = (k) => (i) => i.pk.S === k.pk.S && i.sk.S === k.sk.S;
      if (target.endsWith(".PutItem")) { const i = rows.findIndex(same(b.Item)); if (i >= 0) rows.splice(i, 1); rows.push(b.Item); return ok({}); }
      if (target.endsWith(".GetItem")) { const it = rows.find(same(b.Key)); return ok(it ? { Item: it } : {}); }
      if (target.endsWith(".DeleteItem")) { const i = rows.findIndex(same(b.Key)); if (i >= 0) rows.splice(i, 1); return ok({}); }
      if (target.endsWith(".Query")) {
        const items = rows.filter((i) => i.pk.S === b.ExpressionAttributeValues[":p"].S).sort((x, y) => x.sk.S.localeCompare(y.sk.S));
        return ok({ Items: b.ScanIndexForward === false ? items.reverse() : items });
      }
      return ok({});
    }
    calls.push([init.method || "GET", u]);
    const r = net(u, init);
    return r instanceof Response ? r : ok(r);
  };
  return { rows, calls };
}

async function connected(env, net, extra = {}) {
  const { put } = await import("../lib/store.mjs");
  await put(env, { pk: "social", sk: net, user_id: "17841", name: "Ocean of Jobs", handle: "@oceanofjobs", connected_at: new Date().toISOString(),
    expires: new Date(Date.now() + 30 * 864e5).toISOString(), secret: await Social.seal(env, { access: "tok-" + net, refresh: "r" }), ...extra });
}

test("LinkedIn text: reserved characters escaped, hashtags kept as hashtags", () => {
  assert.equal(Social.liText("Pay (median) is $305K #jobs #AI_2026 @me"),
    "Pay \\(median\\) is $305K {hashtag|\\#|jobs} {hashtag|\\#|AI\\_2026} \\@me");
  assert.equal(Social.liText("a_b *c* ~d~ [e] <f> {g} | \\"), "a\\_b \\*c\\* \\~d\\~ \\[e\\] \\<f\\> \\{g\\} \\| \\\\");
});

test("tokens are sealed: they round-trip, and a different key can't open them", async () => {
  const s = await Social.seal(ENV, { access: "secret-token" });
  assert.ok(!s.includes("secret-token"));
  assert.deepEqual(await Social.unseal(ENV, s), { access: "secret-token" });
  await assert.rejects(Social.unseal({ ...ENV, SOCIAL_KEY: "other" }, s));
  await assert.rejects(Social.seal({ ...ENV, SOCIAL_KEY: "" }, {}), /CRM_SOCIAL_KEY/);
});

test("each network's limits are checked before anything is sent", () => {
  const vid = { ...IMG, type: "video", mime: "video/mp4" };
  assert.deepEqual(Social.check({ networks: ["instagram"], media: [] }), ["Instagram needs an image or a video."]);
  assert.deepEqual(Social.check({ networks: ["linkedin"], media: [vid, IMG] }), ["LinkedIn takes one video on its own, or up to 20 images."]);
  assert.deepEqual(Social.check({ networks: ["tiktok"], media: [{ ...IMG, mime: "image/png" }] }), ["TikTok photos must be JPEG."]);
  assert.deepEqual(Social.check({ networks: ["linkedin"], media: [], caption: "Just text" }), []);
  assert.deepEqual(Social.check({ networks: ["instagram", "linkedin", "tiktok"], media: [IMG] }), []);
});

test("Instagram: one image goes container, ready, publish, link", async () => {
  const { calls } = fake((u, init) => {
    if (u.endsWith("/17841/media") && init.method === "POST") return { id: "c1" };
    if (u.includes("/c1?")) return { status_code: "FINISHED" };
    if (u.endsWith("/17841/media_publish")) { assert.equal(new URLSearchParams(init.body).get("creation_id"), "c1"); return { id: "m1" }; }
    if (u.includes("/m1?")) return { permalink: "https://www.instagram.com/p/abc/" };
    return new Response(JSON.stringify({ error: { message: "unexpected " + u } }), { status: 400 });
  });
  await connected(ENV, "instagram");
  const post = await Social.save(ENV, { mode: "now", networks: ["instagram"], caption: "Top 10", media: [IMG] }, "owner");
  assert.equal(post.status, "publishing");
  const { post: done } = await Social.advance(ENV, post);
  globalThis.fetch = realFetch;
  assert.equal(done.status, "done");
  assert.equal(done.results.instagram.url, "https://www.instagram.com/p/abc/");
  const created = calls.find(([m, u]) => m === "POST" && u.endsWith("/17841/media"));
  assert.ok(created);
});

test("Instagram: a video still processing waits for the next step instead of publishing", async () => {
  let ready = false;
  fake((u, init) => {
    if (u.endsWith("/media") && init.method === "POST") { assert.equal(new URLSearchParams(init.body).get("media_type"), "REELS"); return { id: "c2" }; }
    if (u.includes("/c2?")) return { status_code: ready ? "FINISHED" : "IN_PROGRESS" };
    if (u.endsWith("/media_publish")) return { id: "m2" };
    if (u.includes("/m2?")) return { permalink: "https://www.instagram.com/reel/x/" };
    return {};
  });
  await connected(ENV, "instagram");
  const post = await Social.save(ENV, { mode: "now", networks: ["instagram"], media: [{ ...IMG, type: "video", mime: "video/mp4" }] }, "owner");
  const first = (await Social.advance(ENV, post)).post;
  assert.equal(first.status, "publishing");
  assert.equal(first.results.instagram.state, "processing");
  ready = true;
  const second = (await Social.advance(ENV, first)).post;
  globalThis.fetch = realFetch;
  assert.equal(second.results.instagram.state, "posted");
});

test("one network failing leaves the others posted: partial, with the network's own reason", async () => {
  fake((u, init) => {
    if (u.endsWith("/media") && init.method === "POST") return { id: "c3" };
    if (u.includes("/c3?")) return { status_code: "FINISHED" };
    if (u.endsWith("/media_publish")) return { id: "m3" };
    if (u.includes("/m3?")) return { permalink: "p" };
    if (u.includes("/post/publish/content/init/")) return { data: { publish_id: "p1" }, error: { code: "ok" } };
    if (u.includes("/status/fetch/")) return { data: { status: "FAILED", fail_reason: "url_ownership_unverified" }, error: { code: "ok" } };
    return {};
  });
  await connected(ENV, "instagram");
  await connected(ENV, "tiktok");
  const post = await Social.save(ENV, { mode: "now", networks: ["instagram", "tiktok"], media: [IMG] }, "owner");
  const done = (await Social.advance(ENV, post)).post;
  globalThis.fetch = realFetch;
  assert.equal(done.status, "partial");
  assert.equal(done.results.instagram.state, "posted");
  assert.match(done.results.tiktok.error, /url_ownership_unverified/);
});

test("TikTok: in the inbox counts as sent; a TikTok error object stops it", async () => {
  fake((u) => {
    if (u.includes("/post/publish/content/init/")) return { data: { publish_id: "p2" }, error: { code: "ok", message: "" } };
    if (u.includes("/status/fetch/")) return { data: { status: "SEND_TO_USER_INBOX" }, error: { code: "ok" } };
    return {};
  });
  await connected(ENV, "tiktok");
  const post = await Social.save(ENV, { mode: "now", networks: ["tiktok"], media: [IMG] }, "owner");
  const done = (await Social.advance(ENV, post)).post;
  assert.equal(done.status, "done");
  assert.equal(done.results.tiktok.state, "inbox");

  fake((u) => (u.includes("/content/init/") ? new Response(JSON.stringify({ error: { code: "access_token_invalid", message: "The access token is invalid" } }), { status: 401 }) : {}));
  await connected(ENV, "tiktok");
  const bad = (await Social.advance(ENV, await Social.save(ENV, { mode: "now", networks: ["tiktok"], media: [IMG] }, "owner"))).post;
  globalThis.fetch = realFetch;
  assert.equal(bad.status, "failed");
  assert.match(bad.results.tiktok.error, /TikTok: The access token is invalid/);
});

test("saving refuses what can't go out, and a sent post can't be edited", async () => {
  fake(() => ({}));
  await assert.rejects(Social.save(ENV, { mode: "now", networks: ["instagram"], media: [IMG] }, "owner"), /Connect Instagram first/);
  await assert.rejects(Social.save(ENV, { mode: "schedule", networks: ["instagram"], media: [IMG], at: "2020-01-01T00:00:00Z" }, "owner"), /future/);
  // Media from anywhere but the CRM's own uploads is dropped.
  const draft = await Social.save(ENV, { mode: "draft", networks: ["instagram"], media: [{ url: "https://evil.example/x.jpg" }, IMG] }, "owner");
  assert.equal(draft.media.length, 1);
  await connected(ENV, "instagram");
  const sent = await Social.save(ENV, { mode: "now", networks: ["instagram"], media: [IMG] }, "owner");
  await assert.rejects(Social.save(ENV, { sk: sent.sk, mode: "draft" }, "owner"), /already sent/);
  globalThis.fetch = realFetch;
});

test("connecting: the state is one-use, ten minutes long, and for that network only", async () => {
  const { rows } = fake(() => ({}));
  const url = new URL(await Social.connectUrl(ENV, "instagram", "https://crm.example"));
  assert.equal(url.searchParams.get("redirect_uri"), "https://crm.example/api/social/callback/instagram");
  const state = url.searchParams.get("state");
  await assert.rejects(Social.finishConnect(ENV, "tiktok", { code: "c", state }, "https://crm.example", "owner"), /expired/);
  // Used once (by the wrong network) it's gone.
  await assert.rejects(Social.finishConnect(ENV, "instagram", { code: "c", state }, "https://crm.example", "owner"), /expired/);
  const old = new URL(await Social.connectUrl(ENV, "instagram", "https://crm.example")).searchParams.get("state");
  rows.find((r) => r.sk.S === old).at = { S: new Date(Date.now() - 11 * 60e3).toISOString() };
  await assert.rejects(Social.finishConnect(ENV, "instagram", { code: "c", state: old }, "https://crm.example", "owner"), /expired/);
  await assert.rejects(Social.connectUrl({ ...ENV, INSTAGRAM_APP_SECRET: "" }, "instagram", "https://crm.example"), /Instagram app's keys/);
  globalThis.fetch = realFetch;
});

test("the cron starts a scheduled post once it's due, not before", async () => {
  fake((u, init) => {
    if (u.endsWith("/media") && init.method === "POST") return { id: "c9" };
    if (u.includes("/c9?")) return { status_code: "FINISHED" };
    if (u.endsWith("/media_publish")) return { id: "m9" };
    return { permalink: "p" };
  });
  await connected(ENV, "instagram");
  const at = new Date(Date.now() + 3600e3).toISOString();
  const post = await Social.save(ENV, { mode: "schedule", at, networks: ["instagram"], media: [IMG] }, "owner");
  const { get } = await import("../lib/store.mjs");
  await Social.run(ENV, { now: Date.now(), log: () => {} });
  assert.equal((await get(ENV, "social_post", post.sk)).status, "scheduled");
  await Social.run(ENV, { now: Date.now() + 2 * 3600e3, log: () => {} });
  assert.equal((await get(ENV, "social_post", post.sk)).status, "done");
  globalThis.fetch = realFetch;
});
