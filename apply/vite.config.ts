import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served from the site's bucket under apply/, so every asset URL starts
// with /apply/. infra/cloudfront.tf sends /apply and any extensionless
// /apply/... path to apply/index.html.
export default defineConfig({
  base: "/apply/",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
});
