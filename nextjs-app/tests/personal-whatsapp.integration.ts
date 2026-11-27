import {
  ingestPersonalHistory,
  savePersonalHistoryChat,
  readPersonalHistory,
  personalMessageFrom,
  historyStatusPath,
} from '../lib/personal-history';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { deleteApp } from 'firebase-admin/app';
import { auth, adminApp, db } from '../lib/server/firebase';
import { ChatStore, chatHash, handleAccountChat } from '../lib/account-chat-api';
import { handleWhatsAppProvider } from '../lib/whatsapp-provider-api';
import { reserveProvider, lockProvider, providerDocument } from '../lib/whatsapp-provider';
import { PersonalAuthStore } from '../lib/personal-auth';
import { recordPersonalMessage, recordPersonalReceipt } from '../lib/personal-events';
import { handleWhatsAppConnection } from '../lib/whatsapp-connection-api';
import { handleTemplateManager } from '../lib/template-manager-api';
import { handleConnectionHealth } from '../lib/connection-health-api';
import { encryptConnection } from '../lib/whatsapp-connection';
import type { ChatEnvironment } from '../lib/chat-types';
process.env.FIREBASE_PROJECT_ID ||= process.env.GCLOUD_PROJECT;
if (
  process.env.FIREBASE_PROJECT_ID !== 'demo-bpl' ||
  !process.env.FIRESTORE_EMULATOR_HOST ||
  !process.env.FIREBASE_AUTH_EMULATOR_HOST
)
  throw new Error('Isolated emulators required.');
const owner = 'personal-owner',
  other = 'personal-other',
  legacy = 'personal-legacy',
  race = 'personal-race';
const origin = 'https://lab.example.test',
  phone = '919876543217';
let env: ChatEnvironment,
  store: ChatStore,
  id: string,
  sends = 0;
