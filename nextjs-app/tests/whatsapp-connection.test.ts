import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  connectionSummary,
  decryptConnection,
  encryptConnection,
  verifyMetaConnection,
  type ConnectionRecord,
} from '../lib/whatsapp-connection';

const credentials: ConnectionRecord = {
  phone: '+916395951791',
  phoneNumberId: '123456789',
  businessAccountId: '987654321',
  appId: '555555555',
  accessToken: 'test-only-token-with-enough-characters',
  appSecret: 'test-only-app-secret',
  verifyToken: 'test-only-webhook-token',
  verifiedAt: null,
  verifiedName: '',
};
test('connection encryption binds secrets to the owner, detects tampering and redacts API responses', async () => {
  const key = 'a'.repeat(64);
  const envelope = await encryptConnection(credentials, 'owner-a', key);
  assert.ok(!JSON.stringify(envelope).includes(credentials.accessToken));
  assert.deepEqual(await decryptConnection(envelope, 'owner-a', key), credentials);
  await assert.rejects(() => decryptConnection(envelope, 'owner-b', key));
  await assert.rejects(() =>
    decryptConnection(
      { ...envelope, ciphertext: 'AAAA' + envelope.ciphertext.slice(4) },
      'owner-a',
      key,
    ),
  );
  const summary = connectionSummary(credentials);
  assert.equal(summary.accessTokenSaved, true);
  assert.ok(!JSON.stringify(summary).includes(credentials.accessToken));
  assert.ok(!('appSecret' in summary));
  assert.ok(!('verifyToken' in summary));
});
test('Meta verification validates WABA phone ownership, app identity and the entered phone number without sending', async () => {
  const paths: string[] = [];
  const meta = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    assert.equal(init?.method || 'GET', 'GET');
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      `Bearer ${credentials.accessToken}`,
    );
    assert.equal(url.searchParams.get('appsecret_proof')?.length, 64);
    return Response.json(
      url.pathname.endsWith('/app')
        ? { id: credentials.appId }
        : {
            data: [
              {
                id: credentials.phoneNumberId,
                display_phone_number: '+91 63959 51791',
                verified_name: 'Baunthiyal Path Lab',
              },
            ],
          },
    );
  }) as typeof fetch;
  assert.equal(
    (await verifyMetaConnection(credentials, 'v23.0', meta)).verifiedName,
    'Baunthiyal Path Lab',
  );
  assert.deepEqual(paths, ['/v23.0/987654321/phone_numbers', '/v23.0/app']);
  await assert.rejects(
    () => verifyMetaConnection({ ...credentials, phone: '+919876543210' }, 'v23.0', meta),
    /does not match/,
  );
  await assert.rejects(
    () => verifyMetaConnection({ ...credentials, phoneNumberId: '000000000' }, 'v23.0', meta),
    /not listed/,
  );
  const rejected = (async () =>
    Response.json(
      { error: { message: credentials.accessToken } },
      { status: 401 },
    )) as typeof fetch;
  await assert.rejects(
    () => verifyMetaConnection(credentials, 'v23.0', rejected),
    (e) => e instanceof Error && !e.message.includes(credentials.accessToken),
  );
});
