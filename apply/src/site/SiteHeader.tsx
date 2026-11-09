// The top bar on the public pages (home, pricing, docs, contact, legal).
// The signed-in workspace has the sidebar instead (Workspace.tsx).
import { useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { Bell, BookmarkSimple, CaretDown, ChatCircleDots, GearSix, List, Moon, PaperPlaneTilt, SignOut, Sun, UserCircle, X } from "@phosphor-icons/react";
import { requestSignIn, syncConsentOnce, useAuth, type Who } from "./auth";
import { SECTIONS } from "./nav";
import { SignInDialog } from "./SignIn";
import { useTheme } from "./theme";

export function Avatar({ who, className = "" }: { who: NonNullable<Who>; className?: string }) {
  return <span className={className} dangerouslySetInnerHTML={{ __html: avatarHtml(who.email, who.idToken) }} />;
}

const ACCOUNT_LINKS = [
  { label: "Account", href: "/account", icon: UserCircle },
  { label: "Saved jobs", href: "/board?starred=1", icon: BookmarkSimple },
  { label: "Auto apply", href: "/apply", icon: PaperPlaneTilt },
  { label: "Alerts", href: "/account/alerts", icon: Bell },
  { label: "Contact", href: "/contact", icon: ChatCircleDots },
];

export function Brand({ className = "" }: { className?: string }) {
  return (
    <a className={`inline-flex items-center gap-2.5 whitespace-nowrap font-sans text-[17px] font-medium tracking-tight text-kumo-strong no-underline ${className}`} href="/" aria-label="Ocean of Jobs home">
      <img className="block h-[22px] w-[22px]" src="/favicon.svg?v=3" width="22" height="22" alt="" />
      <span translate="no">Ocean of Jobs</span>
    </a>
  );
}

// The account corner: Log in, or the reader's mark and a short menu.
export function AccountMenu({ who }: { who: Who }) {
  const [dark, toggle] = useTheme();
  if (!who) {
    return (
      <>
        <button type="button" onClick={toggle} className="hidden sm:inline-flex items-center rounded-full border border-kumo-line px-4 py-0.5 font-display text-sm text-kumo-default hover:border-kumo-brand hover:text-kumo-brand cursor-pointer bg-transparent">{dark ? "Light" : "Dark"}</button>
        <button type="button" onClick={requestSignIn} className="inline-flex items-center px-1 font-display text-base text-kumo-default hover:underline underline-offset-4 cursor-pointer bg-transparent border-0">Log in</button>
      </>
    );
  }
  syncConsentOnce();
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger render={<button type="button" className="inline-flex items-center gap-2 px-1 font-display text-base text-kumo-default hover:text-kumo-brand cursor-pointer bg-transparent border-0" aria-label="My account" />}>
        <Avatar who={who} className="inline-flex" />My account
      </DropdownMenu.Trigger>
      <DropdownMenu.Content>
        <DropdownMenu.Label><span className="block max-w-[240px] truncate" title={who.email}>{who.email}</span></DropdownMenu.Label>
        {ACCOUNT_LINKS.map((l) => <DropdownMenu.LinkItem key={l.href} href={l.href} icon={<l.icon />}>{l.label}</DropdownMenu.LinkItem>)}
        <DropdownMenu.Item icon={dark ? <Sun /> : <Moon />} closeOnClick={false} onClick={toggle}>{dark ? "Light mode" : "Dark mode"}</DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Item variant="danger" icon={<SignOut />} onClick={() => signOut()}>Log out</DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

// Everything the bar holds, as one list, on a phone.
function MobileMenu({ who, current }: { who: Who; current?: string }) {
  const [open, setOpen] = useState(false);
  const [dark, toggle] = useTheme();
  const item = "flex items-center gap-3 rounded-lg px-3 py-2.5 text-base text-kumo-default no-underline hover:bg-kumo-tint";
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger render={<Button variant="ghost" shape="square" icon={<List size={22} />} aria-label="Menu" className="md:hidden" />} />
      <Dialog className="fixed inset-y-0 right-0 left-auto top-0 h-dvh max-h-dvh w-[min(360px,100vw)] translate-x-0 translate-y-0 rounded-none p-4 overflow-y-auto" aria-label="Menu">
        <div className="mb-3 flex items-center justify-between">
          <Brand />
          <Dialog.Close aria-label="Close" render={(p) => <Button {...p} variant="ghost" shape="square" icon={<X />} aria-label="Close" />} />
        </div>
        <nav aria-label="Main" className="flex flex-col gap-1">
          {SECTIONS.map((s) => s.items ? (
            <div key={s.key} className="mt-2">
              <div className="px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">{s.label}</div>
              {s.items.map((l) => <a key={l.href} className={item} href={l.href}>{l.icon ? <l.icon /> : null}{l.label}</a>)}
            </div>
          ) : <a key={s.key} className={`${item} mt-2 font-medium`} href={s.href} aria-current={current === s.key ? "page" : undefined}>{s.label}</a>)}
        </nav>
        <div className="mt-4 border-t border-kumo-hairline pt-3 flex flex-col gap-1">
          {who ? (
            <>
              <div className="flex items-center gap-3 px-3 py-2 text-sm text-kumo-subtle"><Avatar who={who} className="inline-flex" /><span className="truncate">{who.email}</span></div>
              {ACCOUNT_LINKS.map((l) => <a key={l.href} className={item} href={l.href}><l.icon />{l.label}</a>)}
            </>
          ) : (
            <button type="button" className={`${item} cursor-pointer border-0 bg-transparent text-left font-medium`} onClick={() => { setOpen(false); requestSignIn(); }}><UserCircle />Log in</button>
          )}
          <button type="button" className={`${item} cursor-pointer border-0 bg-transparent text-left`} onClick={toggle}>{dark ? <Sun /> : <Moon />}{dark ? "Light mode" : "Dark mode"}</button>
          {who ? <button type="button" className={`${item} cursor-pointer border-0 bg-transparent text-left text-kumo-danger`} onClick={() => signOut()}><SignOut />Log out</button> : null}
        </div>
      </Dialog>
    </Dialog.Root>
  );
}

export function SiteHeader({ current, className = "" }: { current?: string; className?: string }) {
  const who = useAuth();
  const link = "inline-flex items-center gap-1.5 py-1.5 font-display text-base text-kumo-default no-underline hover:underline underline-offset-4 cursor-pointer bg-transparent border-0";
  return (
    <div className={`site-header ${className}`}>
      <header className="mx-auto flex max-w-[1240px] items-center gap-5 px-4 py-3 md:px-6">
        <Brand className="flex-1" />
        <nav className="hidden md:flex items-center gap-7" aria-label="Main">
          {SECTIONS.map((s) => s.items ? (
            <DropdownMenu key={s.key}>
              <DropdownMenu.Trigger render={<button type="button" className={`${link} ${current === s.key ? "font-medium" : ""}`} aria-current={current === s.key ? "page" : undefined} />}>
                {s.label}<CaretDown size={12} />
              </DropdownMenu.Trigger>
              <DropdownMenu.Content>
                {s.items.map((l) => <DropdownMenu.LinkItem key={l.href} href={l.href} icon={l.icon ? <l.icon /> : undefined}>{l.label}</DropdownMenu.LinkItem>)}
              </DropdownMenu.Content>
            </DropdownMenu>
          ) : <a key={s.key} className={`${link} ${current === s.key ? "font-medium" : ""}`} href={s.href} aria-current={current === s.key ? "page" : undefined}>{s.label}</a>)}
        </nav>
        <div className="flex flex-1 items-center justify-end gap-5">
          <div className="hidden md:flex items-center gap-5"><AccountMenu who={who} /></div>
          <MobileMenu who={who} current={current} />
        </div>
      </header>
      <SignInDialog />
    </div>
  );
}
