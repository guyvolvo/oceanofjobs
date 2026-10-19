import type { ReactNode } from 'react';
import { source } from '@/lib/source';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { baseOptions } from '@/lib/layout.shared';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    // Every sidebar folder starts open (REST API > reference > Jobs...), so
    // the whole endpoint list shows without clicking.
    <DocsLayout tree={source.getPageTree()} {...baseOptions()} sidebar={{ defaultOpenLevel: 3 }}>
      {children}
    </DocsLayout>
  );
}
