// The frame of a public page: skip link, the bar, the content, and (where
// the old page had one) the landing page's footer.
import type { ReactNode } from "react";
import { Brand, Header } from "./Header";

const FOOTER = [
  { id: "foot-product", title: "Product", links: [["Jobs", "/board"], ["Jobs by role", "/jobs"], ["Companies", "/companies"], ["Auto apply", "/apply"], ["Statistics", "/stats"]] },
  { id: "foot-dev", title: "Developers", links: [["API docs", "/docs/api"], ["MCP docs", "/docs/mcp"], ["OpenAPI spec", "/api/openapi.json"], ["GitHub", "https://github.com/guyvolvo/oceanofjobs"]] },
  { id: "foot-site", title: "Site", links: [["Pricing", "/pricing"], ["Contact", "/contact"], ["Privacy", "/privacy"], ["Terms", "/terms"], ["Refunds", "/refunds"], ["Cookie settings", "/privacy#cookies"]] },
];

export function Footer() {
  return (
    <footer className="px-4 pt-12 pb-10 text-muted-foreground sm:px-10">
      <div className="mx-auto grid max-w-[1180px] grid-cols-2 gap-8 sm:grid-cols-3 lg:grid-cols-[1.6fr_1fr_1fr_1fr]">
        <div className="col-span-full self-center lg:col-span-1"><Brand /></div>
        {FOOTER.map((c) => (
          <nav key={c.id} aria-labelledby={c.id}>
            <h2 id={c.id} className="m-0 text-[13px] font-medium leading-[1.4] text-foreground">{c.title}</h2>
            {c.links.map(([label, href]) => (
              // consent.js reopens the cookie choice on any [data-cookie-settings] click.
              <a key={href} href={href} className="mt-2.5 block text-[13px] hover:text-link-hover" {...(label === "Cookie settings" ? { "data-cookie-settings": "" } : {})}>{label}</a>
            ))}
          </nav>
        ))}
      </div>
      <div className="mx-auto mt-10 flex max-w-[1180px] items-center justify-between gap-4 border-t pt-5 text-xs">
        <span>© 2026 Guy Voloshin, <a href="mailto:guyvoloshin@oceanofjobs.com">guyvoloshin@oceanofjobs.com</a></span>
      </div>
    </footer>
  );
}

export function Page({ current, footer, children }: { current?: string; footer?: boolean; children: ReactNode }) {
  return (
    <>
      <a className="fixed top-[-60px] left-4 z-[1000] rounded-lg bg-primary px-3 py-2 text-[13px] font-semibold text-primary-foreground focus-visible:top-3" href="#main">Skip to content</a>
      <Header current={current} />
      <main id="main" tabIndex={-1} className="outline-none">{children}</main>
      {footer ? <Footer /> : null}
    </>
  );
}
