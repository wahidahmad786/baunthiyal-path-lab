import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { deleteApp } from 'firebase-admin/app';
import { auth, adminApp, db } from '../lib/server/firebase';
import {
  handleWhatsAppConnection,
  type ConnectionEnvironment,
} from '../lib/whatsapp-connection-api';

process.env.FIREBASE_PROJECT_ID ||= process.env.GCLOUD_PROJECT;
if (
  process.env.FIREBASE_PROJECT_ID !== 'demo-bpl' ||
  !process.env.FIREBASE_AUTH_EMULATOR_HOST ||
  !process.env.FIRESTORE_EMULATOR_HOST
)
  throw new Error(
    'Account connection tests require the isolated demo-bpl Auth and Firestore emulators.',
  );
const env: ConnectionEnvironment = {
  projectId: 'demo-bpl',
  apiKey: 'emulator-only',
  encryptionKey: 'b'.repeat(64),
  authOrigin: `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com`,
  firestoreOrigin: `http://${process.env.FIRESTORE_EMULATOR_HOST}`,
};
const origin = 'https://lab.example.test';
const input = {
  phone: '+916395951791',
  phoneNumberId: '123456789',
  businessAccountId: '987654321',
  appId: '555555555',
  accessToken: 'emulator-only-token-long-enough',
  appSecret: 'emulator-only-secret',
  verifyToken: 'emulator-only-webhook',
  verify: false,
};
const tokens: Record<string, string> = {};
before(async () => {
  for (const uid of ['connection-owner-a', 'connection-owner-b', 'connection-unverified']) {
    await auth().createUser({
      uid,
      email: `${uid}@example.test`,
      emailVerified: uid !== 'connection-unverified',
      password: 'emulator-only-password',
    });
    const response = await fetch(
      `${env.authOrigin}/v1/accounts:signInWithPassword?key=emulator-only`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: `${uid}@example.test`,
          password: 'emulator-only-password',
          returnSecureToken: true,
        }),
      },
    );
    tokens[uid] = (await response.json()).idToken;
    assert.ok(tokens[uid]);
  }
});
after(async () => {
  await deleteApp(adminApp());
});
function request(uid?: string, data?: unknown, requestOrigin = origin) {
  return new Request(`${origin}/api/whatsapp/integration`, {
    method: data === undefined ? 'GET' : 'POST',
    headers: {
      origin: requestOrigin,
      'Content-Type': 'application/json',
      ...(uid ? { Authorization: `Bearer ${tokens[uid]}` } : {}),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
}
test('signed-in accounts save encrypted connections, keep secrets on edit and cannot read each other', async () => {
  assert.equal((await handleWhatsAppConnection(request(), env)).status, 401);
  assert.equal(
    (await handleWhatsAppConnection(request('connection-unverified', input), env)).status,
    403,
  );
  assert.equal(
    (
      await handleWhatsAppConnection(
        request('connection-owner-a', input, 'https://other.example'),
        env,
      )
    ).status,
    403,
  );
  const saved = await handleWhatsAppConnection(request('connection-owner-a', input), env);
  assert.equal(saved.status, 200, await saved.clone().text());
  const payload = await saved.json();
  assert.equal(payload.connection.accessTokenSaved, true);
  assert.ok(!JSON.stringify(payload).includes(input.accessToken));
  const stored = (
    await db().collection('bpl_whatsappConnections').doc('connection-owner-a').get()
  ).data()!;
  assert.ok(!JSON.stringify(stored).includes(input.appSecret));
  assert.ok(stored.ciphertext);
  const read = await handleWhatsAppConnection(request('connection-owner-a'), env);
  assert.equal((await read.json()).connection.phone, input.phone);
  const other = await handleWhatsAppConnection(request('connection-owner-b'), env);
  assert.equal((await other.json()).connection, null);
  const updated = await handleWhatsAppConnection(
    request('connection-owner-a', { ...input, accessToken: '', appSecret: '', verifyToken: '' }),
    env,
  );
  assert.equal(updated.status, 200, await updated.clone().text());
  assert.equal((await updated.json()).connection.appSecretSaved, true);
});
test('Firestore rejects cross-account access, collection listing, plaintext fields, schema corruption and role injection', async () => {
  const base = `${env.firestoreOrigin}/v1/projects/demo-bpl/databases/(default)/documents/bpl_whatsappConnections`;
  const ownHeaders = {
    Authorization: `Bearer ${tokens['connection-owner-a']}`,
    'Content-Type': 'application/json',
  };
  const otherHeaders = {
    Authorization: `Bearer ${tokens['connection-owner-b']}`,
    'Content-Type': 'application/json',
  };
  assert.equal((await fetch(`${base}/connection-owner-a`, { headers: otherHeaders })).status, 403);
  assert.equal((await fetch(base, { headers: ownHeaders })).status, 403);
  const document = (
    await db().collection('bpl_whatsappConnections').doc('connection-owner-a').get()
  ).data()!;
  const envelope = {
    ownerId: { stringValue: 'connection-owner-a' },
    version: { integerValue: '1' },
    iv: { stringValue: document.iv },
    ciphertext: { stringValue: document.ciphertext },
    createdAt: { timestampValue: document.createdAt.toDate().toISOString() },
    updatedAt: { timestampValue: new Date().toISOString() },
  };
  const cases = [
    { ...envelope, ownerId: { stringValue: 'connection-owner-b' } },
    { ...envelope, bplAdmin: { booleanValue: true } },
    { ...envelope, accessToken: { stringValue: input.accessToken } },
    { ...envelope, ciphertext: { stringValue: 'x'.repeat(16001) } },
    { ...envelope, version: { stringValue: '1' } },
    { ...envelope, createdAt: { timestampValue: new Date(0).toISOString() } },
    { ...envelope, updatedAt: { timestampValue: new Date(0).toISOString() } },
  ];
  for (const fields of cases) {
    const response = await fetch(`${base}/connection-owner-a`, {
      method: 'PATCH',
      headers: ownHeaders,
      body: JSON.stringify({ fields }),
    });
    assert.equal(response.status, 403);
  }
  const missing = { ...envelope } as Record<string, unknown>;
  delete missing.ciphertext;
  assert.equal(
    (
      await fetch(`${base}/connection-owner-a`, {
        method: 'PATCH',
        headers: ownHeaders,
        body: JSON.stringify({ fields: missing }),
      })
    ).status,
    403,
  );
});
