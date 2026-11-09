// One list of what the site has, so no two bars can disagree. The public
// header draws SECTIONS; the signed-in workspace's sidebar draws GROUPS.
// The same list as api/site_header.py, which the server-rendered /job and
// /company pages still draw from.
import type { ComponentType } from "react";
import { Bell, BookmarkSimple, Buildings, ChartBar, ChatCircleDots, Code, ClockCounterClockwise, GearSix, ListChecks, MagnifyingGlass,
  PaperPlaneTilt, Plug, PuzzlePiece, Robot, SlidersHorizontal, SquaresFour } from "@phosphor-icons/react";

export type Icon = ComponentType<{ className?: string; size?: number | string; weight?: "regular" | "bold" | "fill" }>;
export type Link = { label: string; href: string; icon?: Icon };
export type Section = { key: string; label: string; href?: string; items?: Link[] };

export const SECTIONS: Section[] = [
  { key: "jobs", label: "Jobs", items: [
    { label: "All jobs", href: "/board?roles=all" }, { label: "Tech jobs", href: "/board?roles=tech" },
    { label: "Remote jobs", href: "/board?roles=all&workplace=remote" }, { label: "Jobs by role", href: "/jobs" },
    { label: "Saved jobs", href: "/board?starred=1" } ] },
  { key: "companies", label: "Companies", items: [
    { label: "Directory", href: "/companies" }, { label: "A to Z", href: "/companies/a" }, { label: "Statistics", href: "/stats" } ] },
  { key: "docs", label: "Docs", items: [
    { label: "API", href: "/docs/api", icon: Code }, { label: "MCP", href: "/docs/mcp", icon: Plug },
    { label: "Extension", href: "/docs/extension", icon: PuzzlePiece }, { label: "Product updates", href: "/docs/changelog", icon: ClockCounterClockwise } ] },
  { key: "pricing", label: "Pricing", href: "/pricing" },
  { key: "contact", label: "Contact", href: "/contact" },
];

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