const tokens: Record<string, string> = {};
const transport = (async (input, init) => {
  const host = new URL(String(input)).hostname;
  if (host === 'oauth2.googleapis.com')
    return Response.json({ access_token: 'owner', expires_in: 3600 });
  assert.ok(
    ['localhost', '127.0.0.1'].includes(host),
    'No real WhatsApp/Meta calls in integration tests',
  );
  return fetch(input, init);
}) as typeof fetch;
function req(path: string, body?: unknown, uid = owner) {
  return new Request(origin + '/api/' + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: 'Bearer ' + tokens[uid],
      Origin: origin,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
function root(uid = owner) {
  return db().doc(`bpl_customerWorkspaces/${uid}`);
}
before(async () => {
  env = {
    projectId: 'demo-bpl',
    apiKey: 'test-only',
    encryptionKey: 'c'.repeat(64),
    appOrigin: origin,
    authOrigin: `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com`,
    firestoreOrigin: `http://${process.env.FIRESTORE_EMULATOR_HOST}`,
    serviceAccountJson: JSON.stringify({
      type: 'service_account',
      client_email: 'personal@demo-bpl.iam.gserviceaccount.com',
      private_key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
        type: 'pkcs8',
        format: 'pem',
      }),
    }),
  };
  for (const uid of [owner, other, legacy, race]) {
    await auth().createUser({
      uid,
      email: uid + '@example.test',
      emailVerified: true,
      password: 'synthetic-emulator-password',
    });
    const response = await fetch(`${env.authOrigin}/v1/accounts:signInWithPassword?key=test-only`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: uid + '@example.test',
        password: 'synthetic-emulator-password',
        returnSecureToken: true,
      }),
    });
    tokens[uid] = (await response.json()).idToken;
  }
  store = await ChatStore.open(env, owner, transport, tokens[owner], true);
  id = (await chatHash(phone)).slice(0, 32);
});
after(async () => {
  (globalThis as any).bplPersonalRuntime?.sessions.delete(owner);
  await deleteApp(adminApp());
});
test('Google accounts get separate choices; a connected choice is immutable through server APIs', async () => {
  assert.equal(
    (await (await handleWhatsAppProvider(req('whatsapp/provider'), env, transport)).json()).mode,
    null,
  );
  await reserveProvider(store, 'personal');
  await lockProvider(store, 'personal', '+916395951791');
  assert.equal(
    (
      await handleWhatsAppProvider(
        req('whatsapp/provider', { action: 'select-meta' }),
        env,
        transport,
      )
    ).status,
    409,
  );
  assert.equal(
    (await handleWhatsAppProvider(req('whatsapp/provider', { action: 'cancel' }), env, transport))
      .status,
    409,
  );
  assert.equal(
    (await handleWhatsAppConnection(req('whatsapp/integration', {}), env, transport)).status,
    409,
  );
  assert.equal((await handleTemplateManager(req('account/templates'), env, transport)).status, 409);
  assert.equal(
    (
      await (
        await handleWhatsAppProvider(req('whatsapp/provider', undefined, other), env, transport)
      ).json()
    ).mode,
    null,
  );
});
test('legacy verified Meta accounts remain Meta; simultaneous provider selection has only one winner', async () => {
  const record = {
    phone: '+919876543210',
    phoneNumberId: '12345678',
    businessAccountId: '87654321',
    appId: '55555555',
    accessToken: 'test-only-access-token',
    appSecret: 'test-only-app-secret',
    verifyToken: '',
    verifiedAt: new Date().toISOString(),
    verifiedName: 'Test',
  };
  await db()
    .doc(`bpl_whatsappConnections/${legacy}`)
    .set(await encryptConnection(record, legacy, env.encryptionKey));
  const metaStore = await ChatStore.open(env, legacy, transport, tokens[legacy], true);
  assert.equal((await providerDocument(metaStore))?.data.mode, 'meta');
  await assert.rejects(reserveProvider(metaStore, 'personal'), /already uses/);
  const racingStore = await ChatStore.open(env, race, transport, tokens[race], true);
  const results = await Promise.allSettled([
    reserveProvider(racingStore, 'meta'),
    reserveProvider(racingStore, 'personal'),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
});
test('encrypted Signal-key storage survives recreation, stays private and rejects cross-account copies', async () => {
  const serialize = (v: unknown) => JSON.stringify(v),
    parse = (v: string) => JSON.parse(v);
  const first = new PersonalAuthStore(store, serialize, parse);
  await first.write({
    creds: { privateKey: 'sensitive-signal-session', registered: true },
    'key:session:1': { chain: 'private-chain' },
  });
  const recreated = new PersonalAuthStore(
    await ChatStore.open(env, owner, transport, tokens[owner], true),
    serialize,
    parse,
  );
  assert.equal((await recreated.read('creds')).privateKey, 'sensitive-signal-session');
  const path = await first.path('creds'),
    stored = (await root().collection('personalAuth').get()).docs;
  assert.ok(!JSON.stringify(stored.map((d) => d.data())).includes('sensitive-signal-session'));
  const copied = (
    await root().collection('personalAuth').doc(path.split('/').pop()!).get()
  ).data()!;
  await root(other).collection('personalAuth').doc(path.split('/').pop()!).set(copied);
  const second = new PersonalAuthStore(
    await ChatStore.open(env, other, transport, tokens[other], true),
    serialize,
    parse,
  );
  await assert.rejects(second.read('creds'));
  await root()
    .collection('personalStatus')
    .doc('current')
    .set({ status: 'relink_required', message: 'Test-only offline fixture' });
  const publicResult = await (
    await handleWhatsAppProvider(req('whatsapp/provider'), env, transport)
  ).json();
  assert.ok(!JSON.stringify(publicResult).includes('ciphertext'));
  const direct = await fetch(
    `${env.firestoreOrigin}/v1/projects/demo-bpl/databases/(default)/documents/${store.root}/${path}`,
    { headers: { Authorization: `Bearer ${tokens[owner]}` } },
  );
  assert.equal(direct.status, 403);
});
test('actual linked inbound events are deduplicated; only new STOP messages update audited consent', async () => {
  const at = new Date().toISOString();
  await root()
    .collection('customers')
    .doc(id)
    .set({
      id,
      ownerId: owner,
      name: 'Fixture customer',
      phone,
      marketing: { status: 'opted_in', at, source: 'fixture' },
    });
  const event = {
    phone,
    providerId: 'inbound-1',
    text: 'Hello',
    outbound: false,
    at,
    status: 'received' as const,
    allowOptOut: true,
  };
  await recordPersonalMessage(store, event);
  await recordPersonalMessage(store, event);
  assert.equal((await root().collection('conversations').doc(id).get()).data()?.unreadCount, 1);
  await recordPersonalMessage(store, {
    ...event,
    providerId: 'old-stop',
    text: 'STOP',
    allowOptOut: false,
  });
  assert.equal(
    (await root().collection('customers').doc(id).get()).data()?.marketing.status,
    'opted_in',
  );
  await recordPersonalMessage(store, { ...event, providerId: 'new-stop', text: 'STOP' });
  assert.equal(
    (await root().collection('customers').doc(id).get()).data()?.marketing.status,
    'opted_out',
  );
  assert.equal((await root().collection('consentEvents').get()).size, 1);
  await root()
    .collection('customers')
    .doc(id)
    .update({
      marketing: {
        status: 'opted_in',
        at: new Date(Date.now() + 1000).toISOString(),
        source: 'new-explicit-consent',
      },
    });
  await recordPersonalMessage(store, { ...event, providerId: 'new-stop', text: 'STOP' });
  await recordPersonalMessage(store, { ...event, providerId: 'late-older-stop', text: 'STOP' });
  assert.equal(
    (await root().collection('customers').doc(id).get()).data()?.marketing.status,
    'opted_in',
  );
});
test('linked inbox sends once without a Meta reply window; early delivery receipts stay truthful', async () => {
  const leaseId = 'synthetic-test-lease';
  await root()
    .collection('personalStatus')
    .doc('lease')
    .set({ holder: leaseId, expiresAt: new Date(Date.now() + 120000).toISOString() });
  (globalThis as any).bplPersonalRuntime.sessions.set(owner, {
    store,
    leaseId,
    state: {
      status: 'connected',
      phone: '+916395951791',
      message: 'Test transport connected',
      qr: null,
      pairingCode: null,
    },
    socket: {
      sendMessage: async (_jid: string, _content: unknown, options: any) => {
        sends++;
        await recordPersonalReceipt(store, phone, options.messageId, 'delivered');
        return { key: { id: options.messageId } };
      },
    },
  });
  await root()
    .collection('conversations')
    .doc(id)
    .update({ lastInboundAt: new Date(Date.now() - 48 * 3600000).toISOString() });
  const detail = await (await handleAccountChat(req(`account/inbox/${id}`), env, transport)).json();
  assert.equal(detail.provider, 'personal');
  assert.equal(detail.windowOpen, true);
  assert.equal(detail.configured, true);
  const payload = { text: 'Human reply from linked inbox', requestId: randomUUID() };
  const first = await handleAccountChat(req(`account/inbox/${id}/send`, payload), env, transport);
  assert.equal(first.status, 201, JSON.stringify(await first.clone().json()));
  assert.equal((await first.json()).message.status, 'delivered');
  assert.equal(
    (await handleAccountChat(req(`account/inbox/${id}/send`, payload), env, transport)).status,
    200,
  );
  assert.equal(sends, 1);
  assert.equal(
    (await handleAccountChat(req(`account/inbox/${id}`, undefined, other), env, transport)).status,
    404,
  );
  const health = await (
    await handleConnectionHealth(req('account/connection-health'), env, transport)
  ).json();
  assert.equal(health.state, 'healthy');
});

test('real-shaped phone history loads chats and encrypted messages without registering contacts or changing marketing consent', async () => {
  const b = await import('@whiskeysockets/baileys');
  const number = '919876543218',
    contactId = (await chatHash(number)).slice(0, 32),
    baseSeconds = Math.floor(Date.now() / 1000) - 100000;
  const records = Array.from({ length: 130 }, (_, i) => ({
    key: { id: 'history-' + i, remoteJid: `${number}@s.whatsapp.net`, fromMe: i % 2 === 0 },
    messageTimestamp: baseSeconds + i,
    message: { conversation: i === 1 ? 'STOP' : 'Phone history ' + i },
    ...(i % 2 === 0 ? { status: 3 } : {}),
  }));
  const batch = {
    contacts: [{ id: `${number}@s.whatsapp.net`, name: 'Phone contact name' }],
    chats: [{ id: `${number}@s.whatsapp.net`, unreadCount: 4 }],
    messages: records,
  };
  const resolve = async (k: any) =>
    k.remoteJid?.endsWith('@s.whatsapp.net') ? k.remoteJid.split('@')[0] : null;
  const imported = await ingestPersonalHistory(
    store,
    batch as any,
    resolve,
    b.normalizeMessageContent,
  );
  assert.equal(imported.chats, 1);
  assert.equal(imported.messages, 130);
  await ingestPersonalHistory(store, batch as any, resolve, b.normalizeMessageContent);
  assert.equal((await root().collection('customers').doc(contactId).get()).exists, false);
  assert.equal(
    (await root().collection('conversations').doc(contactId).get()).data()?.unreadCount,
    4,
  );
  assert.equal(
    (await root().collection('conversations').doc(contactId).get()).data()?.customerName,
    'Phone contact name',
  );
  const raw = (await root().collection('personalHistory').doc(contactId).get()).data();
  assert.ok(!JSON.stringify(raw).includes('Phone history'));
  const result = await (
    await handleAccountChat(req(`account/inbox/${contactId}`), env, transport)
  ).json();
  assert.equal(result.messages.length, 100);
  assert.ok(result.nextBefore);
  assert.equal(result.messages.at(-1).text, 'Phone history 129');
  const prior = await (
    await handleAccountChat(
      req(`account/inbox/${contactId}?before=${encodeURIComponent(result.nextBefore)}`),
      env,
      transport,
    )
  ).json();
  assert.equal(prior.messages.length, 30);
  assert.equal(prior.nextBefore, null);
  assert.ok(!result.messages.some((m: any) => prior.messages.some((x: any) => x.id === m.id)));
  const cached = await (
    await handleAccountChat(
      req(`account/inbox/${contactId}?revision=${encodeURIComponent(result.revision)}`),
      env,
      transport,
    )
  ).json();
  assert.equal(cached.unchanged, true);
  assert.ok(!cached.messages);
  const first = await (await handleAccountChat(req('account/inbox'), env, transport)).json();
  const cachedInbox = await (
    await handleAccountChat(
      req(`account/inbox?revision=${encodeURIComponent(first.revision)}`),
      env,
      transport,
    )
  ).json();
  assert.equal(cachedInbox.unchanged, true);
  assert.ok(!cachedInbox.conversations);
  const privateRead = await fetch(
    `${env.firestoreOrigin}/v1/projects/demo-bpl/databases/(default)/documents/${store.root}/personalHistory/${contactId}`,
    { headers: { Authorization: `Bearer ${tokens[owner]}` } },
  );
  assert.equal(privateRead.status, 403);
  const otherStore = await ChatStore.open(env, other, transport, tokens[other], true);
  assert.deepEqual(await readPersonalHistory(otherStore, contactId), {
    messages: [],
    clipped: false,
  });
  const beforeEvents = (await root().collection('consentEvents').get()).size;
  assert.equal((await root().collection('consentEvents').get()).size, beforeEvents);
  await recordPersonalReceipt(store, number, 'history-128', 'read');
  const read = await (
    await handleAccountChat(req(`account/inbox/${contactId}`), env, transport)
  ).json();
  assert.equal(read.messages.find((m: any) => m.text === 'Phone history 128').status, 'read');
});
test('new personal chats do not auto-send or opt customers in, and phone sync requests are real protocol requests rather than fabricated completion', async () => {
  const before = sends,
    number = '919876543219';
  const started = await handleAccountChat(
    req('account/inbox/start', { phone: '+' + number, name: 'New phone recipient' }),
    env,
    transport,
  );
  assert.equal(started.status, 201);
  const { conversation } = await started.json();
  assert.equal(sends, before);
  assert.equal((await root().collection('customers').doc(conversation.id).get()).exists, false);
  assert.equal(
    (await handleAccountChat(req('account/inbox/start', { phone: 'not a phone' }), env, transport))
      .status,
    400,
  );
  assert.equal(
    (
      await handleAccountChat(
        req(`account/inbox/${conversation.id}`, undefined, other),
        env,
        transport,
      )
    ).status,
    404,
  );
  const session = (globalThis as any).bplPersonalRuntime.sessions.get(owner);
  let requests = 0;
  session.socket.sendPeerDataOperationMessage = async (payload: any) => {
    requests++;
    assert.equal(payload.peerDataOperationRequestType, 6);
    assert.ok(payload.fullHistorySyncOnDemandRequest.requestMetadata.requestId);
    return 'actual-fixture-request-id';
  };
  const response = await handleAccountChat(req('account/inbox/sync', {}), env, transport);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.history.phase, 'requested');
  assert.notEqual(result.history.progress, 100);
  assert.equal(requests, 1);
  assert.equal(
    (await handleAccountChat(req('account/inbox/sync', {}), env, transport)).status,
    429,
  );
  assert.equal(requests, 1);
  const changed = await (await handleAccountChat(req('account/inbox'), env, transport)).json();
  assert.ok(changed.conversations.some((c: any) => c.id === conversation.id));
});

test('live personal messages paginate across timestamp ties and shared inbox roles cannot request owner history or send as a viewer', async () => {
  const number = '919876543221';
  const open = await (
    await handleAccountChat(req('account/inbox/start', { phone: '+' + number }), env, transport)
  ).json();
  const cid = open.conversation.id;
  const timestamp = new Date(Date.now() - 3600000).toISOString(),
    batch = db().batch();
  for (let i = 0; i < 130; i++) {
    const mid = 'personal-' + i.toString(16).padStart(64, '0');
    batch.set(root().collection('conversations').doc(cid).collection('messages').doc(mid), {
      id: mid,
      direction: 'inbound',
      type: 'text',
      text: 'Live ' + i,
      status: 'received',
      createdAt: new Date(timestamp),
    });
  }
  await batch.commit();
  const page1 = await (await handleAccountChat(req(`account/inbox/${cid}`), env, transport)).json();
  assert.equal(page1.messages.length, 100);
  const page2Response = await handleAccountChat(
    req(`account/inbox/${cid}?before=${encodeURIComponent(page1.nextBefore)}`),
    env,
    transport,
  );
  assert.equal(page2Response.status, 200);
  const page2 = await page2Response.json();
  assert.equal(page2.messages.length, 30);
  assert.equal(new Set([...page1.messages, ...page2.messages].map((m: any) => m.id)).size, 130);
  await root()
    .collection('teamMembers')
    .doc(other)
    .set({ email: other + '@example.test', role: 'viewer', active: true });
  assert.equal(
    (
      await handleAccountChat(
        req(`account/inbox/${cid}?workspace=${owner}`, undefined, other),
        env,
        transport,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await handleAccountChat(
        req(`account/inbox/start?workspace=${owner}`, { phone: '+919876543222' }, other),
        env,
        transport,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await handleAccountChat(
        req(`account/inbox/sync?workspace=${owner}`, {}, other),
        env,
        transport,
      )
    ).status,
    403,
  );
  await root().collection('teamMembers').doc(other).update({ role: 'staff' });
  assert.equal(
    (
      await handleAccountChat(
        req(`account/inbox/sync?workspace=${owner}`, {}, other),
        env,
        transport,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await handleAccountChat(
        req(`account/inbox/start?workspace=${owner}`, { phone: '+919876543222' }, other),
        env,
        transport,
      )
    ).status,
    201,
  );
  await root().collection('teamMembers').doc(other).update({ active: false });
  assert.equal(
    (
      await handleAccountChat(
        req(`account/inbox/${cid}?workspace=${owner}`, undefined, other),
        env,
        transport,
      )
    ).status,
    403,
  );
});

test('long phone histories stay within private snapshot limits and report clipping rather than claiming a full archive', async () => {
  const number = '919876543223',
    cid = (await chatHash(number)).slice(0, 32),
    messages = [];
  for (let i = 0; i < 510; i++)
    messages.push({
      id: 'personal-' + i.toString(16).padStart(64, '0'),
      personalId: 'long-' + i,
      source: 'phone_history' as const,
      direction: 'inbound' as const,
      type: 'text' as const,
      status: 'received' as const,
      text: 'X'.repeat(4096),
      createdAt: new Date(Date.now() - 1000000 + i * 1000).toISOString(),
    });
  await savePersonalHistoryChat(store, number, 'Long history', messages);
  const saved = await readPersonalHistory(store, cid);
  assert.equal(saved.clipped, true);
  assert.ok(saved.messages.length < 500);
  assert.ok(Buffer.byteLength(JSON.stringify(saved.messages)) <= 520000);
  assert.equal(saved.messages.at(-1)?.personalId, 'long-509');
});
