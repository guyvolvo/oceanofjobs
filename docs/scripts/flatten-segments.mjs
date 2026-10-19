// Next 16 exports each page's prefetch segments as nested files
// (mcp/__next.X/$oc$slug/__PAGE__.txt), but the browser asks for them by
// one dotted name (mcp/__next.X.$oc$slug.__PAGE__.txt). A host like Vercel
// maps one to the other; S3 cannot, so this writes the dotted copies.
// Without them every prefetch 404s and links fall back to slower loads.
import { copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

function files(dir) {
  return readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));
}

let copied = 0;
for (const f of files('out')) {
  const parts = f.split(sep);
  const i = parts.findIndex((p, k) => p.startsWith('__next.') && k < parts.length - 1);
  if (i === -1) continue;
  const flat = join(...parts.slice(0, i), parts.slice(i).join('.'));
  copyFileSync(f, flat);
  copied++;
}
console.log(`flatten-segments: ${copied} files`);
if (!copied) throw new Error('no nested __next segments found: did the Next export layout change?');
