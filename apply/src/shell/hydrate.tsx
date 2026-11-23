// Brings a prerendered page to life. The HTML already holds the page
// (scripts/prerender.mjs wrote it at build time). hydrate() attaches React
// to the whole page; hydrateIslands() only to the containers marked
// data-island (island.tsx), so the rest stays plain HTML.
import { StrictMode, type ComponentType, type ReactNode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { requestSignIn } from "../site/auth";
import { notifyAuth } from "./state";
import "./stale";
import "@/styles/app.css";

declare global {
  interface Window { openSignIn?: () => void }
}

function start() {
  // auth.js reopens the sign-in window by this name after a failed Google
  // or GitHub sign-in (#auth_error), as the old pages' dialog did.
  window.openSignIn = requestSignIn;
}

// A sign-in can land on any page (?code=, #id_token=, #auth_error=).
function finish() {
  if (typeof handleAuthRedirect === "function") handleAuthRedirect().catch(() => {}).finally(notifyAuth);
}

export function hydrate(page: ReactNode) {
  start();
  const root = document.getElementById("root")!;
  const app = <StrictMode>{page}</StrictMode>;
  // `npm run dev` serves the entries without the prerender step.
  if (root.firstChild) hydrateRoot(root, app);
  else createRoot(root).render(app);
  finish();
}

// `registry` names the components this page's islands use. `devPage` is the
// whole page for `npm run dev`, where nothing is prerendered; pass it as
// `import.meta.env.DEV ? () => ... : undefined` so the build drops it.
// The page's PAGES entry in prerender.tsx must be in ISLAND_PAGES.
export function hydrateIslands(registry: Record<string, ComponentType<object>>, devPage?: () => Promise<ReactNode>) {
  start();
  const root = document.getElementById("root")!;
  if (!root.firstChild && devPage) {
    devPage().then((page) => createRoot(root).render(<StrictMode>{page}</StrictMode>));
  } else {
    for (const el of document.querySelectorAll<HTMLElement>("[data-island]")) {
      const name = el.dataset.island!;
      const C = registry[name];
      if (!C) throw new Error(`no component for island "${name}"`);
      hydrateRoot(el, <StrictMode><C {...JSON.parse(el.dataset.props || "{}")} /></StrictMode>, { identifierPrefix: `${name}-` });
    }
  }
  finish();
}
