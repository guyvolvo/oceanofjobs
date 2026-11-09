// The frame of a public page: the top bar, the content, the footer.
import type { ReactNode } from "react";
import { Footer } from "./Footer";
import { SiteHeader } from "./SiteHeader";

export function PublicPage({ current, children, wide, className = "", footerAside }: { current?: string; children: ReactNode; wide?: boolean; className?: string; footerAside?: ReactNode }) {
  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <SiteHeader current={current} />
      <main id="main" className={`mx-auto w-full px-4 md:px-6 ${wide ? "max-w-[1240px]" : "max-w-[860px]"} ${className}`} tabIndex={-1}>{children}</main>
      <Footer aside={footerAside} />
    </>
  );
}

// A page's title row: the h1, a line under it, the actions at the right.
export function PageHead({ title, note, actions }: { title: ReactNode; note?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 pt-8 pb-5">
      <div className="min-w-0">
        <h1 className="m-0 font-sans text-[26px] font-semibold leading-tight tracking-tight text-kumo-strong">{title}</h1>
        {note ? <p className="mt-1 mb-0 text-kumo-subtle">{note}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
