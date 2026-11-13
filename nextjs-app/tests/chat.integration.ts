import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { deleteApp } from 'firebase-admin/app';
import { auth, adminApp, db } from '../lib/server/firebase';
import { encryptConnection, type ConnectionRecord } from '../lib/whatsapp-connection';
import { handleAccountChat, chatHash } from '../lib/account-chat-api';
import { handleWhatsAppWebhook } from '../lib/whatsapp-webhook';
import { clearServiceTokenCacheForTests } from '../lib/google-service-account';
import type { ChatEnvironment } from '../lib/chat-types';

process.env.FIREBASE_PROJECT_ID ||= process.env.GCLOUD_PROJECT;
if (
  process.env.FIREBASE_PROJECT_ID !== 'demo-bpl' ||
  !process.env.FIREBASE_AUTH_EMULATOR_HOST ||
  !process.env.FIRESTORE_EMULATOR_HOST
)
  throw new Error('Chat tests require isolated demo-bpl emulators.');
const owner = 'chat-owner-a',
  other = 'chat-owner-b';
const origin = 'https://lab.example.test';
const tokens: Record<string, string> = {};
const credentials: ConnectionRecord = {
  phone: '+916395951791',
  phoneNumberId: '123456789',
  businessAccountId: '987654321',
  appId: '555555555',
  accessToken: 'emulator-only-meta-access-token',
  appSecret: 'emulator-only-app-secret',
  verifyToken: 'emulator-only-webhook-token',
  verifiedAt: new Date().toISOString(),
  verifiedName: 'Emulator Lab',
};
let env: ChatEnvironment;
let id = '';
let metaCalls = 0;
let rejectMeta = false;
let earlyReceipt = false;
let lastMetaId = '';
const phone = '919876543216';
const transport = (async (url, init) => {
  const target = new URL(String(url));
  if (target.hostname === 'oauth2.googleapis.com')
    return Response.json({ access_token: 'owner', expires_in: 3600 });
  if (target.hostname === 'graph.facebook.com') {
    metaCalls++;
    assert.equal(init?.method, 'POST');
    assert.equal(target.pathname, '/v23.0/123456789/messages');
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      'Bearer ' + credentials.accessToken,
    );
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.to, phone);
    assert.equal(payload.type, 'text');
    if (rejectMeta)
      return Response.json(
        { error: { code: 190, message: credentials.accessToken } },
        { status: 401 },
      );
    lastMetaId = 'wamid.emulator.outbound.' + metaCalls;
    if (earlyReceipt)
      await webhook({
        statuses: [
          {
            id: lastMetaId,
            recipient_id: phone,
            status: 'delivered',
            timestamp: String(Math.floor(Date.now() / 1000)),
          },
        ],
      });
    return Response.json({ messages: [{ id: lastMetaId }] });
  }
  return fetch(url, init);
}) as typeof fetch;
function request(path = '', data?: unknown, uid = owner) {
  return new Request(origin + '/api/account/inbox' + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { origin, 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokens[uid] },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
}
async function webhook(
  change: Record<string, unknown>,
  secret = credentials.appSecret,
  phoneNumberId = credentials.phoneNumberId,
) {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          { field: 'messages', value: { metadata: { phone_number_id: phoneNumberId }, ...change } },
        ],
      },
    ],
  });
  const signature = createHmac('sha256', secret).update(body).digest('hex');
  return handleWhatsAppWebhook(
    new Request(origin + '/webhook/' + owner, {
      method: 'POST',
      headers: { 'x-hub-signature-256': 'sha256=' + signature },
      body,
    }),
    owner,
    env,
    transport,
  );
}
before(async () => {
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
  const key = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString(
    'base64',
  );
  env = {
    projectId: 'demo-bpl',
    apiKey: 'emulator-only',
    encryptionKey: 'd'.repeat(64),
    authOrigin: `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com`,
    firestoreOrigin: `http://${process.env.FIRESTORE_EMULATOR_HOST}`,
    serviceAccountJson: JSON.stringify({
      type: 'service_account',
      client_email: 'inbox@demo-bpl.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\n' + key + '\n-----END PRIVATE KEY-----\n',
    }),
    webhookBaseUrl: 'https://callback.example.test',
    webhookPublicReady: true,
  };
  for (const uid of [owner, other]) {
    await auth().createUser({
      uid,
      email: uid + '@example.test',
      emailVerified: true,
      password: 'emulator-only-password',
    });
    const response = await fetch(
      `${env.authOrigin}/v1/accounts:signInWithPassword?key=emulator-only`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: uid + '@example.test',
          password: 'emulator-only-password',
          returnSecureToken: true,
        }),
      },
    );
    tokens[uid] = (await response.json()).idToken;
    assert.ok(tokens[uid]);
  }
  const envelope = await encryptConnection(credentials, owner, env.encryptionKey);
  await db()
    .collection('bpl_whatsappConnections')
    .doc(owner)
    .set({ ownerId: owner, ...envelope, createdAt: new Date(), updatedAt: new Date() });
  id = (await chatHash(phone)).slice(0, 32);
  await db()
    .collection('bpl_customerWorkspaces')
    .doc(owner)
    .collection('customers')
    .doc(id)
    .set({
      ownerId: owner,
      id,
      name: 'Emulator Chat Customer',
      phone,
      createdAt: new Date(),
      groups: [],
      testIds: [],
      visits: 0,
      marketing: {
        status: 'opted_in',
        source: 'emulator fixture',
        at: new Date(),
        eventId: 'fixture-only',
      },
    });
});
after(async () => {
  await deleteApp(adminApp());
});
test('inbox is authenticated, owner isolated and truthful before any provider message', async () => {
  assert.equal(
    (await handleAccountChat(new Request(origin + '/api/account/inbox'), env, transport)).status,
    401,
  );
  const response = await handleAccountChat(request('/' + id), env, transport);
  assert.equal(response.status, 200, await response.clone().text());
  const detail = await response.json();
  assert.deepEqual(detail.messages, []);
  assert.equal(detail.recorded, false);
  assert.equal(detail.windowOpen, false);
  assert.equal(detail.configured, false);
  assert.equal(
    (await handleAccountChat(request('/' + id, undefined, other), env, transport)).status,
    404,
  );
  const list = await handleAccountChat(request('', undefined, other), env, transport);
  assert.deepEqual((await list.json()).conversations, []);
  assert.equal(
    (
      await handleAccountChat(
        request('/' + id + '/send', { text: 'No inbound window', requestId: crypto.randomUUID() }),
        env,
        transport,
      )
    ).status,
    503,
  );
  assert.equal(metaCalls, 0);
  const ignored = await webhook(
    {
      messages: [
        {
          id: 'wrong-phone-event',
          from: phone,
          timestamp: String(Math.floor(Date.now() / 1000)),
          type: 'text',
          text: { body: 'Ignored sender scope' },
        },
      ],
    },
    credentials.appSecret,
    '999999999',
  );
  assert.equal(ignored.status, 200);
  assert.equal(
    (
      await db()
        .collection('bpl_customerWorkspaces')
        .doc(owner)
        .collection('inboxStatus')
        .doc('webhook')
        .get()
    ).exists,
    false,
  );
});
test('callback verifies token/signature and records actual inbound messages idempotently', async () => {
  assert.equal(
    (
      await handleWhatsAppWebhook(
        new Request(origin + '/webhook/' + owner, { method: 'POST', body: '{}' }),
        owner,
        env,
        transport,
      )
    ).status,
    403,
  );
  const invalid = await handleWhatsAppWebhook(
    new Request(
      origin + '/webhook/' + owner + '?hub.mode=subscribe&hub.challenge=123&hub.verify_token=wrong',
    ),
    owner,
    env,
    transport,
  );
  assert.equal(invalid.status, 403);
  const verified = await handleWhatsAppWebhook(
    new Request(
      origin +
        '/webhook/' +
        owner +
        '?hub.mode=subscribe&hub.challenge=123&hub.verify_token=' +
        credentials.verifyToken,
    ),
    owner,
    env,
    transport,
  );
  assert.equal(await verified.text(), '123');
  const inbound = {
    messages: [
      {
        id: 'wamid.emulator.inbound.1',
        from: phone,
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: 'text',
        text: { body: 'Hello lab' },
      },
    ],
    contacts: [{ wa_id: phone, profile: { name: 'Customer' } }],
  };
  assert.equal((await webhook(inbound, 'wrong-secret')).status, 403);
  assert.equal((await webhook(inbound)).status, 200);
  assert.equal((await webhook(inbound)).status, 200);
  const detail = await (await handleAccountChat(request('/' + id), env, transport)).json();
  assert.equal(detail.messages.length, 1);
  assert.equal(detail.messages[0].status, 'received');
  assert.equal(detail.windowOpen, true);
  assert.equal(detail.configured, true);
  assert.equal(detail.conversation.unreadCount, 1);
  const hidden = JSON.stringify(detail);
  for (const secret of [credentials.accessToken, credentials.appSecret, credentials.verifyToken])
    assert.ok(!hidden.includes(secret));
});
test('API sends exactly once, records acceptance separately from delivery and reconciles early/out-of-order receipts', async () => {
  earlyReceipt = true;
  const input = { text: 'Your booking request is received.', requestId: crypto.randomUUID() };
  const sent = await handleAccountChat(request('/' + id + '/send', input), env, transport);
  assert.equal(sent.status, 201, await sent.clone().text());
  const message = (await sent.json()).message;
  assert.equal(message.status, 'delivered', 'Actual signed early receipt is preserved');
  const duplicate = await handleAccountChat(request('/' + id + '/send', input), env, transport);
  assert.equal(duplicate.status, 200);
  assert.equal(metaCalls, 1);
  for (const status of ['read', 'sent', 'failed'])
    assert.equal(
      (
        await webhook({
          statuses: [
            {
              id: lastMetaId,
              recipient_id: phone,
              status,
              timestamp: String(Math.floor(Date.now() / 1000)),
            },
          ],
        })
      ).status,
      200,
    );
  const detail = await (await handleAccountChat(request('/' + id), env, transport)).json();
  assert.equal(detail.messages.find((item: any) => item.metaId === lastMetaId).status, 'read');
  assert.equal(detail.messages.length, 2);
});
test('Meta token rejection is recorded as failed, and a signed STOP withdraws consent once', async () => {
  earlyReceipt = false;
  rejectMeta = true;
  const failed = await handleAccountChat(
    request('/' + id + '/send', { text: 'Testing rejected token', requestId: crypto.randomUUID() }),
    env,
    transport,
  );
  assert.equal(failed.status, 409, await failed.clone().text());
  const result = await failed.json();
  assert.equal(result.code, 'META_ACCESS_TOKEN_INVALID');
  assert.ok(!JSON.stringify(result).includes(credentials.accessToken));
  const stop = {
    messages: [
      {
        id: 'wamid.emulator.stop.1',
        from: phone,
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: 'text',
        text: { body: 'STOP' },
      },
    ],
  };
  assert.equal((await webhook(stop)).status, 200);
  assert.equal((await webhook(stop)).status, 200);
  const workspace = db().collection('bpl_customerWorkspaces').doc(owner);
  assert.equal(
    (await workspace.collection('customers').doc(id).get()).data()?.marketing.status,
    'opted_out',
  );
  assert.equal((await workspace.collection('consentEvents').get()).size, 1);
  const privateConfig = await handleAccountChat(
    request(),
    { ...env, webhookPublicReady: false },
    transport,
  );
  assert.equal((await privateConfig.json()).configured, false);
});

test('changing the connected sender cannot reuse another phone’s callback readiness or reply window', async () => {
  const changed = await encryptConnection(
    { ...credentials, phoneNumberId: '777777777' },
    owner,
    env.encryptionKey,
  );
  await db().collection('bpl_whatsappConnections').doc(owner).set(changed, { merge: true });
  const result = await handleAccountChat(request('/' + id), env, transport);
  assert.equal(result.status, 200);
  const detail = await result.json();
  assert.equal(detail.configured, false);
  assert.equal(detail.windowOpen, false);
});
