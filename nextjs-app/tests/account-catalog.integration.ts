import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { deleteApp } from 'firebase-admin/app';
import { auth, adminApp, db } from '../lib/server/firebase';
import { handleAccountCatalog, type AccountCatalogEnvironment } from '../lib/account-catalog-api';
import { REFERENCE_TESTS } from '../lib/test-reference';
process.env.FIREBASE_PROJECT_ID ||= process.env.GCLOUD_PROJECT;
if (
  process.env.FIREBASE_PROJECT_ID !== 'demo-bpl' ||
  !process.env.FIREBASE_AUTH_EMULATOR_HOST ||
  !process.env.FIRESTORE_EMULATOR_HOST
)
  throw new Error('Catalog tests require the isolated demo-bpl emulators.');
const env: AccountCatalogEnvironment = {
  projectId: 'demo-bpl',
  apiKey: 'emulator-only',
  authOrigin: `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com`,
  firestoreOrigin: `http://${process.env.FIRESTORE_EMULATOR_HOST}`,
};
const origin = 'https://lab.example.test';
const tokens: Record<string, string> = {};
let createdAt = 0;
before(async () => {
  for (const uid of ['catalog-owner-a', 'catalog-owner-b', 'catalog-unverified']) {
    await auth().createUser({
      uid,
      email: `${uid}@example.test`,
      emailVerified: uid !== 'catalog-unverified',
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
const request = (uid?: string, path = '/catalog', body?: unknown) =>
  new Request(`${origin}/api/account${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      origin,
      'Content-Type': 'application/json',
      ...(uid ? { Authorization: `Bearer ${tokens[uid]}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const call = (uid?: string, path = '/catalog', body?: unknown) =>
  handleAccountCatalog(request(uid, path, body), env);
const workspace = () => db().collection('bpl_customerWorkspaces').doc('catalog-owner-a');
test('reference tests import once with no fabricated prices and editable rates survive repeated import', async () => {
  assert.equal((await call()).status, 401);
  assert.equal((await call('catalog-unverified', '/catalog/import-reference', {})).status, 403);
  const imported = await call('catalog-owner-a', '/catalog/import-reference', {});
  assert.equal(imported.status, 200, await imported.clone().text());
  assert.equal((await imported.json()).imported, REFERENCE_TESTS.length);
  const listed = await call('catalog-owner-a');
  assert.equal(listed.status, 200, await listed.clone().text());
  const data = await listed.json();
  assert.equal(data.totalTests, REFERENCE_TESTS.length);
  assert.equal(data.pricedTests, 0);
  assert.equal(data.tests.length, Math.min(1000, REFERENCE_TESTS.length));
  assert.ok(data.tests.every((test: { price: number | null }) => test.price === null));
  const ref = REFERENCE_TESTS[0];
  const original = (await workspace().collection('tests').doc(ref.id).get()).data()!;
  createdAt = original.createdAt.toMillis();
  const edited = await call('catalog-owner-a', '/catalog', {
    id: ref.id,
    name: 'My rate-verified lab test',
    type: 'test',
    price: 149900,
    category: ref.category,
    aliases: [...ref.aliases],
  });
  assert.equal(edited.status, 200, await edited.clone().text());
  const again = await call('catalog-owner-a', '/catalog/import-reference', {});
  assert.equal(again.status, 200, await again.clone().text());
  const result = await again.json();
  assert.equal(result.imported, 0);
  assert.equal(result.skipped, REFERENCE_TESTS.length);
  const saved = (await workspace().collection('tests').doc(ref.id).get()).data()!;
  assert.equal(saved.price, 149900);
  assert.equal(saved.name, 'My rate-verified lab test');
  assert.equal(saved.createdAt.toMillis(), createdAt);
  const outsider = await call('catalog-owner-b');
  assert.equal(outsider.status, 200, await outsider.clone().text());
  assert.deepEqual((await outsider.json()).tests, []);
});
test('offer creation requires selected own tests with positive real rates and saves calculated discount and unique ID', async () => {
  const offer = {
    title: 'Full health review',
    description: 'A promotional offer with verified catalog pricing',
    type: 'Full Body Checkup',
    discountType: 'fixed',
    discountValue: 50000,
    originalPrice: 149900,
    startsAt: '2026-01-01T00:00:00Z',
    expiresAt: '2026-02-01T00:00:00Z',
    testIds: [REFERENCE_TESTS[0].id],
    eligibility: 'all',
  };
  assert.equal((await call('catalog-owner-b', '/offers', offer)).status, 400);
  assert.equal(
    (await call('catalog-owner-a', '/offers', { ...offer, testIds: [REFERENCE_TESTS[1].id] }))
      .status,
    400,
  );
  assert.equal(
    (await call('catalog-owner-a', '/offers', { ...offer, originalPrice: 159900 })).status,
    400,
  );
  const created = await call('catalog-owner-a', '/offers', offer);
  assert.equal(created.status, 201, await created.clone().text());
  const result = await created.json();
  assert.match(result.id, /^BPL-OFFER-[a-f0-9-]{36}$/);
  assert.equal(result.offerPrice, 99900);
  const saved = (await workspace().collection('offers').doc(result.id).get()).data()!;
  assert.equal(saved.ownerId, 'catalog-owner-a');
  assert.equal(saved.startsAt.toDate().toISOString(), offer.startsAt.replace('Z', '.000Z'));
  assert.equal(saved.usedCount, 0);
  const listed = await call('catalog-owner-a');
  const data = await listed.json();
  assert.equal(data.offers.length, 1);
  assert.equal(data.pricedTests, 1);
  assert.equal(data.offers[0].offerPrice, 99900);
  const other = await call('catalog-owner-b');
  assert.deepEqual((await other.json()).offers, []);
  const custom = await call('catalog-owner-a', '/catalog', {
    name: 'Local health package',
    type: 'package',
    price: 250000,
    category: 'Health Packages',
    aliases: [],
  });
  assert.equal(custom.status, 201, await custom.clone().text());
  assert.ok((await custom.json()).id.startsWith('BPL-CAT-'));
});
