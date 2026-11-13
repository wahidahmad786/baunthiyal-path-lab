import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { deleteApp } from 'firebase-admin/app';
import { auth, adminApp } from '../lib/server/firebase';

process.env.FIREBASE_PROJECT_ID ||= process.env.GCLOUD_PROJECT;
if (
  process.env.FIREBASE_PROJECT_ID !== 'demo-bpl' ||
  !process.env.FIREBASE_AUTH_EMULATOR_HOST ||
  !process.env.FIRESTORE_EMULATOR_HOST
)
  throw new Error('Catalog rule tests require the isolated demo-bpl Auth and Firestore emulators.');
const base = `http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/demo-bpl/databases/(default)/documents`;
const owner = 'rule-account-catalog-owner';
const other = 'rule-account-catalog-other';
const unverified = 'rule-account-catalog-unverified';
const tokens: Record<string, string> = {};
type Fields = Record<string, any>;
const string = (value: string) => ({ stringValue: value });
const integer = (value: number) => ({ integerValue: String(value) });
const timestamp = (value: string) => ({ timestampValue: value });
const list = (values: any[]) => ({ arrayValue: { values } });
const workspace = (uid = owner) => `bpl_customerWorkspaces/${uid}`;

before(async () => {
  for (const uid of [owner, other, unverified]) {
    await auth().createUser({
      uid,
      email: `${uid}@example.test`,
      emailVerified: uid !== unverified,
      password: 'emulator-catalog-rules-password',
    });
    const response = await fetch(
      `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=emulator-only`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: `${uid}@example.test`,
          password: 'emulator-catalog-rules-password',
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
function headers(uid?: string) {
  return {
    'Content-Type': 'application/json',
    ...(uid ? { Authorization: `Bearer ${tokens[uid]}` } : {}),
  };
}
function catalog(id: string, uid = owner, at = new Date().toISOString()): Fields {
  return {
    ownerId: string(uid),
    id: string(id),
    name: string('Complete Blood Count'),
    type: string('test'),
    price: { nullValue: null },
    category: string('Hematology'),
    aliases: list([string('CBC')]),
    createdAt: timestamp(at),
    updatedAt: timestamp(at),
  };
}
function offer(id: string, uid = owner, at = new Date().toISOString()): Fields {
  return {
    ownerId: string(uid),
    id: string(id),
    title: string('Wellness checkup'),
    description: string('A diagnostic health offer'),
    type: string('Fixed Amount Discount'),
    discountType: string('fixed'),
    discountValue: integer(50000),
    originalPrice: integer(149900),
    offerPrice: integer(99900),
    startsAt: timestamp(new Date(Date.now() - 3600000).toISOString()),
    expiresAt: timestamp(new Date(Date.now() + 86400000).toISOString()),
    testIds: list([string('rules-cbc')]),
    eligibility: string('all'),
    createdAt: timestamp(at),
    usedCount: integer(0),
  };
}
function commit(path: string, fields: Fields, uid = owner, update = false) {
  return fetch(base + ':commit', {
    method: 'POST',
    headers: headers(uid),
    body: JSON.stringify({
      writes: [
        {
          update: { name: `projects/demo-bpl/databases/(default)/documents/${path}`, fields },
          currentDocument: { exists: update },
        },
      ],
    }),
  });
}
async function allowed(response: Response) {
  assert.equal(response.status, 200, await response.clone().text());
}
async function denied(response: Response) {
  assert.equal(response.status, 403, await response.clone().text());
}

test('catalog rules allow unknown rates and owner price updates while excluding other identities', async () => {
  const path = `${workspace()}/tests/rules-cbc`;
  const entry = catalog('rules-cbc');
  await allowed(await commit(path, entry));
  await allowed(await fetch(`${base}/${path}`, { headers: headers(owner) }));
  await allowed(await fetch(`${base}/${workspace()}/tests`, { headers: headers(owner) }));
  await denied(await fetch(`${base}/${path}`));
  await denied(await fetch(`${base}/${path}`, { headers: headers(other) }));
  await denied(await fetch(`${base}/${workspace()}/tests`, { headers: headers(other) }));
  entry.price = integer(149900);
  entry.updatedAt = timestamp(new Date().toISOString());
  await allowed(await commit(path, entry, owner, true));
  const saved = await fetch(`${base}/${path}`, { headers: headers(owner) });
  assert.equal((await saved.json()).fields.price.integerValue, '149900');
  await denied(
    await commit(
      `${workspace(unverified)}/tests/rules-unverified`,
      catalog('rules-unverified', unverified),
      unverified,
    ),
  );
  await denied(await fetch(`${base}/${path}`, { method: 'DELETE', headers: headers(owner) }));
});

test('catalog creates and updates enforce strict schemas, bounded aliases and immutable ownership', async () => {
  const id = 'rules-invalid-entry';
  const path = `${workspace()}/tests/${id}`;
  const entry = catalog(id);
  const missing = { ...entry };
  delete missing.category;
  const invalid = [
    missing,
    { ...entry, ownerId: string(other) },
    { ...entry, id: string('different-id') },
    { ...entry, price: integer(-1) },
    { ...entry, price: integer(100000001) },
    { ...entry, price: { doubleValue: 99.5 } },
    { ...entry, category: string('x'.repeat(81)) },
    { ...entry, name: string('x'.repeat(181)) },
    { ...entry, type: string('admin') },
    { ...entry, status: string('sending') },
    { ...entry, aliases: list(Array.from({ length: 9 }, () => string('alias'))) },
    { ...entry, aliases: list([...Array.from({ length: 7 }, () => string('alias')), integer(3)]) },
    { ...entry, aliases: list([string('x'.repeat(101))]) },
    { ...entry, createdAt: timestamp(new Date(0).toISOString()) },
  ];
  for (const fields of invalid) await denied(await commit(path, fields));
  const existingPath = `${workspace()}/tests/rules-cbc`;
  const existing = (
    await (await fetch(`${base}/${existingPath}`, { headers: headers(owner) })).json()
  ).fields;
  const updates = [
    { ...existing, ownerId: string(other) },
    { ...existing, id: string('different-id') },
    { ...existing, createdAt: timestamp(new Date(0).toISOString()) },
    { ...existing, aliases: list([string('x'.repeat(101))]) },
    { ...existing, bplAdmin: { booleanValue: true } },
    { ...existing, updatedAt: timestamp(new Date(0).toISOString()) },
  ];
  for (const fields of updates) await denied(await commit(existingPath, fields, owner, true));
});

test('offer rules support fixed and decimal-percentage discounts with exact rounding and private reads', async () => {
  const fixedId = 'BPL-OFFER-11111111-1111-4111-8111-111111111111';
  const fixedPath = `${workspace()}/offers/${fixedId}`;
  await allowed(await commit(fixedPath, offer(fixedId)));
  await allowed(await fetch(`${base}/${fixedPath}`, { headers: headers(owner) }));
  await allowed(await fetch(`${base}/${workspace()}/offers`, { headers: headers(owner) }));
  await denied(await fetch(`${base}/${fixedPath}`));
  await denied(await fetch(`${base}/${fixedPath}`, { headers: headers(other) }));
  const percentageId = 'BPL-OFFER-22222222-2222-4222-8222-222222222222';
  const percentage = offer(percentageId);
  percentage.type = string('Percentage Discount');
  percentage.discountType = string('percentage');
  percentage.discountValue = { doubleValue: 12.5 };
  percentage.offerPrice = integer(131162);
  await allowed(await commit(`${workspace()}/offers/${percentageId}`, percentage));
  await denied(
    await commit(fixedPath, { ...offer(fixedId), title: string('Changed offer') }, owner, true),
  );
  await denied(await fetch(`${base}/${fixedPath}`, { method: 'DELETE', headers: headers(owner) }));
});

test('offer rules reject forged totals, invalid dates/IDs, oversized lists and activation or role fields', async () => {
  const id = 'BPL-OFFER-33333333-3333-4333-8333-333333333333';
  const path = `${workspace()}/offers/${id}`;
  const entry = offer(id);
  const missing = { ...entry };
  delete missing.testIds;
  const percentage = {
    ...entry,
    discountType: string('percentage'),
    discountValue: { doubleValue: 12.5 },
  };
  const invalid = [
    missing,
    { ...entry, ownerId: string(other) },
    { ...entry, id: string('BPL-OFFER-invalid') },
    { ...entry, offerPrice: integer(1) },
    { ...entry, offerPrice: integer(-1) },
    { ...entry, originalPrice: integer(0) },
    { ...entry, discountValue: { doubleValue: 50000.4 } },
    { ...percentage, offerPrice: integer(131163) },
    { ...percentage, discountValue: integer(101) },
    { ...entry, expiresAt: entry.startsAt },
    { ...entry, startsAt: string('not-a-timestamp') },
    { ...entry, description: string('x'.repeat(1501)) },
    { ...entry, title: string('x'.repeat(121)) },
    { ...entry, eligibility: string('admin') },
    { ...entry, type: string('Unrecognized Offer') },
    { ...entry, usedCount: integer(1) },
    { ...entry, status: string('running') },
    { ...entry, bplAdmin: { booleanValue: true } },
    { ...entry, testIds: list([]) },
    { ...entry, testIds: list([string('rules-cbc'), string('rules-cbc')]) },
    { ...entry, testIds: list([string('../another-user/test')]) },
    { ...entry, testIds: list(Array.from({ length: 21 }, (_, index) => string(`test-${index}`))) },
    {
      ...entry,
      testIds: list([
        ...Array.from({ length: 19 }, (_, index) => string(`test-${index}`)),
        integer(1),
      ]),
    },
  ];
  for (const fields of invalid) await denied(await commit(path, fields));
});
