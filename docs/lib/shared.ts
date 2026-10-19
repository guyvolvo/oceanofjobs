import { createGetUrl } from 'fumadocs-core/source';

export const appName = 'Ocean of Jobs';
// Routes inside the app; Next adds the /docs basePath to links.
export const docsRoute = '/';
// Fetched by the browser with plain fetch(), which Next does not prefix,
// so these carry the basePath themselves.
export const docsContentRoute = '/docs/llms.mdx';
export const searchIndexUrl = '/docs/search.json';

export const gitConfig = {
  user: 'guyvolvo',
  repo: 'oceanofjobs',
  branch: 'main',
};

const getContentUrl = createGetUrl(docsContentRoute);

export function getPageMarkdownUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, 'content.md'];

  return { segments, url: getContentUrl(segments, page.locale) };
}
