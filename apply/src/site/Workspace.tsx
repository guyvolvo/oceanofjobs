// The signed-in workspace: a sidebar (Discover, Applications, AI agent,
// Settings) beside the page. Public pages that are part of the product
// (the board, companies, statistics) use it too, signed in or not.
// Folds to an icon rail on a desktop; a drawer behind the menu button
// on a phone (Kumo's Sidebar does both).
import { useEffect, type ReactNode } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { Sidebar, useSidebar } from "@cloudflare/kumo/components/sidebar";
import { ChatCircleDots, Moon, SignOut, Sun, UserCircle } from "@phosphor-icons/react";
import { requestSignIn, syncConsentOnce, useAuth, type Who } from "./auth";
import { GROUPS, type WorkKey } from "./nav";
import { Avatar, Brand } from "./SiteHeader";
import { SignInDialog } from "./SignIn";
import { useTheme } from "./theme";

const OPEN_KEY = "ooj_side_open";
const readOpen = () => { try { return localStorage.getItem(OPEN_KEY) !== "0"; } catch { return true; } };

// Remembers the fold between pages (each page is its own document).
function Persist() {
  const { open, isMobile } = useSidebar();
  useEffect(() => { if (!isMobile) try { localStorage.setItem(OPEN_KEY, open ? "1" : "0"); } catch { /* storage blocked */ } }, [open, isMobile]);
  return null;
}

function Account({ who }: { who: Who }) {
  const [dark, toggle] = useTheme();
  const { state } = useSidebar();
  const folded = state === "collapsed";
  if (!who) {
    return (
      <div className={`flex ${folded ? "flex-col" : "flex-row"} items-center gap-2`}>
        <Button variant="primary" size="sm" className={folded ? "w-full justify-center" : ""} onClick={requestSignIn}
          icon={folded ? <UserCircle /> : undefined} aria-label="Log in">{folded ? "" : "Log in"}</Button>
        <Button variant="ghost" size="sm" shape="square" icon={dark ? <Sun /> : <Moon />} aria-label={dark ? "Light mode" : "Dark mode"} onClick={toggle} />
      </div>
    );
  }
  syncConsentOnce();
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger render={<button type="button" className="flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg border-0 bg-transparent p-1 text-left hover:bg-kumo-tint" aria-label="My account" />}>
        <Avatar who={who} className="inline-flex" />
        {folded ? null : (
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-kumo-strong">{who.name || "My account"}</span>
            <span className="block truncate text-xs text-kumo-subtle">{who.email}</span>
          </span>
        )}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content>
        <DropdownMenu.LinkItem href="/account" icon={<UserCircle />}>Account</DropdownMenu.LinkItem>
        <DropdownMenu.LinkItem href="/contact" icon={<ChatCircleDots />}>Contact</DropdownMenu.LinkItem>
        <DropdownMenu.Item icon={dark ? <Sun /> : <Moon />} closeOnClick={false} onClick={toggle}>{dark ? "Light mode" : "Dark mode"}</DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Item variant="danger" icon={<SignOut />} onClick={() => signOut()}>Log out</DropdownMenu.Item>
      </DropdownMenu.Content>
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
  const here = (href: string) => href.split("?")[0];
  return (
    <Sidebar.Provider defaultOpen={readOpen()} collapsible="icon" className="min-h-dvh">
      <Persist />
      <a className="skip-link" href="#main">Skip to content</a>
      {/* Desktop only: on a phone Kumo draws the sidebar as a fixed drawer, and sticky would put it back in the row. */}
      <Sidebar className="md:sticky md:top-0 md:h-dvh! md:self-start">
        {/* Kumo's header is one 58px row; the status line goes under the brand. */}
        <Sidebar.Header className="h-auto flex-col items-stretch py-2">
          <div className="flex items-center justify-between gap-2 px-1 py-1">
            <Brand className="group-data-[state=collapsed]/sidebar:[&>span]:hidden" />
          </div>
          {status ? <p className="m-0 px-2 pb-1 text-xs text-kumo-subtle group-data-[state=collapsed]/sidebar:hidden">{status}</p> : null}
        </Sidebar.Header>
        <Sidebar.Content>
          {GROUPS.map((g, i) => (
            <Sidebar.Group key={g.label || i}>
              {g.label ? <Sidebar.GroupLabel>{g.label}</Sidebar.GroupLabel> : null}
              <Sidebar.Menu>
                {g.items.map((l) => {
                  const n = badges[l.key];
                  const active = l.key === current;
                  // Signed out, the pages that need an account open the sign-in instead.
                  const gated = l.signedIn && !who && l.key !== "overview";
                  return (
                    <Sidebar.MenuItem key={l.key}>
                      <Sidebar.MenuButton icon={<l.icon weight={active ? "fill" : "regular"} />} active={active} tooltip={l.label}
                        href={gated ? undefined : l.href} onClick={gated ? requestSignIn : undefined}
                        aria-current={active ? "page" : undefined} data-here={here(l.href)}>
                        {l.label}
                        {n ? <Sidebar.MenuBadge className="ml-auto">{n}</Sidebar.MenuBadge> : null}
                      </Sidebar.MenuButton>
                    </Sidebar.MenuItem>
                  );
                })}
              </Sidebar.Menu>
            </Sidebar.Group>
          ))}
        </Sidebar.Content>
        <Sidebar.Footer>
          <Account who={who} />
          <div className="flex justify-end group-data-[state=collapsed]/sidebar:justify-center"><Sidebar.Trigger /></div>
        </Sidebar.Footer>
        <Sidebar.Rail />
      </Sidebar>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-kumo-hairline px-2 py-2 md:hidden">
          <Sidebar.Trigger />
          <Brand />
        </div>
        <main id="main" tabIndex={-1} className={bare ? "flex min-w-0 flex-1 flex-col" : "mx-auto w-full max-w-[1140px] px-4 pb-16 md:px-6"}>
          {title ? (
            <div className="flex flex-wrap items-end justify-between gap-3 pt-6 pb-5">
              <div className="min-w-0">
                <h1 className="m-0 font-sans text-[26px] font-semibold leading-tight tracking-tight text-kumo-strong">{title}</h1>
                {note ? <p className="mt-1 mb-0 text-kumo-subtle">{note}</p> : null}
              </div>
              {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
            </div>
          ) : null}
          {children}
        </main>
      </div>
      <SignInDialog />
    </Sidebar.Provider>
  );
}
