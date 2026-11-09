// The footer of every public page: the homepage's own, in React.
import type { ReactNode } from "react";
import { Brand } from "./SiteHeader";

const COLUMNS = [
  { title: "Product", links: [["Jobs", "/board"], ["Jobs by role", "/jobs"], ["Companies", "/companies"], ["Auto apply", "/apply"], ["Statistics", "/stats"]] },
  { title: "Developers", links: [["API docs", "/docs/api"], ["MCP docs", "/docs/mcp"], ["OpenAPI spec", "/api/openapi.json"], ["GitHub", "https://github.com/guyvolvo/oceanofjobs"]] },
  { title: "Site", links: [["Pricing", "/pricing"], ["Contact", "/contact"], ["Privacy", "/privacy"], ["Terms", "/terms"], ["Refunds", "/refunds"], ["Cookie settings", "/privacy#cookies"]] },
];

// `aside` sits at the right of the copyright line (the home page's "Last poll").
export function Footer({ aside }: { aside?: ReactNode } = {}) {
  return (
    <footer className="mt-16 border-t border-border">
      <div className="mx-auto grid max-w-[1240px] gap-8 px-4 py-10 md:px-6 sm:grid-cols-2 md:grid-cols-4">
        <div><Brand /></div>
        {COLUMNS.map((c) => (
          <nav key={c.title} aria-label={c.title} className="flex flex-col gap-2">
            <h2 className="m-0 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{c.title}</h2>
            {c.links.map(([label, href]) => (
              <a key={href} href={href} className="text-sm text-foreground no-underline hover:underline underline-offset-4"
                {...(label === "Cookie settings" ? { "data-cookie-settings": "" } : {})}>{label}</a>
            ))}
          </nav>
        ))}
      </div>
      <div className="mx-auto flex max-w-[1240px] flex-wrap items-center justify-between gap-3 px-4 pb-8 text-[13px] text-muted-foreground md:px-6">
        <span>© 2026 Guy Voloshin, <a className="underline underline-offset-2" href="mailto:guyvoloshin@oceanofjobs.com">guyvoloshin@oceanofjobs.com</a></span>
        {aside}
      </div>
    </footer>
  );
}
