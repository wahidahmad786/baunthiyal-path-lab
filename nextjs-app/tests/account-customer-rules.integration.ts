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
  throw new Error('Customer rule tests require the isolated demo-bpl emulators.');

const base = `http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/demo-bpl/databases/(default)/documents`;
const workspace = (uid: string) => `bpl_customerWorkspaces/${uid}`;
const owner = 'rule-account-customer-owner';
const other = 'rule-account-customer-other';
const unverified = 'rule-account-customer-unverified';
const tokens: Record<string, string> = {};
type Fields = Record<string, any>;
const string = (value: string) => ({ stringValue: value });
const timestamp = (value: string) => ({ timestampValue: value });
const map = (fields: Fields) => ({ mapValue: { fields } });
const list = (values: any[]) => ({ arrayValue: { values } });

before(async () => {
  for (const uid of [owner, other, unverified]) {
    await auth().createUser({
      uid,
      email: `${uid}@example.test`,
      emailVerified: uid !== unverified,
      password: 'emulator-rule-password',
    });
    const response = await fetch(
      `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=emulator-only`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: `${uid}@example.test`,
          password: 'emulator-rule-password',
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
function customer(id: string, uid = owner, at = new Date().toISOString()): Fields {
  return {
    ownerId: string(uid),
    id: string(id),
    name: string('Rule Test Customer'),
    phone: string('919876543210'),
    createdAt: timestamp(at),
    testIds: list([]),
    groups: list([string('Health group')]),
    visits: { integerValue: '0' },
    age: { integerValue: '23' },
    marketing: map({
      status: string('not_asked'),
      source: string('registration form'),
      at: timestamp(at),
      eventId: string(''),
    }),
  };
}
function marketing(
  status: string,
  eventId: string,
  at = new Date().toISOString(),
  source = 'Verified customer preference',
) {
  return map({
    status: string(status),
    source: string(source),
    at: timestamp(at),
    eventId: string(eventId),
  });
}
function event(
  customerId: string,
  status: string,
  at: string,
  source = 'Verified customer preference',
  uid = owner,
): Fields {
  return {
    ownerId: string(uid),
    customerId: string(customerId),
    status: string(status),
    source: string(source),
    actor: string(uid),
    createdAt: timestamp(at),
  };
}
function write(path: string, fields: Fields, update = false) {
  return {
    update: { name: `projects/demo-bpl/databases/(default)/documents/${path}`, fields },
    currentDocument: { exists: update },
  };
}
function commit(writes: unknown[], uid = owner) {
  return fetch(base + ':commit', {
    method: 'POST',
    headers: headers(uid),
    body: JSON.stringify({ writes }),
  });
}
async function allowed(response: Response) {
  assert.equal(response.status, 200, await response.clone().text());
}
async function denied(response: Response) {
  assert.equal(response.status, 403, await response.clone().text());
}

test('customer rules permit owner registration/listing and reject public, cross-account and unverified access', async () => {
  const id = 'a'.repeat(32);
  const path = `${workspace(owner)}/customers/${id}`;
  await allowed(await commit([write(path, customer(id))]));
  await allowed(await fetch(`${base}/${path}`, { headers: headers(owner) }));
  await allowed(await fetch(`${base}/${workspace(owner)}/customers`, { headers: headers(owner) }));
  await denied(await fetch(`${base}/${path}`));
  await denied(await fetch(`${base}/${path}`, { headers: headers(other) }));
  await denied(await fetch(`${base}/${workspace(owner)}/customers`, { headers: headers(other) }));
  const otherId = 'b'.repeat(32);
  await denied(
    await commit(
      [write(`${workspace(unverified)}/customers/${otherId}`, customer(otherId, unverified))],
      unverified,
    ),
  );
  await denied(await fetch(`${base}/${workspace(owner)}`, { headers: headers(owner) }));
});

test('opt-in registration requires its matching new event in the same atomic commit', async () => {
  const id = 'c'.repeat(32);
  const eventId = '11111111-1111-4111-8111-111111111111';
  const at = new Date().toISOString();
  const path = `${workspace(owner)}/customers/${id}`;
  const record = customer(id, owner, at);
  record.marketing = marketing('opted_in', eventId, at);
  await denied(await commit([write(path, record)]));
  await denied(
    await commit([
      write(`${workspace(owner)}/consentEvents/${eventId}`, event(id, 'opted_in', at)),
    ]),
  );
  await denied(
    await commit([
      write(path, record),
      write(
        `${workspace(owner)}/consentEvents/${eventId}`,
        event(id, 'opted_in', at, 'Different evidence'),
      ),
    ]),
  );
  await allowed(
    await commit([
      write(path, record),
      write(`${workspace(owner)}/consentEvents/${eventId}`, event(id, 'opted_in', at)),
    ]),
  );
  const outId = 'd'.repeat(32);
  const outRecord = customer(outId, owner, at);
  outRecord.marketing = marketing('opted_out', '22222222-2222-4222-8222-222222222222', at);
  await denied(await commit([write(`${workspace(owner)}/customers/${outId}`, outRecord)]));
});

test('preference updates require fresh events, keep customer fields immutable and preserve the audit history', async () => {
  const id = 'c'.repeat(32);
  const path = `${workspace(owner)}/customers/${id}`;
  const read = await fetch(`${base}/${path}`, { headers: headers(owner) });
  const record = (await read.json()).fields;
  const eventId = '33333333-3333-4333-8333-333333333333';
  const at = new Date().toISOString();
  record.marketing = marketing('opted_out', eventId, at);
  await denied(await commit([write(path, record, true)]));
  await allowed(
    await commit([
      write(path, record, true),
      write(`${workspace(owner)}/consentEvents/${eventId}`, event(id, 'opted_out', at)),
    ]),
  );
  await denied(await commit([write(path, record, true)]));
  await denied(
    await fetch(`${base}/${workspace(owner)}/consentEvents/${eventId}`, {
      method: 'DELETE',
      headers: headers(owner),
    }),
  );
  const newEventId = '44444444-4444-4444-8444-444444444444';
  const newAt = new Date().toISOString();
  record.marketing = marketing('opted_in', newEventId, newAt);
  const mutations = [
    { name: string('Changed identity') },
    { ownerId: string(other) },
    { createdAt: timestamp(new Date(0).toISOString()) },
    { groups: list([string('Changed group')]) },
    { admin: { booleanValue: true } },
  ];
  for (const mutation of mutations) {
    await denied(
      await commit([
        write(path, { ...record, ...mutation }, true),
        write(`${workspace(owner)}/consentEvents/${newEventId}`, event(id, 'opted_in', newAt)),
      ]),
    );
  }
});

test('registration schema rejects missing fields, invalid group items, oversized values, role fields and forged event actors', async () => {
  const id = 'e'.repeat(32);
  const path = `${workspace(owner)}/customers/${id}`;
  const record = customer(id);
  const missingName = { ...record };
  delete missingName.name;
  const cases = [
    missingName,
    { ...record, name: string('x'.repeat(121)) },
    { ...record, groups: list([string('x'.repeat(81))]) },
    { ...record, groups: list(Array.from({ length: 11 }, () => string('Group'))) },
    {
      ...record,
      groups: list([...Array.from({ length: 9 }, () => string('Group')), { integerValue: '1' }]),
    },
    { ...record, age: { integerValue: '131' } },
    { ...record, visits: { integerValue: '1' } },
    { ...record, bplAdmin: { booleanValue: true } },
    { ...record, createdAt: timestamp(new Date(0).toISOString()) },
    { ...record, testIds: list([string('Unexpected test')]) },
  ];
  for (const fields of cases) await denied(await commit([write(path, fields)]));
  const eventId = '55555555-5555-4555-8555-555555555555';
  const at = new Date().toISOString();
  const opted = customer(id, owner, at);
  opted.marketing = marketing('opted_in', eventId, at);
  await denied(
    await commit([
      write(path, opted),
      write(`${workspace(owner)}/consentEvents/${eventId}`, {
        ...event(id, 'opted_in', at),
        actor: string(other),
      }),
    ]),
  );
});
