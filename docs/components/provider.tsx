'use client';
import SearchDialog from '@/components/search';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { type ReactNode } from 'react';

export function Provider({ children }: { children: ReactNode }) {
  // The main site's theme key and values, so a choice made on either side carries over.
  return <RootProvider search={{ SearchDialog }} theme={{ storageKey: 'iljobs_theme', defaultTheme: 'dark', enableSystem: false }}>{children}</RootProvider>;
}
