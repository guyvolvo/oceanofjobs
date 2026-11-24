// The phone's bottom tab bar on the app pages (frontend/tabbar.js): Jobs,
// Companies, Saved, Alerts, Account. Shown up to 800px wide; the spacer
// keeps the end of the page clear of it.
import { Bell, Briefcase, Buildings, Star, User } from "@/components/icons";
import { cn } from "@/lib/utils";

const TABS = [
  { key: "jobs", label: "Jobs", href: "/board", icon: Briefcase },
  { key: "companies", label: "Companies", href: "/companies", icon: Buildings },
  { key: "saved", label: "Saved", href: "/board?starred=1", icon: Star },
  // The hash, not /account/alerts: CloudFront serves only the bare /account today.
  { key: "alerts", label: "Alerts", href: "/account#alerts", icon: Bell },
  { key: "account", label: "Account", href: "/account", icon: User },
];

export function TabBar({ current, hidden }: { current?: string; hidden?: boolean }) {
  return (
    <>
      <div className="h-[calc(64px+env(safe-area-inset-bottom))] min-[801px]:hidden" aria-hidden="true" />
      <nav aria-label="Tab bar" className={cn("fixed inset-x-0 bottom-0 z-30 flex h-[calc(64px+env(safe-area-inset-bottom))] border-t bg-background pb-[env(safe-area-inset-bottom)] min-[801px]:hidden", hidden && "hidden")}>
        {TABS.map((t) => (
          <a key={t.key} href={t.href} aria-current={t.key === current ? "page" : undefined}
            className={cn("flex min-h-11 flex-1 flex-col items-center gap-[3px] pt-2 font-ui text-[11px] text-muted-foreground", t.key === current && "font-bold text-foreground")}>
            <t.icon size={21} weight={t.key === current ? "bold" : "regular"} aria-hidden="true" />{t.label}
          </a>
        ))}
      </nav>
    </>
  );
}
