import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served from the site's bucket under apply/, so every asset URL starts
// with /apply/. index.html and account.html are the same page (account
// settings and auto apply settings, src/account/main.tsx) with their own
// titles. infra/cloudfront.tf sends /apply and any extensionless /apply/...
// path to apply/index.html, and /account to apply/account.html.
export default defineConfig({
  base: "/apply/",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: { input: { index: "index.html", account: "account.html" } },
  },
});
