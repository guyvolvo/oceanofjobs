// The bar's two menus that need Radix (positioning, focus trap): the
// signed-in account menu and the phone's sheet. Loaded on demand by
// Header.tsx, so a signed-out desktop visit never downloads them.
import { useEffect, type RefObject } from "react";
import { Bell, BookmarkSimple, ChatCircleDots, Moon, PaperPlaneTilt, SignOut, Sun, UserCircle } from "@phosphor-icons/react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { requestSignIn, syncConsentOnce, type Who } from "../site/auth";
import { SECTIONS } from "../site/sections";
import { Brand, ThemeWords, barText, toggleTheme } from "./Header";
import { useDark } from "./state";

const ACCOUNT_LINKS = [
  { label: "Account", href: "/account", icon: UserCircle },
  { label: "Saved jobs", href: "/board?starred=1", icon: BookmarkSimple },
  { label: "Auto apply", href: "/apply", icon: PaperPlaneTilt },
  // The hash, not /account/alerts: CloudFront serves only the bare /account today.
  { label: "Alerts", href: "/account#alerts", icon: Bell },
  { label: "Contact", href: "/contact", icon: ChatCircleDots },
];

export function AccountMenu({ who }: { who: NonNullable<Who> }) {
  const dark = useDark();
  useEffect(() => { syncConsentOnce(); }, []);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={cn(barText, "cursor-pointer gap-2 px-2.5")}>
        <span className="inline-flex" dangerouslySetInnerHTML={{ __html: avatarHtml(who.email, who.idToken) }} />My account
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[220px]">
        <DropdownMenuLabel className="max-w-[260px] truncate font-normal text-muted-foreground" title={who.email}>{who.email}</DropdownMenuLabel>
        {ACCOUNT_LINKS.map((l) => <DropdownMenuItem key={l.href} asChild><a href={l.href}><l.icon />{l.label}</a></DropdownMenuItem>)}
        <DropdownMenuItem onSelect={(e) => { e.preventDefault(); toggleTheme(); }}>{dark ? <Sun /> : <Moon />}{dark ? "Light mode" : "Dark mode"}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => signOut()}><SignOut />Log out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Everything the bar holds, as one list, on a phone.
export function MobileSheet({ open, onOpenChange, who, current, opener }: { open: boolean; onOpenChange: (o: boolean) => void; who: Who; current?: string; opener: RefObject<HTMLButtonElement | null> }) {
  const item = "flex items-center gap-3 border-b py-3.5 text-[17px] text-foreground";
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* Focus goes back to the menu button, which is not Radix's own trigger. */}
      <SheetContent side="right" className="w-[min(360px,100vw)] gap-0 overflow-y-auto bg-background px-5 pb-6"
        onCloseAutoFocus={(e) => { e.preventDefault(); opener.current?.focus(); }}>
        <SheetTitle className="sr-only">Menu</SheetTitle>
        <div className="flex h-16 items-center"><Brand /></div>
        <nav aria-label="Main" className="flex flex-col">
          {SECTIONS.map((s) => s.items ? (
            <div key={s.key} className="flex flex-col">
              <div className="pt-[18px] pb-1 text-xs font-medium text-muted-foreground">{s.label}</div>
              {s.items.map((l) => <a key={l.href} className={item} href={l.href}>{l.label}</a>)}
            </div>
          ) : <a key={s.key} className={cn(item, "mt-2")} href={s.href} aria-current={current === s.key ? "page" : undefined}>{s.label}</a>)}
        </nav>
        <div className="mt-4 flex flex-col">
          {who ? (
            <>
              <div className="truncate py-2 text-sm text-muted-foreground">{who.email}</div>
              {ACCOUNT_LINKS.map((l) => <a key={l.href} className={item} href={l.href}><l.icon size={18} className="text-muted-foreground" />{l.label}</a>)}
              <button type="button" className={cn(item, "cursor-pointer text-left text-destructive")} onClick={() => signOut()}><SignOut size={18} />Log out</button>
            </>
          ) : (
            <button type="button" className={cn(item, "cursor-pointer text-left")} onClick={() => { onOpenChange(false); requestSignIn(); }}><UserCircle size={18} className="text-muted-foreground" />Log in</button>
          )}
          <button type="button" className={cn(item, "cursor-pointer text-left")} onClick={toggleTheme}>
            <Moon size={18} className="text-muted-foreground dark:hidden" /><Sun size={18} className="hidden text-muted-foreground dark:inline" /><span><ThemeWords /> mode</span>
          </button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
