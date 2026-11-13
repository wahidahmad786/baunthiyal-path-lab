// Only the isolated demo Firebase emulator is allowed. Never point this suite at production.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { deleteApp } from 'firebase-admin/app';
import { db, adminApp } from '../lib/server/firebase';
import {
  col,
  createOffer,
  createCampaign,
  audienceFor,
  setConsent,
  applyDelivery,
  hash,
  runWorker,
  statsFor,
} from '../lib/server/service';
import { OfferInput, Customer, Campaign } from '../lib/domain';
process.env.FIREBASE_PROJECT_ID ||= process.env.GCLOUD_PROJECT;
Object.assign(process.env, {
  WHATSAPP_ACCESS_TOKEN: 'emulator-test-token',
  WHATSAPP_PHONE_NUMBER_ID: '123456789',
  WHATSAPP_BUSINESS_ACCOUNT_ID: '987654321',
  WHATSAPP_APP_SECRET: 'emulator-test-secret',
  WHATSAPP_VERIFY_TOKEN: 'emulator-test-verify',
  WHATSAPP_MARKETING_RATE_PAISE: '88',
});
if (process.env.FIREBASE_PROJECT_ID !== 'demo-bpl' || !process.env.FIRESTORE_EMULATOR_HOST)
  throw new Error('Integration tests require demo-bpl and the Firestore emulator');
