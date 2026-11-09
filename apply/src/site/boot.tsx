// Mounts a page that renders in the browser only (the workspace under
// /apply and /account). A sign-in can land on any page (auth.js): Google's
// ?code=, GitHub's #id_token= or #auth_error=. The tokens have to be
// stored before the page decides whether the reader is signed in.
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "@/components/ui/sonner";
import { requestSignIn } from "./auth";
import "@/styles/app.css";
import "./site.css";

declare global {
  interface Window { openSignIn?: () => void }
}

export function boot(page: ReactNode) {
  // auth.js reopens the sign-in window by this name after a failed Google
  // or GitHub sign-in (#auth_error), as src/shell/hydrate.tsx does.
  window.openSignIn = requestSignIn;
  const redirect = typeof handleAuthRedirect === "function" ? handleAuthRedirect().catch(() => {}) : Promise.resolve();
  redirect.finally(() => {
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        {page}
        <Toaster position="bottom-right" closeButton />
      </StrictMode>,
    );
  });
}
