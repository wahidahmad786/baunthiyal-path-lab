import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { deleteApp } from 'firebase-admin/app';
import { auth, adminApp, db } from '../lib/server/firebase';
import {
  handleAccountCustomers,
  type AccountCustomerEnvironment,
} from '../lib/account-customers-api';

process.env.FIREBASE_PROJECT_ID ||= process.env.GCLOUD_PROJECT;
if (
  process.env.FIREBASE_PROJECT_ID !== 'demo-bpl' ||
  !process.env.FIREBASE_AUTH_EMULATOR_HOST ||
  !process.env.FIRESTORE_EMULATOR_HOST
)
  throw new Error(
    'Customer account tests require the isolated demo-bpl Auth and Firestore emulators.',
  );
const env: AccountCustomerEnvironment = {
  projectId: 'demo-bpl',
  apiKey: 'emulator-only',
  authOrigin: `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com`,
  firestoreOrigin: `http://${process.env.FIRESTORE_EMULATOR_HOST}`,
};
const origin = 'https://lab.example.test';
const tokens: Record<string, string> = {};
const input = {
  name: 'Emulator Customer',
  phone: '+91 98765 43218',
  age: 23,
  groups: ['BLOOD TEST'],
  marketingConsent: true,
  consentSource: 'customer agreed in person',
};
let registeredId = '';
before(async () => {
  for (const uid of ['customers-owner-a', 'customers-owner-b', 'customers-unverified']) {
    await auth().createUser({
      uid,
      email: `${uid}@example.test`,
      emailVerified: uid !== 'customers-unverified',
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
function request(uid?: string, data?: unknown, suffix = '', requestOrigin = origin) {
  return new Request(`${origin}/api/account/customers${suffix}`, {
    method: data === undefined ? 'GET' : 'POST',
    headers: {
      origin: requestOrigin,
      'Content-Type': 'application/json',
      ...(uid ? { Authorization: `Bearer ${tokens[uid]}` } : {}),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
}
const call = (uid?: string, data?: unknown, suffix = '') =>
  handleAccountCustomers(request(uid, data, suffix), env);

test('account registration saves actual customer and consent records, survives reload, and isolates Google accounts', async () => {
  assert.equal((await call()).status, 401);
  assert.equal((await call('customers-unverified', input)).status, 403);
  assert.equal(
    (
      await handleAccountCustomers(
        request('customers-owner-a', input, '', 'https://attacker.example'),
        env,
      )
    ).status,
    403,
  );
  const registered = await call('customers-owner-a', input);
  assert.equal(registered.status, 201, await registered.clone().text());
  const result = await registered.json();
  registeredId = result.id;
  assert.match(registeredId, /^[a-f0-9]{32}$/);
  assert.equal(result.customer.phone, '919876543218');
  assert.equal(result.customer.marketing.status, 'opted_in');
  const ref = db()
    .collection('bpl_customerWorkspaces')
    .doc('customers-owner-a')
    .collection('customers')
    .doc(registeredId);
  const stored = (await ref.get()).data()!;
  assert.equal(stored.ownerId, 'customers-owner-a');
  assert.equal(stored.createdAt.toMillis(), stored.marketing.at.toMillis());
  const event = await ref.parent
    .parent!.collection('consentEvents')
    .doc(stored.marketing.eventId)
    .get();
  assert.equal(event.data()?.customerId, registeredId);
  assert.equal(event.data()?.status, 'opted_in');
  const loaded = await call('customers-owner-a');
  assert.equal(loaded.status, 200, await loaded.clone().text());
  const list = await loaded.json();
  assert.equal(list.customers.length, 1);
  assert.equal(list.totalCustomers, 1);
  assert.equal(list.optedIn, 1);
  assert.equal(list.truncated, false);
  const outsider = await call('customers-owner-b');
  assert.equal(outsider.status, 200, await outsider.clone().text());
  assert.deepEqual((await outsider.json()).customers, []);
  assert.equal((await db().collection('bpl_customers').doc(registeredId).get()).exists, false);
  const duplicate = await call('customers-owner-a', { ...input, marketingConsent: false });
  assert.equal(duplicate.status, 409, await duplicate.clone().text());
  assert.equal((await ref.get()).data()?.marketing.status, 'opted_in');
  assert.equal((await ref.parent.parent!.collection('consentEvents').get()).size, 1);
});
test('explicit opt-out is audited atomically, reduces the eligible count, and cannot update another account’s audience', async () => {
  const suffix = `/${registeredId}/consent`;
  assert.equal(
    (
      await call(
        'customers-owner-a',
        { status: 'opted_out', source: 'customer request', confirmed: false },
        suffix,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        'customers-owner-b',
        { status: 'opted_out', source: 'customer request', confirmed: true },
        suffix,
      )
    ).status,
    404,
  );
  const changed = await call(
    'customers-owner-a',
    { status: 'opted_out', source: 'customer STOP request', confirmed: true },
    suffix,
  );
  assert.equal(changed.status, 200, await changed.clone().text());
  assert.equal((await changed.json()).customer.marketing.status, 'opted_out');
  const workspace = db().collection('bpl_customerWorkspaces').doc('customers-owner-a');
  const stored = (await workspace.collection('customers').doc(registeredId).get()).data()!;
  const audit = await workspace.collection('consentEvents').doc(stored.marketing.eventId).get();
  assert.equal(audit.data()?.status, 'opted_out');
  assert.equal(audit.data()?.actor, 'customers-owner-a');
  assert.equal(stored.createdAt.toMillis() < stored.marketing.at.toMillis(), true);
  assert.equal((await (await call('customers-owner-a')).json()).optedIn, 0);
  const noConsent = await call('customers-owner-a', {
    ...input,
    phone: '+91 98765 43217',
    marketingConsent: false,
  });
  assert.equal(noConsent.status, 201, await noConsent.clone().text());
  const second = await noConsent.json();
  assert.equal(second.customer.marketing.status, 'not_asked');
  const saved = (await workspace.collection('customers').doc(second.id).get()).data()!;
  assert.equal(saved.marketing.eventId, '');
  assert.equal((await workspace.collection('consentEvents').get()).size, 2);
});
