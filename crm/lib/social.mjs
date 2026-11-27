// Social: the CRM posts to Instagram, LinkedIn and TikTok through each
// network's own API, with the owner's own developer apps (keys in .env).
//
// Accounts: connected by OAuth from the Social page; the tokens are sealed
// with AES-GCM (CRM_SOCIAL_KEY) before they reach the CRM table, pk
// "social", sk the network.
// Posts: pk "social_post", sk "<created>#<id>". Each network's result is a
// small state machine (queued -> processing -> posted | inbox | failed),
// moved on by advance(): from the page right after "Post now", and by the
// social cron every 5 minutes for scheduled posts and slow video uploads.
// Media: uploaded to the site's bucket under mail/social/ (the only prefix
// the CRM's key may write) and served from https://oceanofjobs.com/, which
// is where Instagram and TikTok fetch it from.
import { s3Stream } from "./aws.mjs";
import * as S from "./store.mjs";

export const NETWORKS = ["instagram", "linkedin", "tiktok"];
const IG = "https://graph.instagram.com/v24.0";
// LinkedIn's versioned REST API; each monthly version is kept about a year.
const LI_VERSION = "202606";
const LI = "https://api.linkedin.com/rest";
const TT = "https://open.tiktokapis.com/v2";
export const MAX_VIDEO = 64 * 1024 * 1024; // TikTok's single-chunk upload limit, the lowest of the three
export const MAX_IMAGE = 8 * 1024 * 1024; // Instagram's image limit
const DAY = 864e5;

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const APPS = {
  instagram: (env) => [env.INSTAGRAM_APP_ID, env.INSTAGRAM_APP_SECRET],
  linkedin: (env) => [env.LINKEDIN_CLIENT_ID, env.LINKEDIN_CLIENT_SECRET],
  tiktok: (env) => [env.TIKTOK_CLIENT_KEY, env.TIKTOK_CLIENT_SECRET],
};
const NAME = { instagram: "Instagram", linkedin: "LinkedIn", tiktok: "TikTok" };
const ready = (env, net) => APPS[net](env).every(Boolean);

// Sealing tokens at rest.
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function aes(env) {
  if (!env.SOCIAL_KEY) throw bad("Add CRM_SOCIAL_KEY to .env and deploy the CRM again.", 503);
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.SOCIAL_KEY));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function seal(env, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aes(env), new TextEncoder().encode(JSON.stringify(obj)));
  return b64(iv) + "." + b64(ct);
}
export async function unseal(env, s) {
  const [iv, ct] = String(s).split(".");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await aes(env), unb64(ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

// One call to a network's API, its error turned into a sentence.
async function call(net, url, { method = "GET", form, json, headers = {}, raw = false } = {}) {
  const init = { method, headers: { ...headers } };
  if (form) { init.body = new URLSearchParams(form); init.headers["Content-Type"] = "application/x-www-form-urlencoded"; }
  if (json) { init.body = JSON.stringify(json); init.headers["Content-Type"] = "application/json; charset=UTF-8"; }
  const res = await fetch(url, init);
  if (raw && res.ok) return res;
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text.slice(0, 300) }; }
  // TikTok answers every call with an error object; "ok" means none.
  const ttError = data.error && typeof data.error === "object" && data.error.code && data.error.code !== "ok";
  if (!res.ok || ttError || (typeof data.error === "string" && net !== "linkedin")) {
    const why = (data.error && (data.error.error_user_msg || data.error.message)) || data.error_message || data.error_description || data.message || data.error || `HTTP ${res.status}`;
    throw Object.assign(new Error(`${NAME[net]}: ${String(why).slice(0, 300)}`), { status: 502, net, http: res.status });
  }
  if (raw) return res;
  return Object.assign(data, { _headers: res.headers });
}

// OAuth.
const SCOPES = {
  instagram: "instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments,instagram_business_manage_insights",
  linkedin: "openid profile w_member_social",
  tiktok: "user.info.basic,user.info.stats,video.upload,video.list",
};
export const callback = (origin, net) => `${origin}/api/social/callback/${net}`;

