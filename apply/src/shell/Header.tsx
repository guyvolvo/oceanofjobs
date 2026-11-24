// The bar on every public page: the brand, the site's menus (one list,
// src/site/nav.tsx, the same as api/site_header.py), theme and account.
// The menus are disclosures whose links are in the HTML even while shut,
// so a crawler that runs no script still finds every page they list.
// The parts built on Radix (account menu, phone sheet, sign-in window)
// load on first use, which keeps them out of every page's first load.
import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import { CaretDown, List } from "@/components/icons";
// clsx, not cn: no class here overrides another, and tailwind-merge
// (about 7 KB gzip) would otherwise be in every text page's first load.
import { clsx as cn } from "clsx";
import { requestSignIn, SIGNIN_EVENT, type Who } from "../site/auth";
import { SECTIONS, type Section } from "../site/sections";
import { applyTheme } from "../site/theme";
import { useWho } from "./state";

const AccountMenu = lazy(() => import("./Menus").then((m) => ({ default: m.AccountMenu })));
const MobileSheet = lazy(() => import("./Menus").then((m) => ({ default: m.MobileSheet })));
const SignInWindow = lazy(() => import("./SignIn"));

export const toggleTheme = () => applyTheme(document.documentElement.getAttribute("data-mode") !== "dark");
export const barText = "inline-flex h-8 items-center gap-[5px] text-sm text-muted-foreground hover:text-foreground";

export function Brand() {
  return (
    <a className="inline-flex items-center gap-2.5 whitespace-nowrap text-[17px] font-medium leading-none tracking-[-0.01em] text-foreground" href="/" aria-label="Ocean of Jobs home">
      <img className="block size-[22px] flex-none" src="/favicon.svg?v=3" width="22" height="22" alt="" />
      <span translate="no">Ocean of Jobs</span>
    </a>
  );
}

// "Dark" while light, "Light" while dark: both are in the HTML and CSS
// shows the right one, so the label is right before any script runs.
export function ThemeWords() {
  return <><span className="dark:hidden">Dark</span><span className="hidden dark:inline">Light</span></>;
}

// One menu of the bar: a button that shows and hides its panel of links.
function NavMenu({ section, current }: { section: Section; current?: string }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); button.current?.focus(); } };
    document.addEventListener("pointerdown", away);
    document.addEventListener("focusin", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("focusin", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div className="relative" ref={root}>
      <button ref={button} type="button" className={cn(barText, "cursor-pointer rounded-xs", (open || current === section.key) && "text-foreground", current === section.key && "font-medium")}
        aria-expanded={open} aria-controls={panel} onClick={() => setOpen(!open)}>
        {section.label}<CaretDown size={12} className={cn("transition-transform duration-150", open && "rotate-180")} aria-hidden="true" />
      </button>
      <div id={panel} hidden={!open} className="absolute top-[calc(100%+10px)] -left-[19px] z-40 flex min-w-[180px] flex-col rounded-lg border bg-background p-1.5 animate-in fade-in-0 slide-in-from-top-1">
        {section.items!.map((l) => (
          <a key={l.href} href={l.href} className="flex items-center justify-between gap-[18px] rounded-lg px-3 py-2.5 text-sm font-medium text-foreground hover:bg-accent focus-visible:bg-accent">
            <span>{l.label}</span>{l.icon ? <l.icon size={16} className="flex-none opacity-55" aria-hidden="true" /> : null}
          </a>
        ))}
      </div>
    </div>
  );
}

function MobileMenu({ who, current }: { who: Who; current?: string }) {
  const [open, setOpen] = useState(false);
  const [used, setUsed] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      {/* shadcn's ghost icon button, written out so the Button module stays out of the first load. */}
      <button ref={button} type="button" className="inline-flex size-9 cursor-pointer items-center justify-center rounded-md hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:hidden"
        aria-label="Menu" aria-haspopup="dialog" aria-expanded={open} onClick={() => { setUsed(true); setOpen(true); }}><List size={24} /></button>
      {used ? <Suspense fallback={null}><MobileSheet open={open} onOpenChange={setOpen} who={who} current={current} opener={button} /></Suspense> : null}
    </>
  );
}

// Owns the sign-in window's state, so a "Log in" (or auth.js after a failed
// redirect, through window.openSignIn and its error sink) is never lost
// while the window's code is still loading.
export function SignInHost() {
  const [open, setOpen] = useState(false);
  const [used, setUsed] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const on = () => { setUsed(true); setOpen(true); };
    addEventListener(SIGNIN_EVENT, on);
    if (typeof setAuthErrorSink === "function") setAuthErrorSink(setError);
    return () => removeEventListener(SIGNIN_EVENT, on);
  }, []);
  return used ? <Suspense fallback={null}><SignInWindow open={open} onOpenChange={setOpen} error={error} setError={setError} /></Suspense> : null;
}

export function Header({ current, className }: { current?: string; className?: string }) {
  const who = useWho();
  return (
    <div className={cn("sticky top-0 z-30 bg-background", className)}>
      <header className="flex h-16 items-center gap-6 px-4 leading-none sm:grid sm:grid-cols-[1fr_auto_1fr] sm:px-[max(40px,calc((100%-1100px)/2))]">
        <div className="flex-1 justify-self-start"><Brand /></div>
        <nav aria-label="Main" className="hidden items-center gap-7 sm:flex">
          {SECTIONS.map((s) => s.items ? <NavMenu key={s.key} section={s} current={current} />
            : <a key={s.key} className={cn(barText, current === s.key && "font-medium text-foreground")} href={s.href} aria-current={current === s.key ? "page" : undefined}>{s.label}</a>)}
        </nav>
        <div className="flex items-center justify-end gap-2.5 justify-self-end">
          <div className="hidden items-center gap-2.5 sm:flex">
            {who ? (
              <Suspense fallback={<span className={cn(barText, "px-2.5")}>My account</span>}><AccountMenu who={who} /></Suspense>
            ) : (
              <>
                <button type="button" onClick={toggleTheme} className="h-8 cursor-pointer rounded-full bg-muted px-3.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"><ThemeWords /></button>
                {/* A link without script (the account page signs in too); the window with it. */}
                <a href="/account" data-signed-out="" className={cn(barText, "px-2.5")} onClick={(e) => { e.preventDefault(); requestSignIn(); }}>Log in</a>
              </>
            )}
          </div>
          <MobileMenu who={who} current={current} />
        </div>
      </header>
      <SignInHost />
    </div>
  );
}
