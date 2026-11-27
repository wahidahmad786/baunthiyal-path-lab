// libsignal 6.0.0 prints entire private Signal sessions through console.info/warn.
// Remove diagnostics only; leave its cryptographic/session behavior unchanged.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const root = dirname(require.resolve('libsignal/package.json'));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
if (version !== '6.0.0')
  throw new Error('Review Signal dependency logging before changing its version.');
let patched = 0;
for (const name of readdirSync(join(root, 'src'))) {
  if (!name.endsWith('.js')) continue;
  const file = join(root, 'src', name),
    source = readFileSync(file, 'utf8');
  const safe = source.replace(
    /console\.(?:log|info|warn|error|debug)\([^;]*?\);/g,
    '/* Private Signal diagnostics suppressed. */',
  );
  if (/console\.(?:log|info|warn|error|debug)\s*\(/.test(safe))
    throw new Error('Unreviewed Signal diagnostic format.');
  if (safe !== source) {
    writeFileSync(file, safe);
    patched++;
  }
}
console.log(`Signal private-session log protection ready (${patched} files patched).`);
