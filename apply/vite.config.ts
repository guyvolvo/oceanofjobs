import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The whole site is this one Vite + React build: every page is an entry
// here. Served from the site's bucket under apply/, so every asset URL
// starts with /apply/. The deploy copies each page's HTML to where the
// static page was (frontend/<page>.html), so every address and its
// CloudFront rule stay as they are; index.html and account.html are the
// workspace (src/workspace), which routes /apply/* and /account/* on the
// client.
const PAGES: Record<string, string> = {
  "/": "home.html",
  "/board": "board.html",
  "/companies": "companies.html",
  "/stats": "stats.html",
  "/pricing": "pricing.html",
  "/checkout": "checkout.html",
  "/privacy": "privacy.html",
  "/terms": "terms.html",
  "/refunds": "refunds.html",
  "/contact": "contact.html",
};
const FRONTEND = resolve(__dirname, "../frontend");
const MIME: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".ico": "image/x-icon", ".json": "application/json", ".txt": "text/plain", ".webp": "image/webp", ".wasm": "application/wasm" };

// The head every page shares: the theme before first paint, the site's
// classic scripts (consent, the counter, sign-in, the outage badge). Pages write <!-- site-head -->.
const HEAD = `<meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#17181c" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg?v=3" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png?v=3" />
  <link rel="apple-touch-icon" sizes="180x180" href="/favicon-180.png?v=3" />
  <link rel="preload" href="/fonts/Geist-400-latin.woff2" as="font" type="font/woff2" crossorigin />
  <script>
    (function () {
      var light = false;
      try { light = localStorage.getItem("iljobs_theme") === "light"; } catch (e) {}
      document.documentElement.setAttribute("data-mode", light ? "light" : "dark");
      if (!light) document.documentElement.setAttribute("data-theme", "dark");
      document.querySelector('meta[name="theme-color"]').content = light ? "#f2f0ef" : "#17181c";
      // Signed in: the prerendered pages keep "Log in" hidden until React swaps in the account menu.
      try { if ((JSON.parse(localStorage.getItem("iljobs_auth_tokens") || "null") || {}).id_token) document.documentElement.setAttribute("data-auth", ""); } catch (e) {}
    })();
  </script>
  <script src="/consent.js"></script>
  <script src="/count.js"></script>
  <script src="/auth.js"></script>
  <script src="/upstream.js" defer></script>`;

// In development the dev server answers the site's own addresses (/board,
// /apply/queue, /style.css, /fonts/...) and proxies the API and the
// box-published files to the live site, so every page runs on real data.
function site(): Plugin {
  return {
    name: "ooj-site",
    transformIndexHtml: (html) => html.replace("<!-- site-head -->", HEAD),
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url || "/", "http://x");
        const p = url.pathname;
        const last = p.slice(p.lastIndexOf("/") + 1);
        const go = (file: string) => { req.url = `/apply/${file}${url.search}`; next(); };
        if (p in PAGES) return go(PAGES[p]);
        // Vite's own URLs (/apply/@vite/client, /apply/src/...) pass through.
        const vite = /^\/apply\/(@|src\/|node_modules\/)/.test(p);
        if (p === "/apply" || (p.startsWith("/apply/") && !last.includes(".") && !vite)) return go("index.html");
        if (p === "/account" || (p.startsWith("/account/") && !last.includes("."))) return go("account.html");
        // Vite prefixes the base to a page's own <script src="/cv_skills.js">.
        const file = join(FRONTEND, vite ? "" : p.replace(/^\/apply\//, "/"));
        if (!vite && last.includes(".") && existsSync(file) && statSync(file).isFile()) {
          res.setHeader("Content-Type", MIME[extname(p)] || "application/octet-stream");
          return createReadStream(file).pipe(res);
        }
        if (!vite && !last.includes(".") && !p.startsWith("/api") && !p.startsWith("/job/") && !p.startsWith("/company/") && !p.startsWith("/jobs")
            && !p.startsWith("/companies/") && !p.startsWith("/docs") && !p.startsWith("/mcp") && !p.startsWith("/explore") && !p.startsWith("/@")) {
          return go("404.html");
        }
        next();
      });
    },
  };
}

const LIVE = { target: "https://oceanofjobs.com", changeOrigin: true, secure: true };

export default defineConfig({
  base: "/apply/",
  plugins: [react(), tailwindcss(), site()],
  resolve: { alias: { "@": resolve(__dirname, "src") } },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: { input: Object.fromEntries(["index", "account", "home", "board", "companies", "stats", "pricing", "checkout", "privacy", "terms", "refunds", "contact", "404"].map((n) => [n, `${n}.html`])) },
  },
  server: {
    proxy: Object.fromEntries(["/api", "/job/", "/company/", "/jobs", "/companies/", "/docs", "/mcp", "/logo/", "/descriptions/", "/media/", "/explore",
      "/stats.json", "/bootstrap.json", "/bootstrap-il.json", "/facets.json", "/hot.json", "/feed.xml", "/sitemap"].map((p) => [p, LIVE])),
  },
});
