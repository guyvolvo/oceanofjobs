// `node --test extension/test/` hands the directory to require() on current
// Node, which lands here. Same as `node --test "extension/test/*.test.js"`.
for (const f of require('node:fs').readdirSync(__dirname)) {
  if (f.endsWith('.test.js')) require('./' + f);
}
