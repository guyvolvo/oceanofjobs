import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { gitConfig } from './shared';

// The site header (app/layout.tsx) carries the brand, the site's menus and
// the theme button, so the sidebar keeps only the docs' own title and search.
export function baseOptions(): BaseLayoutProps {
  return {
    nav: { title: 'Docs' },
    themeSwitch: { enabled: false },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
