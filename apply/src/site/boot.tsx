// Mounts a page. A sign-in can land on any page (auth.js): Google's
// ?code=, GitHub's #id_token= or #auth_error=. The tokens have to be
// stored before the page decides whether the reader is signed in.
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Toasty } from "@cloudflare/kumo/components/toast";
import "./site.css";

export function boot(page: ReactNode) {
  const redirect = typeof handleAuthRedirect === "function" ? handleAuthRedirect().catch(() => {}) : Promise.resolve();
  redirect.finally(() => {
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <Toasty>{page}</Toasty>
      </StrictMode>,
    );
  });
}
