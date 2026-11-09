// One list of what the site has, so no two bars can disagree. The public
// header draws SECTIONS (sections.ts); the signed-in workspace's sidebar
// draws GROUPS.
import { Bell, BookmarkSimple, Buildings, ChartBar, ChatCircleDots, GearSix, ListChecks, MagnifyingGlass,
  PaperPlaneTilt, Robot, SlidersHorizontal, SquaresFour } from "@phosphor-icons/react";
import type { Icon } from "./sections";

export { SECTIONS, type Icon, type Link, type Section } from "./sections";

export type WorkKey = "jobs" | "companies" | "stats" | "saved" | "alerts" | "overview" | "queue" | "needs" | "history" | "apply-settings" | "agent" | "settings";
export type WorkLink = { key: WorkKey; label: string; href: string; icon: Icon; signedIn?: boolean };
export type WorkGroup = { label?: string; items: WorkLink[] };

// The sidebar. Discover is public; Applications and the rest need an
// account, and signed out they lead to the sign-in.
export const GROUPS: WorkGroup[] = [
  { label: "Discover", items: [
    { key: "jobs", label: "Jobs", href: "/board", icon: MagnifyingGlass },
    { key: "companies", label: "Companies", href: "/companies", icon: Buildings },
    { key: "stats", label: "Statistics", href: "/stats", icon: ChartBar },
    { key: "saved", label: "Saved jobs", href: "/board?starred=1", icon: BookmarkSimple },
    { key: "alerts", label: "Alerts", href: "/account/alerts", icon: Bell, signedIn: true } ] },
  { label: "Applications", items: [
    { key: "overview", label: "Overview", href: "/apply", icon: SquaresFour, signedIn: true },
    { key: "queue", label: "Queue", href: "/apply/queue", icon: ListChecks, signedIn: true },
    { key: "needs", label: "Needs attention", href: "/apply/needs", icon: ChatCircleDots, signedIn: true },
    { key: "history", label: "Applications", href: "/apply/history", icon: PaperPlaneTilt, signedIn: true },
    { key: "apply-settings", label: "Auto apply settings", href: "/apply/settings", icon: SlidersHorizontal, signedIn: true } ] },
  { items: [
    { key: "agent", label: "AI agent", href: "/apply/agent", icon: Robot, signedIn: true },
    { key: "settings", label: "Settings", href: "/account/settings", icon: GearSix, signedIn: true } ] },
];
