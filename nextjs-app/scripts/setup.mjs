import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
const file = resolve('.env.local');
let content = existsSync(file) ? readFileSync(file, 'utf8') : readFileSync('.env.example', 'utf8');
const generated = [];
for (const key of ['CRON_SECRET', 'PUBLIC_RATE_LIMIT_SECRET', 'WHATSAPP_VERIFY_TOKEN']) {
  const existing = content.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim();
  if (existing || process.env[key]) continue;
  const line = `${key}=${randomBytes(32).toString('base64url')}`;
  content = new RegExp(`^${key}=.*$`, 'm').test(content)
    ? content.replace(new RegExp(`^${key}=.*$`, 'm'), line)
    : content + '\n' + line + '\n';
  generated.push(key);
}
writeFileSync(file, content, { mode: 0o600 });
chmodSync(file, 0o600);
console.log('Local server configuration prepared in git-ignored .env.local (permissions 0600).');
console.log(
  generated.length
    ? 'Generated server-only values: ' + generated.join(', ')
    : 'Existing values preserved; no credentials rotated.',
);
console.log(
  'No Firebase or Meta account was changed. Run npm run setup:check for remaining fields.',
);
