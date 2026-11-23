// A local stand-in for oceanofjobs.com, to check a production build before
// anything is deployed. It serves the bucket as deploy-frontend.yml would
// lay it out after the switch, and routes each request the way CloudFront
// does (infra/cloudfront.tf, legacy_domain_redirect + not_found_status).
//
//   bucket /              frontend/ (this branch)
//   bucket /<page>.html   apply/dist/<page>.html for the pages in
//                         apply/migrated.json (the deploy copies them over
//                         frontend/<page>.html, home over index.html)
//   bucket /apply/        apply/dist/
//   the box, the Worker, and files the box publishes into the bucket
//   (/api, /job, /company, /logo, /descriptions, /mcp, /docs, sitemaps,
//   /companies/<letter>, /jobs pages, *.json snapshots)
//                         proxied to the live site, GET and HEAD only.
//
// Writes never leave this machine: any other method gets a 405 here.
//
// usage: node scripts/preview.mjs [--port 4173] [--all] [--migrate board] [--prod-account] [--gzip] [--selftest]
//   --all           also serve every built page not shipped yet (READY)
//   --migrate a,b   also serve these built pages
//   --prod-account  route /account/<section> to 404, as production did before
//                   the /account/* rule in infra/cloudfront.tf was applied
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { extname, join, resolve } from "node:path";
import assert from "node:assert/strict";

const LIVE = "https://oceanofjobs.com";
const APPLY = resolve(import.meta.dirname, "..");
const DIST = join(APPLY, "dist");
const FRONTEND = resolve(APPLY, "../frontend");
// The pages whose HTML the deploy takes from apply/dist: the same file
// deploy-frontend.yml reads (docs/UI_OVERHAUL_ROLLBACK.md).
export const MIGRATED = JSON.parse(readFileSync(join(APPLY, "migrated.json"), "utf8"));
// Built and reviewed but not shipped yet; --all serves them too.
const READY = ["privacy", "terms", "refunds", "contact", "404", "home", "pricing", "checkout", "companies", "stats", "board"];

// The CloudFront function's PAGES, BOARD_KEYS and role-page list, verbatim.
const PAGES = { "/stats": true, "/privacy": true, "/board": true, "/contact": true, "/companies": true, "/pricing": true, "/terms": true, "/refunds": true, "/checkout": true };
const BOARD_KEYS = new Set(["search", "q", "keywords", "department", "seniority", "company", "country", "city", "workplace", "skills", "confidence",
  "max_age_days", "starred", "sort", "dir", "offset", "job", "view", "israel_only", "code"]);
const ROLE_PAGES = /^\/jobs(\/(software-engineer|ai-engineer|machine-learning-engineer|data-engineer|data-scientist|data-analyst|devops-engineer|cybersecurity|product-manager|full-stack-developer)(\/(remote|united-states|united-kingdom|germany|india|canada|israel))?)?$/;

// Port of legacy_domain_redirect's handler (minus the legacy-host 301).
// Returns { redirect } or { uri } (the bucket key) or { pass: true } for the
// behaviours that go to the box.
export function route(uri, search = "", { accountPrefix = true } = {}) {
  if (uri.startsWith("/api/") || uri === "/api" || uri.startsWith("/job/") || uri.startsWith("/company/")) return { pass: true };
  // Behaviours ahead of the default one in cloudfront.tf.
  if (uri.startsWith("/logo/") || uri.startsWith("/descriptions/") || uri.startsWith("/mcp")) return { pass: true };
  if (uri === "/hero" || uri === "/hero.html") return { redirect: "/" + search };
  if (uri === "/" && [...new URLSearchParams(search).keys()].some((k) => BOARD_KEYS.has(k))) return { redirect: "/board" + search };
  const last = uri.slice(uri.lastIndexOf("/") + 1);
  if (last === "index.html") return { uri };
  if (last.length > 5 && last.endsWith(".html")) return { redirect: uri.slice(0, -5) + search };
  if (uri.length > 1 && last === "") return { redirect: uri.slice(0, -1) + search };
  if (uri === "/docs") return { uri: "/docs/index.html" };
  if (uri.startsWith("/docs/") && !last.includes(".")) return { uri: uri + ".html" };
  if (uri === "/apply" || (uri.startsWith("/apply/") && !last.includes("."))) return { uri: "/apply/index.html" };
  if (uri === "/account" || (accountPrefix && uri.startsWith("/account/") && !last.includes("."))) return { uri: "/apply/account.html" };
  if (uri.startsWith("/companies/") && !last.includes(".")) return { uri: uri + ".html" };
  if (ROLE_PAGES.test(uri)) return { uri: uri + ".html" };
  if (uri !== "/" && !last.includes(".")) return { uri: PAGES[uri] ? uri + ".html" : "/404.html" };
  return { uri: uri === "/" ? "/index.html" : uri };
}

// Bucket keys the box publishes rather than this repo (deploy-frontend.yml's --exclude list).
const PUBLISHED = /^\/(docs\/|companies\/|jobs(\/|\.html)|explore|media\/|mail\/|sitemap|feed\.xml|(bootstrap|bootstrap-il|stats|facets|hot)\.json)/;

function bucketFile(key) {
  if (key.startsWith("/apply/")) return join(DIST, key.slice(7));
  // Once home is migrated, the bucket's index.html is the build's home.html (the deploy copies it to frontend/index.html).
  const page = key === "/index.html" ? "home" : key.slice(1, -5);
  if (key.endsWith(".html") && MIGRATED.includes(page)) return join(DIST, `${page}.html`);
  return join(FRONTEND, key);
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".wasm": "application/wasm" };