before(async () => {
  for (const collection of await db().listCollections()) await db().recursiveDelete(collection);
});
globalThis.fetch = (async () => {
  throw new Error(
    'External HTTP is forbidden in the emulator suite unless explicitly mocked in a test',
  );
}) as typeof fetch;
const fixture: OfferInput = {
  title: 'Preventive wellness',
  description: 'Tests for preventive health',
  type: 'Full Body Checkup',
  discountType: 'fixed',
  discountValue: 50000,
  originalPrice: 149900,
  startsAt: new Date(Date.now() - 86400000).toISOString(),
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
  testIds: ['cbc'],
  eligibility: 'all',
};
const customer: Customer = {
  id: 'opted-in',
  name: 'Test recipient',
  phone: '919876543210',
  marketing: { status: 'opted_in', source: 'test_fixture', at: new Date().toISOString() },
  createdAt: new Date().toISOString(),
  groups: [],
  testIds: [],
  visits: 0,
};
after(async () => {
  await deleteApp(adminApp());
});
test('concurrent offer creation allocates distinct IDs and validates actual catalog records', async () => {
  await col('tests').doc('cbc').set({ name: 'CBC', price: 10000, type: 'test' });
  const offers = await Promise.all(Array.from({ length: 5 }, () => createOffer(fixture)));
  assert.equal(new Set(offers.map((o) => o.id)).size, 5);
  assert.equal(offers[0].offerPrice, 99900);
  await assert.rejects(() => createOffer({ ...fixture, testIds: ['missing-test'] }), /valid/);
});
test('consent withdrawal immediately changes targeting and creates an audit record', async () => {
  const offer = await createOffer(fixture);
  await col('customers').doc(customer.id).set(customer);
  const c = await createCampaign(
    {
      name: 'Consent targeting test',
      type: 'Health package',
      offerId: offer.id,
      templateId: '',
      variables: {},
      audience: { type: 'all', testIds: [], groups: [], customerIds: [] },
      scheduledAt: null,
      bannerPath: '',
    },
    'test-admin',
  );
  assert.equal((await audienceFor(c)).length, 1);
  await setConsent(customer.id, 'opted_out', 'customer_stop', 'customer');
  assert.equal((await audienceFor(c)).length, 0);
  const history = await col('consentEvents').where('customerId', '==', customer.id).get();
  assert.equal(history.size, 1);
  assert.equal(history.docs[0].data().status, 'opted_out');
});
test('webhook receipts tolerate reordering, duplicates and late events from retried attempts', async () => {
  const ref = col('campaigns').doc('receipt-test').collection('messages').doc('customer');
  await ref.set({ status: 'accepted', metaId: 'meta-new', estimatedCost: 88 });
  await col('messageIndex').doc(hash('meta-new')).set({ path: ref.path });
  await applyDelivery({ id: 'meta-new', status: 'read' });
  await applyDelivery({ id: 'meta-new', status: 'sent' });
  await applyDelivery({ id: 'meta-new', status: 'failed' });
  await applyDelivery({ id: 'meta-new', status: 'read' });
  assert.equal((await ref.get()).data()?.status, 'read');
  await col('messageIndex').doc(hash('meta-old')).set({ path: ref.path });
  await applyDelivery({ id: 'meta-old', status: 'failed' });
  assert.equal((await ref.get()).data()?.status, 'read');
});
test('early webhook events are retained for worker reconciliation', async () => {
  await applyDelivery({ id: 'meta-early', status: 'delivered' });
  const pending = await col('pendingStatuses')
    .doc(hash('meta-early' + 'delivered'))
    .get();
  assert.equal(pending.exists, true);
  const ref = col('testMessages').doc('early');
  await ref.set({ status: 'accepted', metaId: 'meta-early' });
  await col('messageIndex').doc(hash('meta-early')).set({ path: ref.path });
  await runWorker();
  assert.equal((await ref.get()).data()?.status, 'delivered');
  assert.equal((await pending.ref.get()).exists, false);
});
test('campaign sending excludes a customer who opted out while queued; no Meta send is invoked', async () => {
  const offer = await createOffer(fixture);
  await col('customers')
    .doc(customer.id)
    .set({ ...customer, marketing: { ...customer.marketing, status: 'opted_out' } });
  const c = await createCampaign(
    {
      name: 'Queued opt-out test',
      type: 'Health package',
      offerId: offer.id,
      templateId: 'approved',
      variables: { '1': 'booking_link' },
      audience: { type: 'all', testIds: [], groups: [], customerIds: [] },
      scheduledAt: null,
      bannerPath: '',
    },
    'test-admin',
  );
  await col('campaigns').doc(c.id).update({ status: 'running', audienceSize: 1 });
  const message = col('campaigns').doc(c.id).collection('messages').doc(customer.id);
  await message.set({ customerId: customer.id, status: 'queued', attempts: 0 });
  const original = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    if (String(url).includes('/message_templates'))
      return Response.json({
        data: [
          {
            id: 'approved',
            name: 'offer',
            language: 'en',
            status: 'APPROVED',
            category: 'MARKETING',
            components: [
              {
                type: 'BODY',
                text: 'Baunthiyal Path Lab. Your Health, Our Priority. Book {{1}}. Reply STOP to opt out.',
              },
            ],
          },
        ],
      });
    sends++;
    throw new Error('Unexpected outbound request');
  }) as typeof fetch;
  try {
    await runWorker();
    assert.equal(sends, 0);
    assert.equal((await message.get()).data()?.status, 'skipped');
    assert.equal((await col('campaigns').doc(c.id).get()).data()?.status, 'completed');
  } finally {
    globalThis.fetch = original;
  }
});
test('analytics use stored delivered messages and collected payment amounts', async () => {
  const offer = await createOffer(fixture);
  const c = await createCampaign(
    {
      name: 'Real record analytics',
      type: 'Health package',
      offerId: offer.id,
      templateId: '',
      variables: {},
      audience: { type: 'all', testIds: [], groups: [], customerIds: [] },
      scheduledAt: null,
      bannerPath: '',
    },
    'test-admin',
  );
  await col('campaigns').doc(c.id).collection('messages').doc('a').set({
    status: 'read',
    metaId: 'accepted',
    estimatedCost: 88,
    deliveredAt: new Date().toISOString(),
  });
  await col('campaigns')
    .doc(c.id)
    .collection('messages')
    .doc('b')
    .set({ status: 'failed', estimatedCost: 88 });
  await col('payments').doc('payment-a').set({ campaignId: c.id, amount: 30000 });
  await col('bookings').doc('booking-a').set({ campaignId: c.id, status: 'confirmed' });
  const stats = await statsFor(c);
  assert.equal(stats.sent, 1);
  assert.equal(stats.delivered, 1);
  assert.equal(stats.read, 1);
  assert.equal(stats.failed, 1);
  assert.equal(stats.spend, 88);
  assert.equal(stats.revenue, 30000);
  assert.equal(stats.confirmed, 1);
});
