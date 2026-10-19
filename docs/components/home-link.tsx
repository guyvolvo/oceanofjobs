'use client';
import type { ComponentProps } from 'react';
import { appName } from '@/lib/shared';

// The nav title as a plain same-tab <a> to the site root. A nav url would
// go through Next's router, which adds the /docs basePath, or open a new tab.
export function HomeLink(props: ComponentProps<'a'>) {
  return (
    <a {...props} href="/" target={undefined} rel={undefined}>
      <img src="/favicon.svg?v=3" width={20} height={20} alt="" />
      {appName}
    </a>
  );
}
