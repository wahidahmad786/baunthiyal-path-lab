import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatWindowOpen, nextChatStatus, handleAccountChat } from '../lib/account-chat-api';
import { isStopMessage, handleWhatsAppWebhook } from '../lib/whatsapp-webhook';
import {
  getServiceAccessToken,
  clearServiceTokenCacheForTests,
} from '../lib/google-service-account';
import type { ChatEnvironment } from '../lib/chat-types';

test('API reply windows and provider statuses cannot invent delivery or extend expired replies', () => {
  const now = Date.now();
  assert.equal(chatWindowOpen(null, now), false);
  assert.equal(chatWindowOpen(new Date(now - 25 * 3600000).toISOString(), now), false);
  assert.equal(chatWindowOpen(new Date(now - 2 * 3600000).toISOString(), now), true);
  assert.equal(chatWindowOpen(new Date(now + 10 * 60000).toISOString(), now), false);
  assert.equal(nextChatStatus('accepted', 'sent'), 'sent');
  assert.equal(nextChatStatus('read', 'sent'), 'read');
  assert.equal(nextChatStatus('delivered', 'failed'), 'delivered');
  assert.equal(nextChatStatus('unknown', 'delivered'), 'delivered');
  assert.equal(nextChatStatus('failed', 'read'), 'read');
  for (const value of ['STOP', 'stop all', 'Unsubscribe', 'QUIT.'])
    assert.equal(isStopMessage(value), true);
  for (const value of ['Do not stop', 'unstoppable', 'Please stop my medication'])
    assert.equal(isStopMessage(value), false);
});
test('unauthenticated inbox calls and malformed webhook signatures never reach storage or Meta', async () => {
  const env: ChatEnvironment = {
    projectId: 'demo-bpl',
    apiKey: 'emulator',
    encryptionKey: 'a'.repeat(64),
  };
  const blocked = (async () => {
    throw new Error('No external request should occur');
  }) as typeof fetch;
  assert.equal(
    (
      await handleAccountChat(
        new Request('https://lab.example.test/api/account/inbox'),
        env,
        blocked,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await handleWhatsAppWebhook(
        new Request('https://lab.example.test/webhook/owner', { method: 'POST', body: '{}' }),
        'owner',
        env,
        blocked,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await handleWhatsAppWebhook(
        new Request('https://lab.example.test/webhook/owner?hub.mode=subscribe&hub.challenge='),
        'owner',
        env,
        blocked,
      )
    ).status,
    403,
  );
});
test('service OAuth uses a signed short-lived JWT, fixed Google endpoint, least-privilege scope and cached token', async () => {
  clearServiceTokenCacheForTests();
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const exported = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const privateKey =
    '-----BEGIN PRIVATE KEY-----\n' +
    Buffer.from(exported).toString('base64') +
    '\n-----END PRIVATE KEY-----\n';
  const account = JSON.stringify({
    type: 'service_account',
    client_email: 'inbox@demo-bpl.iam.gserviceaccount.com',
    private_key: privateKey,
    project_id: 'demo-bpl',
    token_uri: 'https://malicious.example/token',
  });
  let requests = 0;
  const transport = (async (url, init) => {
    requests++;
    assert.equal(String(url), 'https://oauth2.googleapis.com/token');
    const params = new URLSearchParams(String(init?.body));
    const assertion = params.get('assertion')!;
    const [header, payload, signature] = assertion.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    assert.equal(claims.scope, 'https://www.googleapis.com/auth/datastore');
    assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
    assert.equal(claims.exp - claims.iat, 3600);
    assert.equal(
      await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        pair.publicKey,
        Buffer.from(signature, 'base64url'),
        new TextEncoder().encode(header + '.' + payload),
      ),
      true,
    );
    assert.ok(!assertion.includes(privateKey));
    return Response.json({ access_token: 'test-service-token', expires_in: 3600 });
  }) as typeof fetch;
  const [one, two] = await Promise.all([
    getServiceAccessToken(account, transport),
    getServiceAccessToken(account, transport),
  ]);
  assert.equal(one, 'test-service-token');
  assert.equal(two, one);
  assert.equal(await getServiceAccessToken(account, transport), one);
  assert.equal(requests, 1);
  await assert.rejects(
    () => getServiceAccessToken(JSON.stringify({ private_key: privateKey }), transport),
    (error) => error instanceof Error && !error.message.includes(privateKey),
  );
});
