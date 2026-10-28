'use client';
import SearchDialog from '@/components/search';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { type ReactNode } from 'react';

export function Provider({ children }: { children: ReactNode }) {
  // No next-themes: the site header's theme button (hero_account.js) owns the
  // theme, and app/layout.tsx copies it onto the class Fumadocs reads.
  return <RootProvider search={{ SearchDialog }} theme={{ enabled: false }}>{children}</RootProvider>;
}