export async function connectUrl(env, net, origin) {
  if (!NETWORKS.includes(net)) throw bad("No such network.");
  if (!ready(env, net)) throw bad(`Add the ${NAME[net]} app's keys to .env and deploy the CRM again.`, 503);
  await aes(env); // fail before the round trip, not after it
  const state = S.id() + S.id();
  await S.put(env, { pk: "social_state", sk: state, net, at: S.now() });
  const [id] = APPS[net](env);
  const redirect = callback(origin, net);
  if (net === "instagram") {
    return "https://www.instagram.com/oauth/authorize?" + new URLSearchParams({ enable_fb_login: "0", force_authentication: "1", client_id: id,
      redirect_uri: redirect, response_type: "code", scope: SCOPES.instagram, state });
  }
  if (net === "linkedin") {
    return "https://www.linkedin.com/oauth/v2/authorization?" + new URLSearchParams({ response_type: "code", client_id: id, redirect_uri: redirect, state, scope: SCOPES.linkedin });
  }
  return "https://www.tiktok.com/v2/auth/authorize/?" + new URLSearchParams({ client_key: id, response_type: "code", scope: SCOPES.tiktok, redirect_uri: redirect, state });
}

const later = (seconds) => new Date(Date.now() + Number(seconds || 0) * 1000).toISOString();

async function exchange(env, net, code, origin) {
  const [id, secret] = APPS[net](env);
  const redirect_uri = callback(origin, net);
  if (net === "instagram") {
    const short = await call(net, "https://api.instagram.com/oauth/access_token", { method: "POST",
      form: { client_id: id, client_secret: secret, grant_type: "authorization_code", redirect_uri, code } });
    const s = (short.data && short.data[0]) || short;
    const long = await call(net, "https://graph.instagram.com/access_token?" + new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: secret, access_token: s.access_token }));
    return { access: long.access_token, expires: later(long.expires_in || 60 * 86400) };
  }
  if (net === "linkedin") {
    const t = await call(net, "https://www.linkedin.com/oauth/v2/accessToken", { method: "POST",
      form: { grant_type: "authorization_code", code, redirect_uri, client_id: id, client_secret: secret } });
    return { access: t.access_token, expires: later(t.expires_in), ...(t.refresh_token ? { refresh: t.refresh_token, refresh_expires: later(t.refresh_token_expires_in) } : {}) };
  }
  const t = await call(net, `${TT}/oauth/token/`, { method: "POST",
    form: { client_key: id, client_secret: secret, code, grant_type: "authorization_code", redirect_uri } });
  return { access: t.access_token, expires: later(t.expires_in), refresh: t.refresh_token, refresh_expires: later(t.refresh_expires_in) };
}

async function profile(net, access) {
  if (net === "instagram") {
    const me = await call(net, `${IG}/me?` + new URLSearchParams({ fields: "user_id,username,name,profile_picture_url,followers_count,media_count", access_token: access }));
    return { user_id: String(me.user_id || me.id), name: me.name || me.username || "", handle: me.username ? "@" + me.username : "",
      picture: me.profile_picture_url || "", followers: me.followers_count ?? null };
  }
  if (net === "linkedin") {
    const me = await call(net, "https://api.linkedin.com/v2/userinfo", { headers: { Authorization: `Bearer ${access}` } });
    return { user_id: String(me.sub), name: me.name || "", handle: "", picture: me.picture || "", followers: null };
  }
  const me = await call(net, `${TT}/user/info/?fields=open_id,display_name,avatar_url,follower_count,likes_count,video_count`, { headers: { Authorization: `Bearer ${access}` } });
  const u = (me.data && me.data.user) || {};
  return { user_id: String(u.open_id || ""), name: u.display_name || "", handle: "", picture: u.avatar_url || "", followers: u.follower_count ?? null };
}

