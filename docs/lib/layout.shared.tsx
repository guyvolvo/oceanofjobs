import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, gitConfig } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      // A plain <a>: the site root is outside this app's /docs basePath.
      title: (
        <>
          <img src="/favicon.svg?v=3" width={20} height={20} alt="" />
          {appName}
        </>
      ),
      url: 'https://oceanofjobs.com/',
    },
    links: [
      { text: 'Jobs', url: 'https://oceanofjobs.com/board', external: false },
      { text: 'Companies', url: 'https://oceanofjobs.com/companies', external: false },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
