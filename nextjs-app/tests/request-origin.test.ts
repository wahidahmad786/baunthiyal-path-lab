import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedRequestOrigin } from '../lib/request-origin';
import { handleWhatsAppConnection } from '../lib/whatsapp-connection-api';
import { handleAccountCustomers } from '../lib/account-customers-api';
import { handleAccountCatalog } from '../lib/account-catalog-api';
import { handleAccountBanners } from '../lib/account-banners-api';
import { handleAccountChat } from '../lib/account-chat-api';

test('configured HTTPS origin works behind an internal HTTP proxy without trusting forwarded hosts', () => {
  const appOrigin = 'https://lab.example';
  const request = (origin?: string) =>
    new Request('http://127.0.0.1:8080/api/whatsapp/integration', {
      method: 'POST',
      headers: {
        ...(origin ? { origin } : {}),
        'x-forwarded-host': 'attacker.example',
        'x-forwarded-proto': 'https',
      },
    });
  assert.equal(allowedRequestOrigin(request(appOrigin), appOrigin), true);
  for (const origin of [
    undefined,
    'null',
    'https://attacker.example',
    'https://lab.example.attacker.example',
    'http://lab.example',
  ])
    assert.equal(allowedRequestOrigin(request(origin), appOrigin), false);
  assert.equal(allowedRequestOrigin(request(appOrigin), 'invalid-config'), false);
  assert.equal(
    allowedRequestOrigin(
      new Request('https://lab.example/api', { headers: { origin: appOrigin } }),
    ),
    true,
  );
});
test('all account mutation endpoints use the trusted public origin and still require sign-in', async () => {
  const env = {
    projectId: 'demo-bpl',
    apiKey: 'emulator',
    appOrigin: 'https://lab.example',
    encryptionKey: 'a'.repeat(64),
    serviceAccountJson: '',
  };
  const routes = [
    ['/api/whatsapp/integration', handleWhatsAppConnection],
    ['/api/account/customers', handleAccountCustomers],
    ['/api/account/catalog', handleAccountCatalog],
    ['/api/account/banners', handleAccountBanners],
    ['/api/account/inbox/setup', handleAccountChat],
  ] as const;
  let calls = 0;
  const send = (async () => {
    calls++;
    throw new Error('Unexpected external request');
  }) as typeof fetch;
  for (const [path, handler] of routes) {
    const make = (origin: string) =>
      new Request('http://localhost:8080' + path, {
        method: 'POST',
        headers: { origin },
        body: '{}',
      });
    assert.equal((await handler(make('https://lab.example'), env, send)).status, 401, path);
    assert.equal((await handler(make('https://attacker.example'), env, send)).status, 403, path);
  }
  assert.equal(calls, 0);
});