export async function finishConnect(env, net, { code, state, error }, origin, who) {
  if (!NETWORKS.includes(net)) throw bad("No such network.");
  const st = state ? await S.get(env, "social_state", String(state)) : null;
  if (st) await S.del(env, "social_state", st.sk);
  if (error) throw bad(`${NAME[net]} didn't connect: ${String(error).slice(0, 200)}`);
  // The state is one-use and ten minutes long: a link from anywhere else can't connect an account.
  if (!st || st.net !== net || Date.now() - Date.parse(st.at) > 10 * 60e3) throw bad("That sign-in link expired. Connect again.");
  const tok = await exchange(env, net, String(code || ""), origin);
  const me = await profile(net, tok.access);
  await saveAccount(env, net, { ...me, connected_at: S.now(), by: who }, tok);
  await S.audit(env, who, "social connect", { network: net, account: me.handle || me.name });
}

async function saveAccount(env, net, info, tok) {
  const old = (await S.get(env, "social", net)) || {};
  const { secret: _, ...keep } = old;
  await S.put(env, { ...keep, ...info, pk: "social", sk: net, expires: tok.expires, refresh_expires: tok.refresh_expires || "",
    secret: await seal(env, { access: tok.access, refresh: tok.refresh || "" }), error: "" });
}

export async function accounts(env) {
  const rows = Object.fromEntries((await S.list(env, "social", { limit: 10 })).map((r) => [r.sk, r]));
  return NETWORKS.map((net) => {
    const a = rows[net];
    return { network: net, ready: ready(env, net), connected: !!a, name: a ? a.name : "", handle: a ? a.handle : "", picture: a ? a.picture : "",
      followers: a ? a.followers ?? null : null, expires: a ? a.expires : "", refresh_expires: a ? a.refresh_expires : "",
      connected_at: a ? a.connected_at : "", error: a ? a.error || "" : "" };
  });
}

export async function disconnect(env, net, who) {
  if (!NETWORKS.includes(net)) throw bad("No such network.");
  await S.del(env, "social", net);
  await S.audit(env, who, "social disconnect", { network: net });
}

// A live token for the network, renewed first when it's close to running out.
async function token(env, net) {
  const acc = await S.get(env, "social", net);
  if (!acc) throw bad(`Connect ${NAME[net]} on the Accounts tab first.`, 409);
  const sec = await unseal(env, acc.secret);
  const left = Date.parse(acc.expires || 0) - Date.now();
  try {
    if (net === "tiktok" && left < 10 * 60e3 && sec.refresh) {
      const [id, secret] = APPS.tiktok(env);
      const t = await call(net, `${TT}/oauth/token/`, { method: "POST", form: { client_key: id, client_secret: secret, grant_type: "refresh_token", refresh_token: sec.refresh } });
      const tok = { access: t.access_token, expires: later(t.expires_in), refresh: t.refresh_token || sec.refresh, refresh_expires: t.refresh_expires_in ? later(t.refresh_expires_in) : acc.refresh_expires };
      await saveAccount(env, net, { name: acc.name, handle: acc.handle, picture: acc.picture, user_id: acc.user_id }, tok);
      return { acc, access: tok.access };
    }
    // Instagram's 60-day token renews itself once it's a day old; done with 10 days left.
    if (net === "instagram" && left < 10 * DAY && left > 0) {
      const t = await call(net, "https://graph.instagram.com/refresh_access_token?" + new URLSearchParams({ grant_type: "ig_refresh_token", access_token: sec.access }));
      await saveAccount(env, net, { name: acc.name, handle: acc.handle, picture: acc.picture, user_id: acc.user_id }, { access: t.access_token, expires: later(t.expires_in) });
      return { acc, access: t.access_token };
    }
  } catch (e) {
    await S.put(env, { ...acc, error: e.message.slice(0, 300) });
    if (left <= 0) throw e;
  }
  if (left <= 0) throw bad(`The ${NAME[net]} connection ran out. Connect it again on the Accounts tab.`, 409);
  return { acc, access: sec.access };
}

