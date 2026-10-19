import { createMDX } from 'fumadocs-mdx/next';
import { fileURLToPath } from 'node:url';

const withMDX = createMDX();

// Exported as static files into the site's bucket under /docs. No
// trailing slash: CloudFront redirects /x/ to /x and serves /x from x.html.
/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  basePath: '/docs',
  reactStrictMode: true,
  // The repo root, not docs/: the fonts come from ../frontend/fonts.
  turbopack: { root: fileURLToPath(new URL('..', import.meta.url)) },
};

export default withMDX(config);
