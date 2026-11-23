// The job board, /board. The layout is the live board's (frontend/board.html):
// the site's bar, a sidebar, and a main column with the search, the filter
// pills, the list box and the pane. Up to 1100px the sidebar is a drawer
// and the pane a sheet; up to 800px it is the phone layout, with a bar of
// Filters, Sort and the count, a filters sheet and the tab bar.
//
// The server render (scripts/prerender.mjs) is the empty board: the bar,
// the sidebar, the headings, skeleton rows and every crawlable link. The
// state lives in store.ts and only starts in the browser (boot, below).
import { useEffect, useRef, useState } from "react";
import { Bell, Briefcase, Buildings, List as ListIcon, Star, UserCircle } from "@phosphor-icons/react";
import { Header } from "../shell/Header";
import { useWho } from "../shell/state";
import { signedIn } from "../api";
import { AlertButton, MobileBar, Pills, Popups, SearchRow, loadPopups, preloadLocation } from "./Filters";
import { List } from "./List";
import { Pane } from "./Pane";
import { SideBar } from "./Side";
import { F, U, arrowJob, boot, closeJobAndSync, onAuthChange, setView, useBoard } from "./store";
import { PANE_SHEET, useMedia } from "./util";
import "./board.css";

// The phone's bottom bar (frontend/tabbar.js): one tap to anywhere.
const TABS = [
  { key: "jobs", label: "Jobs", href: "/board", icon: Briefcase },
  { key: "companies", label: "Companies", href: "/companies", icon: Buildings },
  { key: "saved", label: "Saved", href: "/board?starred=1", icon: Star },
  { key: "alerts", label: "Alerts", href: "/account#alerts", icon: Bell },
  { key: "account", label: "Account", href: "/account", icon: UserCircle },
];
function TabBar() {
  const now = F.starred_only ? "saved" : "jobs";
  return (
    <nav aria-label="Tabs" className="fixed inset-x-0 bottom-0 z-40 flex h-[calc(64px+env(safe-area-inset-bottom))] border-t bg-card pb-[env(safe-area-inset-bottom)] min-[801px]:hidden">
      {TABS.map((t) => (
        <a key={t.key} href={t.href} aria-current={t.key === now ? "page" : undefined}
          onClick={(e) => {
            // Jobs and Saved are this page: switch the view in place.
            if (t.key !== "jobs" && t.key !== "saved") return;
            e.preventDefault();
            if (t.key !== now) setView(t.key === "saved" ? "saved" : F.roles);
          }}
          className="flex min-h-11 flex-1 flex-col items-center gap-[3px] pt-2 font-ui text-[11px] text-muted-foreground no-underline aria-[current=page]:font-bold aria-[current=page]:text-foreground">
          <t.icon size={21} weight={t.key === now ? "bold" : "regular"} aria-hidden="true" />{t.label}
        </a>
      ))}
    </nav>
  );
}

// The live board.html's footer: hidden on the board, which is one window
// tall, but its links stay in the page for crawlers.
function Footer() {
  return (
    <footer className="hidden">
      <span>© 2026 Guy Voloshin, <a href="mailto:guyvoloshin@oceanofjobs.com">guyvoloshin@oceanofjobs.com</a></span>
      <a href="/docs/api">API Reference</a>
      <a href="/privacy">Privacy</a>
      <a href="https://github.com/guyvolvo/oceanofjobs/blob/main/LICENSE" target="_blank" rel="noopener">PolyForm Noncommercial License</a>
    </footer>
  );
}

let lastAuth: boolean | null = null;

export function Board() {
  useBoard();
  const who = useWho();
  const drawer = useMedia(PANE_SHEET);
  const [side, setSide] = useState(false);
  const menu = useRef<HTMLButtonElement>(null);
  const closeSide = () => { if (!side) return false; setSide(false); menu.current?.focus({ preventScroll: true }); return true; };

  useEffect(() => {
    boot();
    lastAuth = signedIn();
  }, []);
  // What opens over the board loads once the first rows are up, while idle.
  const rowsUp = !U.skeleton;
  useEffect(() => {
    if (!rowsUp) return;
    const idle = window.requestIdleCallback || ((fn: () => void) => setTimeout(fn, 300));
    idle(() => { loadPopups(); preloadLocation(); });
  }, [rowsUp]);
  if (U.geoPrompt || U.sheetOpen) loadPopups();
  const P = Popups();
  // Signed in or out on this page (the sign-in window, another tab, a
  // token that expired): stars, queue and Best matches follow.
  useEffect(() => {
    const now = signedIn();
    if (lastAuth !== null && now !== lastAuth) onAuthChange();
    lastAuth = now;
  }, [who?.idToken]);
  useEffect(() => { if (!drawer) setSide(false); }, [drawer]);
  useEffect(() => { if (side) document.querySelector<HTMLElement>("#site-side button, #site-side a")?.focus({ preventScroll: true }); }, [side]);

  // Escape closes the drawer, then the open job; ArrowUp and ArrowDown step
  // through the jobs, except while a control has the keys (app.js:3693).
  const sideRef = useRef(closeSide);
  sideRef.current = closeSide;
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        if (sideRef.current()) return;
        if (U.selected !== null) closeJobAndSync();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const el = document.activeElement;
      if (el && el.closest("input, textarea, select, [contenteditable], [role=slider], [role=treegrid], [role=dialog], [data-radix-popper-content-wrapper]")) return;
      if (U.sheetOpen) return;
      if (arrowJob(e.key === "ArrowDown")) e.preventDefault();
    };
    document.addEventListener("keydown", on);
    return () => document.removeEventListener("keydown", on);
  }, []);

  return (
    <div className="board-page bg-background">
      <a className="fixed top-[-60px] left-4 z-[1000] rounded-lg bg-primary px-3 py-2 text-[13px] font-semibold text-primary-foreground focus-visible:top-3" href="#main">Skip to content</a>
      <Header current="jobs" className="static flex-none border-b-0 bg-transparent backdrop-blur-none min-[801px]:[&_header]:h-[74px]" />
      <div className="min-h-0 flex-1 min-[1101px]:grid min-[1101px]:grid-cols-[236px_minmax(0,1fr)]">
        <SideBar open={side} drawer={drawer} onClose={() => setSide(false)} />
        <div id="main" role="main" tabIndex={-1} className="flex min-h-0 flex-col gap-3 px-5 outline-none max-[800px]:gap-2.5 max-[800px]:px-4 max-[800px]:pt-2.5 min-[801px]:h-full">
          <h1 className="sr-only">Job board</h1>
          <div className="flex flex-none flex-wrap items-center gap-2.5">
            <button ref={menu} type="button" id="side-open" aria-label="Menu" aria-expanded={side} aria-controls="site-side" onClick={() => setSide(!side)}
              className="hidden size-10 flex-none cursor-pointer place-items-center rounded-full border-[1.5px] border-foreground bg-card text-foreground hover:bg-muted min-[801px]:max-[1100px]:grid">
              <ListIcon size={20} />
            </button>
            <SearchRow />
            <Pills />
          </div>
          <MobileBar />
          <div className="board-grid min-h-0 flex-1 max-[800px]:-mx-4 max-[800px]:border-t min-[801px]:grid min-[801px]:grid-cols-[minmax(0,1fr)] min-[801px]:grid-rows-[minmax(0,1fr)] min-[801px]:gap-2.5">
            <List />
            <Pane />
          </div>
        </div>
      </div>
      <Footer />
      <AlertButton />
      <TabBar />
      {P ? <><P.FilterSheet /><P.GeoPrompt /></> : null}
    </div>
  );
}