// Media: one upload, streamed from the page to the bucket.
const TYPES = { "image/jpeg": "jpg", "image/png": "png", "video/mp4": "mp4", "video/quicktime": "mov" };
export async function upload(env, request, who) {
  const type = String(request.headers.get("content-type") || "").split(";")[0];
  const length = Number(request.headers.get("content-length") || 0);
  if (!TYPES[type]) throw bad("Upload a JPEG, PNG, MP4 or MOV file.");
  const max = type.startsWith("video/") ? MAX_VIDEO : MAX_IMAGE;
  if (!length || length > max) throw bad(type.startsWith("video/") ? "Videos can be up to 64 MB." : "Images can be up to 8 MB.");
  const key = `mail/social/${S.id()}${S.id()}.${TYPES[type]}`;
  await s3Stream(env, key, request.body, length, type);
  await S.audit(env, who, "social upload", { key, bytes: length });
  return { url: `https://oceanofjobs.com/${key}`, type: type.startsWith("video/") ? "video" : "image", mime: type, bytes: length };
}

// A media file's bytes on their way to a network's upload URL, with a
// known length so the receiving side gets Content-Length, not chunks.
async function source(url, range) {
  const res = await fetch(url, range ? { headers: { Range: range } } : {});
  if (!res.ok) throw new Error(`Couldn't read the media back from the site (${res.status}).`);
  const len = Number(res.headers.get("content-length") || 0);
  if (len && typeof FixedLengthStream === "function") {
    const { readable, writable } = new FixedLengthStream(len);
    res.body.pipeTo(writable);
    return { body: readable, len };
  }
  const buf = await res.arrayBuffer();
  return { body: buf, len: buf.byteLength };
}

// Captions.
export const LIMITS = { instagram: 2200, linkedin: 3000, tiktok: 4000 };
export const captionFor = (post, net) => String((post.captions && post.captions[net]) || post.caption || "").slice(0, LIMITS[net]);

