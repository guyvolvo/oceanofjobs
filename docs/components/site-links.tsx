// The rest of the site, in the docs sidebar: the same sections as the site
// header (api/site_header.py SIDE; tests/test_site_header.py keeps the two
// in step). Plain <a>, for the same reason as HomeLink: Next's router would
// add the /docs basePath.
const LINKS = [
  ['Jobs', '/board'],
  ['Jobs by role', '/jobs'],
  ['Companies', '/companies'],
  ['Statistics', '/stats'],
  ['Auto apply', '/apply'],
  ['Pricing', '/pricing'],
  ['Contact', '/contact'],
] as const;

export function SiteLinks() {
  return (
    <nav aria-label="Ocean of Jobs" className="flex flex-wrap gap-x-3 gap-y-1 px-2 pb-2 text-sm text-fd-muted-foreground">
      {LINKS.map(([label, href]) => (
        <a key={href} href={href} className="hover:text-fd-foreground">
          {label}
        </a>
      ))}
    </nav>
  );
}
