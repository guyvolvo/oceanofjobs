// The signed-in workspace: a sidebar (Discover, Applications, AI agent,
// Settings) beside the page. Public pages that are part of the product
// (the board, companies, statistics) use it too, signed in or not.
// Folds to an icon rail on a desktop; a drawer behind the menu button
// on a phone (shadcn's Sidebar does both).
import { useEffect, useState, type ReactNode } from "react";
import { ChatCircleDots, Moon, SignOut, Sun, UserCircle } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuBadge,
  SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarRail, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { Brand, SignInHost } from "../shell/Header";
import { requestSignIn, syncConsentOnce, useAuth, type Who } from "./auth";
import { GROUPS, type WorkKey } from "./nav";
import { Avatar } from "./SiteHeader";
import { useTheme } from "./theme";

const OPEN_KEY = "ooj_side_open";
const readOpen = () => { try { return localStorage.getItem(OPEN_KEY) !== "0"; } catch { return true; } };

function Account({ who }: { who: Who }) {
  const [dark, toggle] = useTheme();
  const { state, isMobile } = useSidebar();
  const folded = state === "collapsed" && !isMobile;
  useEffect(() => { if (who) syncConsentOnce(); }, [who]);
  const theme = <Button variant="ghost" size="icon-sm" aria-label={dark ? "Light mode" : "Dark mode"} onClick={toggle}>{dark ? <Sun /> : <Moon />}</Button>;
  if (!who) {
    return (
      <div className={cn("flex items-center gap-2", folded && "flex-col")}>
        {folded
          ? <Button size="icon-sm" aria-label="Log in" onClick={requestSignIn}><UserCircle /></Button>
          : <Button size="sm" onClick={requestSignIn}>Log in</Button>}
        {theme}
      </div>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-md p-1 text-left hover:bg-accent" aria-label="My account">
        <Avatar who={who} className="inline-flex" />
        {folded ? null : (
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-foreground">{who.name || "My account"}</span>
            <span className="block truncate text-xs text-muted-foreground">{who.email}</span>
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent side={isMobile ? "top" : "right"} align="end" className="min-w-[220px]">
        <DropdownMenuLabel className="max-w-[260px] truncate font-normal text-muted-foreground" title={who.email}>{who.email}</DropdownMenuLabel>
        <DropdownMenuItem asChild><a href="/account"><UserCircle />Account</a></DropdownMenuItem>
        <DropdownMenuItem asChild><a href="/contact"><ChatCircleDots />Contact</a></DropdownMenuItem>
        <DropdownMenuItem onSelect={(e) => { e.preventDefault(); toggle(); }}>{dark ? <Sun /> : <Moon />}{dark ? "Light mode" : "Dark mode"}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => signOut()}><SignOut />Log out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export type WorkspaceProps = {
  current: WorkKey;
  // The page's own title row. A page that draws its own (the board) leaves these out.
  title?: ReactNode; note?: ReactNode; actions?: ReactNode;
  // Under the brand: "Pro · 48 applications left".
  status?: ReactNode;
  // Counts beside Queue and Needs attention.
  badges?: Partial<Record<WorkKey, number>>;
  // No padding around the content: the page lays itself out edge to edge.
  bare?: boolean;
  children: ReactNode;
};

export function Workspace({ current, title, note, actions, status, badges = {}, bare, children }: WorkspaceProps) {
  const who = useAuth();
  const [open, setOpen] = useState(readOpen);
  // Remembers the fold between pages (each page is its own document).
  const fold = (o: boolean) => { setOpen(o); try { localStorage.setItem(OPEN_KEY, o ? "1" : "0"); } catch { /* storage blocked */ } };
  return (
    <SidebarProvider open={open} onOpenChange={fold} className="min-h-dvh">
      <a className="skip-link" href="#main">Skip to content</a>
      <Sidebar collapsible="icon">
        <SidebarHeader className="gap-1">
          <div className="flex h-10 items-center px-1.5 group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:[&_span]:hidden"><Brand /></div>
          {status ? <p className="m-0 px-2 pb-1 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">{status}</p> : null}
        </SidebarHeader>
        <SidebarContent>
          {GROUPS.map((g, i) => (
            <SidebarGroup key={g.label || i}>
              {g.label ? <SidebarGroupLabel>{g.label}</SidebarGroupLabel> : null}
              <SidebarMenu>
                {g.items.map((l) => {
                  const n = badges[l.key];
                  const active = l.key === current;
                  // Signed out, the pages that need an account open the sign-in instead.
                  const gated = l.signedIn && !who && l.key !== "overview";
                  const inner = <><l.icon weight={active ? "fill" : "regular"} /><span>{l.label}</span></>;
                  return (
                    <SidebarMenuItem key={l.key}>
                      <SidebarMenuButton asChild={!gated} isActive={active} tooltip={l.label} onClick={gated ? requestSignIn : undefined}>
                        {gated ? inner : <a href={l.href} aria-current={active ? "page" : undefined}>{inner}</a>}
                      </SidebarMenuButton>
                      {n ? <SidebarMenuBadge>{n}</SidebarMenuBadge> : null}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroup>
          ))}
        </SidebarContent>
        <SidebarFooter>
          <Account who={who} />
          <div className="flex justify-end group-data-[collapsible=icon]:justify-center"><SidebarTrigger aria-label="Fold the sidebar" /></div>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <div className="relative flex w-full min-w-0 flex-1 flex-col bg-background">
        <div className="flex items-center gap-2 border-b px-2 py-2 md:hidden">
          <SidebarTrigger aria-label="Menu" className="size-9" />
          <Brand />
        </div>
        <main id="main" tabIndex={-1} className={bare ? "flex min-w-0 flex-1 flex-col outline-none" : "mx-auto w-full max-w-[1140px] px-4 pb-16 outline-none md:px-6"}>
          {title ? (
            <div className="flex flex-wrap items-end justify-between gap-3 pt-6 pb-5">
              <div className="min-w-0">
                <h1 className="m-0 font-sans text-[26px] font-semibold leading-tight tracking-tight text-foreground">{title}</h1>
                {note ? <p className="mt-1 mb-0 text-muted-foreground">{note}</p> : null}
              </div>
              {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
            </div>
          ) : null}
          {children}
        </main>
      </div>
      <SignInHost />
    </SidebarProvider>
  );
}
