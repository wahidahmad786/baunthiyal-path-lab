import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readEmbeddedEvent, embeddedCompletionSchema } from '../lib/embedded-signup';
import { embeddedStatus } from '../lib/embedded-signup-api';
import {
  encryptConnection,
  decryptConnection,
  connectionSummary,
} from '../lib/whatsapp-connection';

test('only actual HTTPS Facebook origins can provide selected WhatsApp assets', () => {
  const event = {
    type: 'WA_EMBEDDED_SIGNUP',
    event: 'FINISH',
    data: { waba_id: '12345678', phone_number_id: '87654321' },
  };
  for (const origin of [
    'https://facebook.com.evil.test',
    'https://evilfacebook.com',
    'http://www.facebook.com',
    'https://www.facebook.com:444',
    'null',
  ])
    assert.equal(readEmbeddedEvent(origin, JSON.stringify(event)), null);
  assert.deepEqual(readEmbeddedEvent('https://www.facebook.com', JSON.stringify(event)), {
    event: 'FINISH',
    wabaId: '12345678',
    phoneNumberId: '87654321',
  });
  assert.equal(
    readEmbeddedEvent('https://www.facebook.com', { ...event, event: 'FINISH_ONLY_WABA' }),
    null,
  );
  assert.equal(
    readEmbeddedEvent('https://www.facebook.com', { type: 'WA_EMBEDDED_SIGNUP', event: 'CANCEL' }),
    'cancel',
  );
});
test('quick connection stays unavailable until real portal Meta configuration is ready', () => {
  const base = { projectId: 'demo-bpl', apiKey: 'test', encryptionKey: 'a'.repeat(64) };
  assert.equal(embeddedStatus(base).ready, false);
  const ready = embeddedStatus({
    ...base,
    metaAppId: '12345678',
    metaConfigId: '87654321',
    metaAppSecret: 'test-secret'.repeat(3),
    serviceAccountJson: 'test-only',
    embeddedEnabled: true,
    webhookPublicReady: true,
    webhookBaseUrl: 'https://lab.test',
  });
  assert.equal(ready.ready, true);
  assert.equal(JSON.stringify(ready).includes('test-secret'), false);
});
test('completion binds an explicit selected account and one-use session; no client credentials accepted', () => {
  const base = {
    sessionId: 'a'.repeat(64),
    code: 'one-time-code-only',
    wabaId: '12345678',
    event: 'FINISH',
  };
  assert.equal(embeddedCompletionSchema.safeParse(base).success, true);
  assert.equal(
    embeddedCompletionSchema.safeParse({ ...base, appSecret: 'injected' }).success,
    false,
  );
  assert.equal(embeddedCompletionSchema.safeParse({ ...base, wabaId: '../other' }).success, false);
});
test('business authorization and registration PIN stay encrypted and scoped to their Google owner', async () => {
  const record = {
    phone: '+919876543210',
    phoneNumberId: '12345678',
    businessAccountId: '87654321',
    appId: '11111111',
    accessToken: 'test-business-token',
    appSecret: 'test-app-secret',
    verifyToken: 'test-callback-token',
    verifiedAt: new Date().toISOString(),
    verifiedName: 'Test lab',
    connectionMethod: 'embedded_signup' as const,
    tokenExpiresAt: null,
    coexistence: true,
    registrationPin: '123456',
  };
  const encrypted = await encryptConnection(record, 'owner-a', 'c'.repeat(64));
  const decoded = await decryptConnection(encrypted, 'owner-a', 'c'.repeat(64));
  assert.deepEqual(connectionSummary(decoded), {
    phone: record.phone,
    phoneNumberId: record.phoneNumberId,
    businessAccountId: record.businessAccountId,
    appId: record.appId,
    verifiedAt: record.verifiedAt,
    verifiedName: record.verifiedName,
    connectionMethod: 'embedded_signup',
    tokenExpiresAt: null,
    dataAccessExpiresAt: null,
    coexistence: true,
    accessTokenSaved: true,
    appSecretSaved: true,
    verifyTokenSaved: true,
  });
  assert.equal('registrationPin' in connectionSummary(decoded), false);
  await assert.rejects(decryptConnection(encrypted, 'owner-b', 'c'.repeat(64)));
});
