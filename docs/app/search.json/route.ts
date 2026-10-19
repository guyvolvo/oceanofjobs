import { source } from '@/lib/source';
import { createFromSource } from 'fumadocs-core/search/server';

export const revalidate = false;

// Exported once at build time as /docs/search.json; the browser searches it locally.
export const { staticGET: GET } = createFromSource(source, {
  language: 'english',
});
