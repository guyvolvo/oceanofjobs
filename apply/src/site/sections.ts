// The public header's sections: the same list as api/site_header.py, which
// the server-rendered /job and /company pages still draw from. Its own
// module (re-exported by nav.tsx) so a page that needs only this list does
// not also load the workspace sidebar's icons.
import type { ComponentType } from "react";
import { ClockCounterClockwise, Code, Plug, PuzzlePiece } from "@phosphor-icons/react";

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