// --gzip: compress text the way CloudFront does, so load timings under a
// throttled network compare with the live site's.
function gzipped(req, res, status, headers, body) {
  if (!/gzip/.test(req.headers["accept-encoding"] || "") || !/text|javascript|json|xml|svg/.test(headers["content-type"] || "")) {
    res.writeHead(status, headers);
    return res.end(body);
  }
  const { "content-length": _, ...rest } = headers;
  res.writeHead(status, { ...rest, "content-encoding": "gzip", vary: "accept-encoding" });
  res.end(gzipSync(body));
}

async function proxy(req, res, path, opts) {
  // Range passes through both ways: /stats reads its database (/explore*) by HTTP range request.
  const r = await fetch(LIVE + path, { method: req.method, redirect: "manual", headers: { "user-agent": "ooj-local-preview (GET only)", accept: req.headers.accept || "*/*",
    ...(req.headers.range ? { range: req.headers.range } : {}), "accept-encoding": "identity" } });
  const headers = {};
  for (const h of ["content-type", "cache-control", "location", "content-length", "content-range", "accept-ranges"]) if (r.headers.get(h)) headers[h] = r.headers.get(h);
  const body = req.method === "HEAD" ? undefined : Buffer.from(await r.arrayBuffer());
  if (opts.gzip && body && !headers["content-range"]) return gzipped(req, res, r.status, headers, body);
  res.writeHead(r.status, headers);
  res.end(body);
}

function serve(opts) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://local");
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { "content-type": "text/plain" });
        return res.end("Local preview: writes are not sent to the live site.\n");
      }
      const r = route(url.pathname, url.search, opts);
      if (r.redirect) { res.writeHead(301, { location: r.redirect }); return res.end(); }
      if (r.pass || PUBLISHED.test(r.uri)) return await proxy(req, res, url.pathname + url.search, opts);
      const file = bucketFile(r.uri);
      if (!existsSync(file) || !statSync(file).isFile()) {
        // A private bucket answers a missing key with AccessDenied.
        res.writeHead(403, { "content-type": "application/xml" });
        return res.end("<Error><Code>AccessDenied</Code></Error>");
      }
      // not_found_status: the 404 page carries a real 404.
      const head = { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-cache" };
      if (opts.gzip && req.method === "GET") return gzipped(req, res, r.uri === "/404.html" ? 404 : 200, head, readFileSync(file));
      res.writeHead(r.uri === "/404.html" ? 404 : 200, head);
      if (req.method === "HEAD") return res.end();
      createReadStream(file).pipe(res);
    } catch (e) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`Local preview: ${e.message}\n`);
    }
  });
}

function selftest() {
  const t = (uri, search, want, opts) => assert.deepEqual(route(uri, search, opts), want, `${uri}${search}`);
  t("/", "", { uri: "/index.html" });
  t("/", "?country=IL", { redirect: "/board?country=IL" });
  t("/", "?utm_source=x", { uri: "/index.html" });
  t("/privacy", "", { uri: "/privacy.html" });
  t("/privacy.html", "?a=1", { redirect: "/privacy?a=1" });
  t("/privacy/", "", { redirect: "/privacy" });
  t("/nope", "", { uri: "/404.html" });
  t("/jobs/some-old-role", "", { uri: "/404.html" });
  t("/jobs/data-engineer/remote", "", { uri: "/jobs/data-engineer/remote.html" });
  t("/companies/a", "", { uri: "/companies/a.html" });
  t("/apply/queue", "", { uri: "/apply/index.html" });
  t("/apply/assets/x-1.js", "", { uri: "/apply/assets/x-1.js" });
  t("/account", "", { uri: "/apply/account.html" });
  t("/account/alerts", "", { uri: "/apply/account.html" });
  t("/account/alerts", "", { uri: "/404.html" }, { accountPrefix: false });
  t("/docs", "", { uri: "/docs/index.html" });
  t("/docs/mcp", "", { uri: "/docs/mcp.html" });
  t("/job/123", "", { pass: true });
  t("/api/jobs", "?q=1", { pass: true });
  t("/style.css", "", { uri: "/style.css" });
  t("/hero", "", { redirect: "/" });
  assert.equal(bucketFile("/contact.html"), join(DIST, "contact.html"));
  // A page in migrated.json comes from the build, any other from frontend/.
  assert.equal(bucketFile("/board.html"), join(MIGRATED.includes("board") ? DIST : FRONTEND, "board.html"));
  assert.equal(bucketFile("/docs/index.html"), join(FRONTEND, "docs/index.html"));
  assert.ok(PUBLISHED.test("/companies/a.html") && PUBLISHED.test("/stats.json") && !PUBLISHED.test("/stats.js"));
  console.log("preview routing: all checks pass");
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  const args = process.argv.slice(2);
  if (args.includes("--selftest")) { selftest(); process.exit(0); }
  if (!existsSync(join(DIST, "privacy.html"))) { console.error("No build in apply/dist: run npm run build first."); process.exit(1); }
  const port = Number(args[args.indexOf("--port") + 1]) || 4173;
  if (args.includes("--all")) MIGRATED.push(...READY.filter((p) => !MIGRATED.includes(p)));
  if (args.includes("--migrate")) MIGRATED.push(...args[args.indexOf("--migrate") + 1].split(","));
  serve({ accountPrefix: !args.includes("--prod-account"), gzip: args.includes("--gzip") }).listen(port, "127.0.0.1", () =>
    console.log(`Local preview of oceanofjobs.com on http://127.0.0.1:${port} (new pages: ${MIGRATED.join(", ")}; GET-only proxy to ${LIVE})`));
}
