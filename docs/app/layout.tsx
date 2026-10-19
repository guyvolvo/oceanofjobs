import type { ReactNode } from 'react';
import localFont from 'next/font/local';
import { Provider } from '@/components/provider';
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

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <head>
        <link rel="icon" type="image/svg+xml" href="/favicon.svg?v=3" />
      </head>
      <body className="flex flex-col min-h-screen">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
