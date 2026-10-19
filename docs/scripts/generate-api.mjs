// Writes one MDX page per API operation into content/docs/api/reference,
// grouped by the schema's tags. Run before every build (npm run build
// does), so the reference follows the live schema. The output is
// generated, so it is not committed.
import { rmSync } from 'node:fs';
import { generateFiles } from 'fumadocs-openapi';
import { openapi } from '../lib/openapi.ts';

const output = './content/docs/api/reference';
rmSync(output, { recursive: true, force: true });
await generateFiles({
  input: openapi,
  output,
  per: 'operation',
  groupBy: 'tag',
  // The schema has no operationIds, so name pages by route: get /jobs/{id} -> get-jobs-id.
  name: (o) => o.item.method + o.item.path.replace(/[{}]/g, '').replace(/\//g, '-'),
  includeDescription: true,
  meta: true,
});