// LinkedIn reads commentary as its "little text" format: these characters
// must be escaped or the post is cut short. Hashtags become its hashtag tag.
export function liText(s) {
  const esc = (t) => t.replace(/[\\|{}@[\]()<>#*_~]/g, (c) => "\\" + c);
  return String(s).replace(/#([\p{L}\p{N}_]+)|[^#]+|#/gu, (m, tag) => (tag ? `{hashtag|\\#|${esc(tag)}}` : esc(m)));
}

// What each network accepts, said before anything is sent.
export function check(post) {
  const problems = [];
  const media = post.media || [];
  const videos = media.filter((m) => m.type === "video").length;
  for (const net of post.networks || []) {
    if (net === "instagram") {
      if (!media.length) problems.push("Instagram needs an image or a video.");
      if (media.length > 10) problems.push("Instagram takes up to 10 images or videos in one post.");
      if (media.some((m) => m.mime === "image/png")) problems.push("Instagram only takes JPEG images.");
    }
    if (net === "linkedin") {
      if (videos && media.length > 1) problems.push("LinkedIn takes one video on its own, or up to 20 images.");
      if (media.length > 20) problems.push("LinkedIn takes up to 20 images.");
      if (!media.length && !captionFor(post, net).trim()) problems.push("Write something for LinkedIn.");
    }
    if (net === "tiktok") {
      if (!media.length) problems.push("TikTok needs a video or photos.");
      if (videos && media.length > 1) problems.push("TikTok takes one video, or up to 35 photos.");
      if (!videos && media.length > 35) problems.push("TikTok takes up to 35 photos.");
      if (media.some((m) => m.mime === "image/png")) problems.push("TikTok photos must be JPEG.");
    }
  }
  return problems;
}

// Instagram: containers, then publish once they're ready.
async function instagram(env, post, r) {
  const { acc, access } = await token(env, "instagram");
  const user = acc.user_id;
  const make = (params) => call("instagram", `${IG}/${user}/media`, { method: "POST", form: { ...params, access_token: access } });
  const status = (id) => call("instagram", `${IG}/${id}?` + new URLSearchParams({ fields: "status_code,status", access_token: access }));
  const media = post.media || [];
  const caption = captionFor(post, "instagram");
  if (r.state === "queued") {
    if (media.length === 1) {
      const m = media[0];
      r = { ...r, container: (await make(m.type === "video" ? { media_type: "REELS", video_url: m.url, caption, share_to_feed: "true" } : { image_url: m.url, caption })).id };
    } else {
      const kids = [];
      for (const m of media) kids.push((await make({ is_carousel_item: "true", ...(m.type === "video" ? { media_type: "VIDEO", video_url: m.url } : { image_url: m.url }) })).id);
      r = { ...r, kids };
    }
    r.state = "processing";
  }
  const failed = (s) => ["ERROR", "EXPIRED"].includes(s.status_code);
  if (!r.container) {
    // A carousel's own container can only be made once every item is ready.
    for (const k of r.kids) {
      const s = await status(k);
      if (failed(s)) throw new Error(`Instagram couldn't process one of the items: ${s.status || s.status_code}`);
      if (s.status_code !== "FINISHED") return r;
    }
    r = { ...r, container: (await make({ media_type: "CAROUSEL", children: r.kids.join(","), caption })).id };
  }
  const s = await status(r.container);
  if (failed(s)) throw new Error(`Instagram couldn't process the media: ${s.status || s.status_code}`);
  if (s.status_code !== "FINISHED") return r;
  const pub = await call("instagram", `${IG}/${user}/media_publish`, { method: "POST", form: { creation_id: r.container, access_token: access } });
  const info = await call("instagram", `${IG}/${pub.id}?` + new URLSearchParams({ fields: "permalink", access_token: access })).catch(() => ({}));
  return { ...r, state: "posted", id: pub.id, url: info.permalink || "", at: S.now() };
}

// LinkedIn: media uploaded first, then one post that points at it.
async function linkedin(env, post, r) {
  const { acc, access } = await token(env, "linkedin");
  const author = `urn:li:person:${acc.user_id}`;
  const h = { Authorization: `Bearer ${access}`, "LinkedIn-Version": LI_VERSION, "X-Restli-Protocol-Version": "2.0.0" };
  const ids = [];
  for (const m of post.media || []) {
    if (m.type === "image") {
      const init = await call("linkedin", `${LI}/images?action=initializeUpload`, { method: "POST", headers: h, json: { initializeUploadRequest: { owner: author } } });
      const src = await source(m.url);
      const res = await fetch(init.value.uploadUrl, { method: "PUT", headers: { Authorization: `Bearer ${access}` }, body: src.body });
      if (!res.ok) throw new Error(`LinkedIn refused the image upload (${res.status}).`);
      ids.push(init.value.image);
    } else {
      const init = await call("linkedin", `${LI}/videos?action=initializeUpload`, { method: "POST", headers: h,
        json: { initializeUploadRequest: { owner: author, fileSizeBytes: m.bytes, uploadCaptions: false, uploadThumbnail: false } } });
      const parts = [];
      for (const u of init.value.uploadInstructions) {
        const src = await source(m.url, `bytes=${u.firstByte}-${u.lastByte}`);
        const res = await fetch(u.uploadUrl, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: src.body });
        if (!res.ok) throw new Error(`LinkedIn refused part of the video (${res.status}).`);
        parts.push(res.headers.get("etag"));
      }
      await call("linkedin", `${LI}/videos?action=finalizeUpload`, { method: "POST", headers: h,
        json: { finalizeUploadRequest: { video: init.value.video, uploadToken: init.value.uploadToken || "", uploadedPartIds: parts } } });
      ids.push(init.value.video);
    }
  }
  const content = !ids.length ? undefined : ids.length === 1 ? { media: { id: ids[0] } } : { multiImage: { images: ids.map((id) => ({ id })) } };
  const res = await call("linkedin", `${LI}/posts`, { method: "POST", headers: h, json: {
    author, commentary: liText(captionFor(post, "linkedin")), visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false, ...(content ? { content } : {}) } });
  const urn = res._headers.get("x-restli-id") || res.id || "";
  return { ...r, state: "posted", id: urn, url: urn ? `https://www.linkedin.com/feed/update/${urn}/` : "", at: S.now() };
}

// TikTok: sent to the account's inbox (drafts). The owner finishes the post
// in the TikTok app, which is what an app TikTok hasn't audited may do.
async function tiktok(env, post, r) {
  const { access } = await token(env, "tiktok");
  const h = { Authorization: `Bearer ${access}` };
  const media = post.media || [];
  if (r.state === "queued") {
    let init;
    if (media[0].type === "video") {
      const m = media[0];
      init = await call("tiktok", `${TT}/post/publish/inbox/video/init/`, { method: "POST", headers: h,
        json: { source_info: { source: "FILE_UPLOAD", video_size: m.bytes, chunk_size: m.bytes, total_chunk_count: 1 } } });
      const src = await source(m.url);
      const res = await fetch(init.data.upload_url, { method: "PUT", headers: { "Content-Type": m.mime || "video/mp4", "Content-Range": `bytes 0-${src.len - 1}/${src.len}` }, body: src.body });
      if (!res.ok) throw new Error(`TikTok refused the video upload (${res.status}).`);
    } else {
      // Photos are fetched by TikTok from the site, so oceanofjobs.com must be verified in the TikTok app's settings.
      const text = captionFor(post, "tiktok");
      init = await call("tiktok", `${TT}/post/publish/content/init/`, { method: "POST", headers: h, json: {
        post_info: { title: text.split("\n")[0].slice(0, 90), description: text },
        source_info: { source: "PULL_FROM_URL", photo_cover_index: 0, photo_images: media.map((m) => m.url) },
        post_mode: "MEDIA_UPLOAD", media_type: "PHOTO" } });
    }
    r = { ...r, state: "processing", publish_id: init.data.publish_id };
  }
  const st = await call("tiktok", `${TT}/post/publish/status/fetch/`, { method: "POST", headers: h, json: { publish_id: r.publish_id } });
  const s = (st.data && st.data.status) || "";
  if (s === "FAILED") throw new Error(`TikTok couldn't take it: ${(st.data && st.data.fail_reason) || "no reason given"}`);
  if (s === "SEND_TO_USER_INBOX") return { ...r, state: "inbox", at: S.now() };
  if (s === "PUBLISH_COMPLETE") return { ...r, state: "posted", at: S.now() };
  return r;
}

const RUN = { instagram, linkedin, tiktok };
const OPEN = ["queued", "processing"];
export const DONE = ["posted", "inbox"];

function overall(post) {
  const rs = (post.networks || []).map((n) => (post.results || {})[n] || { state: "queued" });
  if (rs.some((r) => OPEN.includes(r.state))) return "publishing";
  if (rs.every((r) => DONE.includes(r.state))) return "done";
  if (rs.every((r) => r.state === "failed")) return "failed";
  return "partial";
}

// Moves each open network of a post one step on, or only `only`'s.
// Roughly what a step costs in subrequests, so a run stays under 50.
export const cost = (post, net) => 4 + (net === "instagram" || net === "linkedin" ? 2 * (post.media || []).length : 2);
export async function advance(env, post, { only, budget = 40 } = {}) {
  const results = { ...(post.results || {}) };
  let spent = 0;
  for (const net of post.networks || []) {
    const r = results[net] || { state: "queued" };
    if ((only && net !== only) || !OPEN.includes(r.state)) continue;
    const c = r.state === "queued" ? cost(post, net) : 4;
    if (spent && spent + c > budget) break;
    spent += c;
    try {
      results[net] = await RUN[net](env, post, r);
    } catch (e) {
      results[net] = { ...r, state: "failed", error: String(e.message || e).slice(0, 400), at: S.now() };
    }
  }
  const next = { ...post, results, updated: S.now() };
  next.status = overall(next);
  if (next.status !== "publishing" && !next.published_at) next.published_at = S.now();
  await S.put(env, next);
  return { post: next, spent };
}

// Saving a post from the page. Drafts and scheduled posts can change;
// once publishing starts they can't, only be retried.
export async function save(env, b, who) {
  const old = b.sk ? await S.get(env, "social_post", String(b.sk)) : null;
  if (b.sk && !old) throw bad("That post is gone.", 404);
  if (old && !["draft", "scheduled"].includes(old.status)) throw bad("This post was already sent. Duplicate it to change it.", 409);
  const networks = [...new Set((b.networks || []).map(String))].filter((n) => NETWORKS.includes(n));
  const media = (Array.isArray(b.media) ? b.media : []).slice(0, 35).map((m) => ({
    url: String(m.url || ""), type: m.type === "video" ? "video" : "image", mime: String(m.mime || (m.type === "video" ? "video/mp4" : "image/jpeg")),
    bytes: Number(m.bytes) || 0, w: Number(m.w) || 0, h: Number(m.h) || 0 }))
    .filter((m) => m.url.startsWith("https://oceanofjobs.com/mail/social/"));
  const captions = Object.fromEntries(NETWORKS.filter((n) => b.captions && typeof b.captions[n] === "string" && b.captions[n].trim())
    .map((n) => [n, b.captions[n].slice(0, LIMITS[n])]));
  const mode = ["draft", "schedule", "now"].includes(b.mode) ? b.mode : "draft";
  const at = mode === "schedule" ? String(b.at || "") : "";
  if (mode === "schedule" && !(Date.parse(at) > Date.now() - 60e3)) throw bad("Pick a time in the future.");
  const post = { pk: "social_post", sk: old ? old.sk : S.now() + "#" + S.id(), caption: String(b.caption || "").slice(0, 4000), captions, media, networks,
    title: String(b.title || "").slice(0, 120), at: mode === "schedule" ? new Date(at).toISOString() : "", created: old ? old.created : S.now(), updated: S.now(), by: who,
    status: mode === "draft" ? "draft" : mode === "schedule" ? "scheduled" : "publishing", results: {} };
  if (mode !== "draft") {
    if (!networks.length) throw bad("Pick at least one network.");
    const problems = check(post);
    if (problems.length) throw bad(problems.join(" "));
    const acc = await accounts(env);
    const missing = networks.filter((n) => !acc.find((a) => a.network === n).connected);
    if (missing.length) throw bad(`Connect ${missing.map((n) => NAME[n]).join(" and ")} first.`, 409);
    if (mode === "now") post.results = Object.fromEntries(networks.map((n) => [n, { state: "queued" }]));
  }
  await S.put(env, post);
  await S.audit(env, who, "social " + mode, { post: post.sk, networks });
  return post;
}

export async function retry(env, sk, net, who) {
  const post = await S.get(env, "social_post", sk);
  if (!post) throw bad("That post is gone.", 404);
  const results = { ...(post.results || {}) };
  for (const n of post.networks) if ((!net || n === net) && results[n] && results[n].state === "failed") results[n] = { state: "queued" };
  const next = { ...post, results, status: "publishing", published_at: "" };
  await S.put(env, next);
  await S.audit(env, who, "social retry", { post: sk, network: net || "all" });
  return next;
}

// The social cron: scheduled posts that are due, open steps of posts being
// sent, and once a day each account's follower count.
export async function run(env, { now = Date.now(), log = console.log } = {}) {
  const posts = await S.list(env, "social_post", { limit: 300 }); // shortcut: reads the newest 300; page it if posts pile up
  let budget = 40;
  const iso = new Date(now).toISOString();
  for (const p of posts.reverse()) {
    if (budget < 6) break;
    let post = p;
    if (post.status === "scheduled" && post.at && post.at <= iso) {
      post = { ...post, status: "publishing", results: Object.fromEntries(post.networks.map((n) => [n, { state: "queued" }])) };
    } else if (post.status !== "publishing") continue;
    try {
      const { spent } = await advance(env, post, { budget });
      budget -= Math.max(spent, 1) + 2;
    } catch (e) { log("social post failed", post.sk, e && e.message); budget -= 4; }
  }
  if (budget >= 8) await followers(env, iso.slice(0, 10)).catch((e) => log("social followers failed", e && e.message));
}

async function followers(env, day) {
  if (await S.get(env, "social_followers", day)) return;
  const row = { pk: "social_followers", sk: day };
  for (const a of await S.list(env, "social", { limit: 10 })) {
    if (a.sk === "linkedin") continue; // LinkedIn doesn't give a member's followers to apps like this one
    try {
      const { access } = await token(env, a.sk);
      const me = await profile(a.sk, access);
      if (me.followers !== null) {
        row[a.sk] = me.followers;
        await S.put(env, { ...(await S.get(env, "social", a.sk)), followers: me.followers, picture: me.picture || a.picture });
      }
    } catch { /* shown on the account as its error */ }
  }
  await S.put(env, row);
}

// Stats. Instagram per post and per account; TikTok per video (inbox
// uploads get an id only once posted in the app, so videos are listed as
// TikTok has them); LinkedIn gives none to an app without partner access.
export async function postStats(env, post) {
  const r = (post.results || {}).instagram;
  if (!r || r.state !== "posted" || !r.id) return {};
  const { access } = await token(env, "instagram");
  const base = await call("instagram", `${IG}/${r.id}?` + new URLSearchParams({ fields: "like_count,comments_count,permalink", access_token: access }));
  const out = { likes: base.like_count ?? null, comments: base.comments_count ?? null };
  try {
    const ins = await call("instagram", `${IG}/${r.id}/insights?` + new URLSearchParams({ metric: "reach,saved,shares,views", access_token: access }));
    for (const m of ins.data || []) out[m.name] = (m.values && m.values[0] && m.values[0].value) ?? m.total_value?.value ?? null;
  } catch (e) { out.error = e.message; }
  return { instagram: out };
}

export async function overview(env) {
  const acc = await accounts(env);
  const out = { accounts: acc, followers: (await S.list(env, "social_followers", { newest: true, limit: 90 })).reverse() };
  const on = (n) => acc.find((a) => a.network === n && a.connected);
  const tasks = [];
  if (on("instagram")) {
    tasks.push(token(env, "instagram")
      .then(({ acc: a, access }) => call("instagram", `${IG}/${a.user_id}/media?` + new URLSearchParams({
        fields: "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count", limit: "24", access_token: access })))
      .then((r) => { out.instagram = r.data || []; }, (e) => { out.instagram_error = e.message; }));
  }
  if (on("tiktok")) {
    tasks.push(token(env, "tiktok")
      .then(({ access }) => call("tiktok", `${TT}/video/list/?fields=id,title,video_description,cover_image_url,share_url,view_count,like_count,comment_count,share_count,create_time`,
        { method: "POST", headers: { Authorization: `Bearer ${access}` }, json: { max_count: 20 } }))
      .then((r) => { out.tiktok = (r.data && r.data.videos) || []; }, (e) => { out.tiktok_error = e.message; }));
  }
  await Promise.all(tasks);
  return out;
}

// Instagram comments on the latest posts, with replies, in one call.
export async function comments(env) {
  const { acc, access } = await token(env, "instagram");
  const r = await call("instagram", `${IG}/${acc.user_id}/media?` + new URLSearchParams({
    fields: "id,caption,permalink,timestamp,media_type,media_url,thumbnail_url,comments_count,comments.limit(25){id,text,username,timestamp,like_count,hidden,replies{id,text,username,timestamp}}",
    limit: "12", access_token: access }));
  return (r.data || []).map((m) => ({ id: m.id, caption: m.caption || "", permalink: m.permalink, timestamp: m.timestamp, thumb: m.thumbnail_url || m.media_url || "",
    count: m.comments_count || 0, comments: ((m.comments && m.comments.data) || []).map((c) => ({ ...c, replies: (c.replies && c.replies.data) || [] })) }));
}

export async function commentAction(env, b, who) {
  const id = String(b.id || "");
  if (!/^\d+$/.test(id)) throw bad("No such comment.");
  const { access } = await token(env, "instagram");
  if (b.op === "reply") {
    const message = String(b.message || "").trim().slice(0, 2200);
    if (!message) throw bad("Write a reply first.");
    const r = await call("instagram", `${IG}/${id}/replies`, { method: "POST", form: { message, access_token: access } });
    await S.audit(env, who, "social reply", { comment: id });
    return { id: r.id };
  }
  if (b.op === "hide" || b.op === "unhide") {
    await call("instagram", `${IG}/${id}`, { method: "POST", form: { hide: b.op === "hide" ? "true" : "false", access_token: access } });
    await S.audit(env, who, "social " + b.op, { comment: id });
    return { ok: true };
  }
  if (b.op === "delete") {
    await call("instagram", `${IG}/${id}?` + new URLSearchParams({ access_token: access }), { method: "DELETE" });
    await S.audit(env, who, "social delete comment", { comment: id });
    return { ok: true };
  }
  throw bad("Unknown change.");
}
