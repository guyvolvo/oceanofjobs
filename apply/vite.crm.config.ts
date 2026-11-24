import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The CRM (src/crm), built apart from /apply: it is served by the
// crm.oceanofjobs.com Worker behind Cloudflare Access, never from the
// site's bucket. scripts/deploy_crm.py packs crm/dist into the Worker.
//   npx vite build --config vite.crm.config.ts
export default defineConfig({
  base: "/",
  // /apply has no public files this host needs.
  publicDir: false,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": resolve(__dirname, "src") } },
  // crm.css takes its fonts from ../frontend/fonts; the dev server refuses files outside apply/ otherwise.
  server: { fs: { allow: [".."] } },
  build: {
    outDir: "../crm/dist",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    rollupOptions: { input: { index: "crm.html" } },
  },
});
