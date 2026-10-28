import type { ReactNode } from 'react';
import localFont from 'next/font/local';
import { Provider } from '@/components/provider';
import { siteHeader } from '@/components/site-header';
import './global.css';

// The main site's own font files, so the build fetches nothing from Google.
const geist = localFont({
  src: [
    { path: '../../frontend/fonts/Geist-400-latin.woff2', weight: '400' },
    { path: '../../frontend/fonts/Geist-500-latin.woff2', weight: '500' },
  ],
  variable: '--font-geist',
});
const geistMono = localFont({
  src: [
    { path: '../../frontend/fonts/GeistMono-Regular.woff2', weight: '400' },
    { path: '../../frontend/fonts/GeistMono-Medium.woff2', weight: '500' },
  ],
  variable: '--font-geist-mono',
});

// The site's theme rule before first paint: dark unless the reader picked
// light. The header's button flips data-theme; Fumadocs reads the dark class.
const theme = `(function () {
  var root = document.documentElement;
  var light = false;
  try { light = localStorage.getItem("iljobs_theme") === "light"; } catch (e) {}
  if (!light) root.setAttribute("data-theme", "dark");
  var sync = function () { root.classList.toggle("dark", root.getAttribute("data-theme") === "dark"); };
  sync();
  new MutationObserver(sync).observe(root, { attributeFilter: ["data-theme", "class"] });
})();`;

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <head>
        <link rel="icon" type="image/svg+xml" href="/favicon.svg?v=3" />
        <script dangerouslySetInnerHTML={{ __html: theme }} />
        <link rel="stylesheet" href="/docs/site.css" />
      </head>
      <body className="flex flex-col min-h-screen">
        {/* The site header, as every other page has it (scripts/build_pages.py
            writes it). display: contents, so the header sticks to the page. */}
        <div style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: siteHeader }} />
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
