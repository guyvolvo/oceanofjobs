// The workspace: every page under /apply and /account, one document
// (apply/index.html and account.html mount this), routed by path. Each
// page renders its own <Workspace> with its title, actions and badges.
// Links from before (/apply#queue, /account#alerts, /account#aa-settings)
// are turned into their paths.
import { lazy, Suspense, type ComponentType } from "react";
import { Spinner } from "@/components/ui/spinner";
import { boot } from "../site/boot";

type Page = { load: () => Promise<{ default: ComponentType }> };
const page = (load: Page["load"]) => ({ load });

const ROUTES: Record<string, Page> = {
  "/apply": page(() => import("../apply/Overview")),
  "/apply/queue": page(() => import("../apply/Queue")),
  "/apply/needs": page(() => import("../apply/Attention")),
  "/apply/history": page(() => import("../apply/History")),
  "/apply/agent": page(() => import("../apply/Agent")),
  "/apply/settings": page(() => import("../apply/Settings")),
  "/account": page(() => import("../account/Overview")),
  "/account/alerts": page(() => import("../account/Alerts")),
  "/account/saved": page(() => import("../account/Saved")),
  "/account/skills": page(() => import("../account/Skills")),
  "/account/preferences": page(() => import("../account/Preferences")),
  "/account/billing": page(() => import("../account/Billing")),
  "/account/settings": page(() => import("../account/Settings")),
};

const HASHES: Record<string, string> = {
  "#queue": "/apply/queue", "#needs": "/apply/needs", "#history": "/apply/history", "#agent": "/apply/agent", "#settings": "/apply/settings",
  "#aa-settings": "/apply/settings", "#autoapply": "/apply",
  "#alerts": "/account/alerts", "#saved": "/account/saved", "#skills": "/account/skills", "#preferences": "/account/preferences",
  "#billing": "/account/billing", "#overview": "/account",
};

function route(): string {
  let p = location.pathname.replace(/\/$/, "") || "/apply";
  const h = location.hash;
  if (h && HASHES[h]) {
    p = HASHES[h];
    history.replaceState(null, "", p + location.search);
  }
  return ROUTES[p] ? p : p.startsWith("/account") ? "/account" : "/apply";
}

const Current = lazy(ROUTES[route()].load);
boot(
  <Suspense fallback={<div className="flex items-center gap-2 p-6 text-muted-foreground"><Spinner /> Loading</div>}>
    <Current />
  </Suspense>,
);
