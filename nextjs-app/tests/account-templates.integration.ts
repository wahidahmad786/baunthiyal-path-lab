import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { deleteApp } from 'firebase-admin/app';
import { auth, adminApp, db } from '../lib/server/firebase';
import {
  handleWhatsAppConnection,
  type ConnectionEnvironment,
} from '../lib/whatsapp-connection-api';
import { encryptConnection, type ConnectionRecord } from '../lib/whatsapp-connection';

process.env.FIREBASE_PROJECT_ID ||= process.env.GCLOUD_PROJECT;
if (
  process.env.FIREBASE_PROJECT_ID !== 'demo-bpl' ||
  !process.env.FIREBASE_AUTH_EMULATOR_HOST ||
  !process.env.FIRESTORE_EMULATOR_HOST
)
  throw new Error(
    'Account template tests require the isolated demo-bpl Auth and Firestore emulators.',
  );
const env: ConnectionEnvironment = {
  projectId: 'demo-bpl',
  apiKey: 'emulator-only',
  encryptionKey: 'c'.repeat(64),
  authOrigin: `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com`,
  firestoreOrigin: `http://${process.env.FIRESTORE_EMULATOR_HOST}`,
  graphVersion: 'v23.0',
};
const owner = 'account-templates-owner';
const unverifiedConnection = 'account-templates-unverified-connection';
const missingConnection = 'account-templates-no-connection';
const unverifiedEmail = 'account-templates-unverified-email';
const tokens: Record<string, string> = {};
const credentials: ConnectionRecord = {
  phone: '+916395951791',
  phoneNumberId: '123456789',
  businessAccountId: '987654321',
  appId: '555555555',
  accessToken: 'emulator-account-template-owner-access-token',
  appSecret: 'emulator-template-app-secret',
  verifyToken: 'emulator-template-webhook-secret',
  verifiedAt: new Date().toISOString(),
  verifiedName: 'Baunthiyal Path Lab',
};
const approved = {
  id: '101010101',
  name: 'bpl_wellness_offer',
  language: 'en',
  status: 'APPROVED',
  category: 'MARKETING',
  components: [
    {
      type: 'BODY',
      text: 'Hello {{customer_name}}, Baunthiyal Path Lab. Your Health, Our Priority. Book {{booking_link}}. Reply STOP to opt out.',
    },
  ],
};
before(async () => {
  for (const uid of [owner, unverifiedConnection, missingConnection, unverifiedEmail]) {
    await auth().createUser({
      uid,
      email: `${uid}@example.test`,
      emailVerified: uid !== unverifiedEmail,
      password: 'emulator-template-password',
    });
    const signedIn = await fetch(
      `${env.authOrigin}/v1/accounts:signInWithPassword?key=emulator-only`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: `${uid}@example.test`,
          password: 'emulator-template-password',
          returnSecureToken: true,
        }),
      },
    );
    tokens[uid] = (await signedIn.json()).idToken;
    assert.ok(tokens[uid]);
  }
  for (const uid of [owner, unverifiedConnection]) {
    const record =
      uid === owner
        ? credentials
        : { ...credentials, accessToken: 'another-owner-secret-token', verifiedAt: null };
    const envelope = await encryptConnection(record, uid, env.encryptionKey);
    await db()
      .collection('bpl_whatsappConnections')
      .doc(uid)
      .set({ ownerId: uid, ...envelope, createdAt: new Date(), updatedAt: new Date() });
  }
});
after(async () => {
  await deleteApp(adminApp());
});
function request(uid?: string, method = 'GET') {
  return new Request('https://lab.example.test/api/whatsapp/integration/templates', {
    method,
    headers: {
      origin: 'https://lab.example.test',
      ...(uid ? { Authorization: `Bearer ${tokens[uid]}` } : {}),
    },
  });
}
function metaTransport(data: unknown, status = 200, paths: string[] = []) {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = new URL(String(url));
    if (target.hostname !== 'graph.facebook.com') return fetch(url, init);
    paths.push(target.pathname);
    assert.equal(init?.method || 'GET', 'GET', 'Template inspection must never send a message');
    assert.equal(target.pathname, '/v23.0/987654321/message_templates');
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      `Bearer ${credentials.accessToken}`,
    );
    assert.equal(target.searchParams.get('appsecret_proof')?.length, 64);
    return Response.json(data, { status });
  }) as typeof fetch;
}
test('account template endpoint requires authentication and each caller’s own verified connection', async () => {
  const calls: string[] = [];
  const send = metaTransport({ data: [approved] }, 200, calls);
  assert.equal((await handleWhatsAppConnection(request(), env, send)).status, 401);
  assert.equal((await handleWhatsAppConnection(request(unverifiedEmail), env, send)).status, 403);
  const missing = await handleWhatsAppConnection(request(missingConnection), env, send);
  assert.equal(missing.status, 409);
  assert.equal((await missing.json()).code, 'WHATSAPP_NOT_CONNECTED');
  const unverified = await handleWhatsAppConnection(request(unverifiedConnection), env, send);
  assert.equal(unverified.status, 409);
  assert.equal((await unverified.json()).code, 'WHATSAPP_NOT_VERIFIED');
  assert.equal((await handleWhatsAppConnection(request(owner, 'POST'), env, send)).status, 405);
  assert.deepEqual(calls, []);
});
test('verified account template endpoint reads actual stored credentials and returns only real supported templates', async () => {
  const before = (
    await db().collection('bpl_whatsappConnections').doc(owner).get()
  ).updateTime!.toMillis();
  const calls: string[] = [];
  const response = await handleWhatsAppConnection(
    request(owner),
    env,
    metaTransport(
      {
        data: [
          approved,
          { ...approved, id: '202020202', status: 'PENDING' },
          { ...approved, id: '303030303', category: 'UTILITY' },
          {
            ...approved,
            id: '404040404',
            components: [{ type: 'HEADER', format: 'VIDEO' }, ...approved.components],
          },
        ],
      },
      200,
      calls,
    ),
  );
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json();
  assert.equal(result.templates.length, 1);
  assert.equal(result.templates[0].id, approved.id);
  assert.equal(result.approvedMarketing, 2);
  assert.equal(result.unsupported, 1);
  assert.ok(Array.isArray(result.reasons));
  const returned = JSON.stringify(result);
  for (const secret of [
    credentials.accessToken,
    credentials.appSecret,
    credentials.verifyToken,
    'ciphertext',
  ])
    assert.ok(!returned.includes(secret));
  assert.deepEqual(calls, ['/v23.0/987654321/message_templates']);
  assert.equal(
    (await db().collection('bpl_whatsappConnections').doc(owner).get()).updateTime!.toMillis(),
    before,
    'Template reads must not mutate stored connection',
  );
});
test('template endpoint exposes safe actionable Meta errors without tokens or fabricated fallback entries', async () => {
  for (const code of [190, 102, 104]) {
    const expired = await handleWhatsAppConnection(
      request(owner),
      env,
      metaTransport({ error: { code, message: credentials.accessToken } }, 401),
    );
    assert.equal(expired.status, 409);
    const error = await expired.json();
    assert.equal(error.code, 'META_ACCESS_TOKEN_INVALID');
    assert.ok(!JSON.stringify(error).includes(credentials.accessToken));
    assert.ok(!('templates' in error));
  }
  const empty = await handleWhatsAppConnection(request(owner), env, metaTransport({ data: [] }));
  assert.equal(empty.status, 200);
  const result = await empty.json();
  assert.deepEqual(result.templates, []);
  assert.equal(result.approvedMarketing, 0);
});
test('failed token verification preserves the saved connection and returns a provider conflict rather than logging out Firebase', async () => {
  const before = (
    await db().collection('bpl_whatsappConnections').doc(owner).get()
  ).updateTime!.toMillis();
  const { verifiedAt: _verifiedAt, verifiedName: _verifiedName, ...input } = credentials;
  const response = await handleWhatsAppConnection(
    new Request('https://lab.example.test/api/whatsapp/integration', {
      method: 'POST',
      headers: {
        origin: 'https://lab.example.test',
        Authorization: `Bearer ${tokens[owner]}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...input, verify: true }),
    }),
    env,
    (async (url, init) => {
      const target = new URL(String(url));
      if (target.hostname !== 'graph.facebook.com') return fetch(url, init);
      assert.equal(init?.method || 'GET', 'GET');
      assert.ok(target.pathname.endsWith('/phone_numbers'));
      return Response.json(
        { error: { code: 190, message: credentials.accessToken } },
        { status: 401 },
      );
    }) as typeof fetch,
  );
  assert.equal(response.status, 409);
  const result = await response.json();
  assert.equal(result.code, 'META_ACCESS_TOKEN_INVALID');
  assert.ok(!JSON.stringify(result).includes(credentials.accessToken));
  assert.equal(
    (await db().collection('bpl_whatsappConnections').doc(owner).get()).updateTime!.toMillis(),
    before,
  );
});
