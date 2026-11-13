import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { deleteApp } from 'firebase-admin/app';
import { auth, db, adminApp } from '../lib/server/firebase';

process.env.FIREBASE_PROJECT_ID ||= process.env.GCLOUD_PROJECT;
if (
  process.env.FIREBASE_PROJECT_ID !== 'demo-bpl' ||
  !process.env.FIREBASE_AUTH_EMULATOR_HOST ||
  !process.env.FIRESTORE_EMULATOR_HOST
)
  throw new Error('Chat rule tests require the isolated demo-bpl Auth and Firestore emulators.');
const base = `http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/demo-bpl/databases/(default)/documents`;
const owner = 'rule-account-chat-owner';
const other = 'rule-account-chat-other';
const unverified = 'rule-account-chat-unverified';
const conversationId = 'a'.repeat(32);
const messageId = 'meta-' + 'b'.repeat(64);
const conversationPath = `bpl_customerWorkspaces/${owner}/conversations/${conversationId}`;
const messagePath = `${conversationPath}/messages/${messageId}`;
const inboxPath = `bpl_customerWorkspaces/${owner}/inboxStatus/webhook`;
const requestPath = `bpl_customerWorkspaces/${owner}/sendRequests/11111111-1111-4111-8111-111111111111`;
const tokens: Record<string, string> = {};
before(async () => {
  for (const uid of [owner, other, unverified]) {
    await auth().createUser({
      uid,
      email: `${uid}@example.test`,
      emailVerified: uid !== unverified,
      password: 'emulator-chat-rules-password',
    });
    const response = await fetch(
      `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=emulator-only`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: `${uid}@example.test`,
          password: 'emulator-chat-rules-password',
          returnSecureToken: true,
        }),
      },
    );
    tokens[uid] = (await response.json()).idToken;
    assert.ok(tokens[uid]);
  }
  await db().doc(conversationPath).set({
    id: conversationId,
    ownerId: owner,
    phone: '919876543219',
    customerName: 'Private emulator customer',
    lastMessagePreview: 'Private test message',
    lastMessageAt: new Date(),
    unreadCount: 1,
  });
  await db().doc(messagePath).set({
    ownerId: owner,
    body: 'Private test message',
    direction: 'inbound',
    status: 'received',
    createdAt: new Date(),
  });
  await db().doc(inboxPath).set({ status: 'configured', checkedAt: new Date() });
  await db().doc(requestPath).set({ ownerId: owner, status: 'queued' });
  await db()
    .doc(`bpl_customerWorkspaces/${unverified}/conversations/${conversationId}`)
    .set({ ownerId: unverified, phone: '919876543218' });
});
after(async () => {
  await deleteApp(adminApp());
});
function headers(uid?: string) {
  return {
    'Content-Type': 'application/json',
    ...(uid ? { Authorization: `Bearer ${tokens[uid]}` } : {}),
  };
}
async function read(path: string, uid?: string) {
  return fetch(`${base}/${path}`, { headers: headers(uid) });
}
async function denied(response: Response) {
  assert.equal(response.status, 403, await response.clone().text());
}
test('verified owners can read their private conversations, messages and inbox status only', async () => {
  for (const path of [conversationPath, messagePath, inboxPath]) {
    const response = await read(path, owner);
    assert.equal(response.status, 200, await response.clone().text());
    await denied(await read(path));
    await denied(await read(path, other));
    await denied(await read(path, unverified));
  }
  assert.equal((await read(`bpl_customerWorkspaces/${owner}/conversations`, owner)).status, 200);
  assert.equal((await read(`${conversationPath}/messages`, owner)).status, 200);
  await denied(await read(`bpl_customerWorkspaces/${owner}/conversations`, other));
  await denied(await read(`${conversationPath}/messages`, other));
  await denied(
    await read(`bpl_customerWorkspaces/${unverified}/conversations/${conversationId}`, unverified),
  );
  await denied(await read(requestPath, owner));
  await denied(await read(`bpl_customerWorkspaces/${owner}/sendRequests`, owner));
});
test('all client chat writes are denied even for verified owners and cannot forge delivery status', async () => {
  for (const path of [conversationPath, messagePath, inboxPath, requestPath]) {
    await denied(
      await fetch(`${base}/${path}`, {
        method: 'PATCH',
        headers: headers(owner),
        body: JSON.stringify({
          fields: { status: { stringValue: 'delivered' }, bplAdmin: { booleanValue: true } },
        }),
      }),
    );
    await denied(await fetch(`${base}/${path}`, { method: 'DELETE', headers: headers(owner) }));
  }
  const newMessage = `${conversationPath}/messages/request-22222222-2222-4222-8222-222222222222`;
  await denied(
    await fetch(base + ':commit', {
      method: 'POST',
      headers: headers(owner),
      body: JSON.stringify({
        writes: [
          {
            update: {
              name: `projects/demo-bpl/databases/(default)/documents/${newMessage}`,
              fields: {
                ownerId: { stringValue: owner },
                body: { stringValue: 'Forged outbound message' },
                status: { stringValue: 'sent' },
              },
            },
            currentDocument: { exists: false },
          },
        ],
      }),
    }),
  );
});
