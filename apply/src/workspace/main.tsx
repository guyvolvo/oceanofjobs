// The workspace: every page under /apply and /account, one document
// (apply/index.html and account.html mount this), routed by path. Each
// page renders its own <Workspace> with its title, actions and badges.
// Links from before (/apply#queue, /account#alerts, /account#aa-settings)
// are turned into their paths. A link to another workspace page draws that
// page here, with no new document: the page on screen stays until the next
// one's code is in, and every page's code loads once the first is up.
import { lazy, startTransition, Suspense, useEffect, useState, type ComponentType } from "react";
import { Spinner } from "@/components/ui/spinner";
import { boot } from "../site/boot";
import { hasUnsaved, useLeaveGuard } from "../unsaved";

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
  "/account/connect": page(() => import("../account/Connect")),
};

const HASHES: Record<string, string> = {
  "#queue": "/apply/queue", "#needs": "/apply/needs", "#history": "/apply/history", "#agent": "/apply/agent",
  "#aa-settings": "/apply/settings", "#autoapply": "/apply",
  "#alerts": "/account/alerts", "#saved": "/account/saved", "#skills": "/account/skills", "#preferences": "/account/preferences",
  "#billing": "/account/billing",
};

// The page an address shows, and the address to show for it.
function resolve(u: { pathname: string; search: string; hash: string }) {
  let p = u.pathname.replace(/\/$/, "") || "/apply";
  // #settings and #overview mean the page they were sent with: emails link /account#settings.
  const base = p.startsWith("/account") ? "/account" : "/apply";
  const to = { ...HASHES, "#settings": `${base}/settings`, "#overview": base }[u.hash];
  if (to) p = to;
  return { path: ROUTES[p] ? p : base, url: to ? p + u.search : u.pathname + u.search + u.hash };
}

const PAGES = Object.fromEntries(Object.entries(ROUTES).map(([p, r]) => [p, lazy(r.load)]));
const here = () => location.pathname + location.search + location.hash;
const first = resolve(location);
if (first.url !== here()) history.replaceState(null, "", first.url);
ROUTES[first.path].load().then(() => {
  const all = () => Object.values(ROUTES).forEach((r) => r.load().catch(() => {}));
  if ("requestIdleCallback" in window) requestIdleCallback(all); else setTimeout(all, 1000);
}, () => {});

function App() {
  const [at, setAt] = useState({ path: first.path, n: 0, y: 0 });
  const { guard, dialog } = useLeaveGuard();

  useEffect(() => {
    let shown = location.pathname + location.search;
    let letBack = false;
    const go = (url: string, path: string, push: boolean, y = 0) => ROUTES[path].load().then(() => {
      if (push) {
        history.replaceState({ y: scrollY }, "");
        if (url !== here()) history.pushState(null, "", url);
      }
      shown = location.pathname + location.search;
      startTransition(() => setAt((a) => ({ path, n: a.n + 1, y })));
    }, () => location.assign(url));

    const click = (e: MouseEvent) => {
      const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!(a instanceof HTMLAnchorElement) || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if ((a.target && a.target !== "_self") || a.hasAttribute("download") || a.origin !== location.origin || a.getAttribute("href")!.startsWith("#")) return;
      if (!ROUTES[a.pathname.replace(/\/$/, "")]) return;
      e.preventDefault();
      const to = resolve(a);
      guard(() => go(to.url, to.path, true));
    };
    const pop = (e: PopStateEvent) => {
      // A move within the page (the skip link's #main) is the browser's own.
      if (location.pathname + location.search === shown) return;
      if (hasUnsaved() && !letBack) {
        // The page with the edits stays at its address, and the dialog asks first.
        history.pushState({ y: scrollY }, "", shown);
        guard(() => { letBack = true; history.back(); });
        return;
      }
      letBack = false;
      go(location.href, resolve(location).path, false, e.state?.y || 0);
    };
    document.addEventListener("click", click);
    addEventListener("popstate", pop);
    return () => { document.removeEventListener("click", click); removeEventListener("popstate", pop); };
  }, []);

  useEffect(() => {
    if (!at.n) return;
    document.title = at.path.startsWith("/account") ? "Account | Ocean of Jobs" : "Auto apply | Ocean of Jobs";
    scrollTo(0, at.y);
    // Focus starts at the new page's title, which a screen reader reads out.
    (document.querySelector<HTMLElement>("main h1[tabindex]") || document.getElementById("main"))?.focus({ preventScroll: true });
  }, [at.n]);

  const Current = PAGES[at.path];
  return (
    <>
      <Suspense fallback={<div className="flex items-center gap-2 p-6 text-muted-foreground"><Spinner /> Loading</div>}>
        <Current key={at.n} />
      </Suspense>
      {dialog}
    </>
  );
}

boot(<App />);
