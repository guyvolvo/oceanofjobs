// Brings a prerendered page to life. The HTML already holds the page
// (scripts/prerender.mjs wrote it at build time); hydrateRoot attaches
// React to it instead of drawing it again.
import { StrictMode, type ReactNode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { requestSignIn } from "../site/auth";
import { notifyAuth } from "./state";
import "@/styles/app.css";

declare global {
  interface Window { openSignIn?: () => void }
}

export function hydrate(page: ReactNode) {
  // auth.js reopens the sign-in window by this name after a failed Google
  // or GitHub sign-in (#auth_error), as the old pages' dialog did.
  window.openSignIn = requestSignIn;
  const root = document.getElementById("root")!;
  const app = <StrictMode>{page}</StrictMode>;
  // `npm run dev` serves the entries without the prerender step.
  if (root.firstChild) hydrateRoot(root, app);
  else createRoot(root).render(app);
  // A sign-in can land on any page (?code=, #id_token=, #auth_error=).
  if (typeof handleAuthRedirect === "function") handleAuthRedirect().catch(() => {}).finally(notifyAuth);
}
