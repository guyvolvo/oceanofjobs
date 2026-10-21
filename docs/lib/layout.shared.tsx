import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { HomeLink } from '@/components/home-link';
import { SiteLinks } from '@/components/site-links';
import { gitConfig } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: { title: HomeLink },
    links: [{ type: 'custom', children: <SiteLinks /> }],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
