import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  eligible,
  offerEligible,
  normalizePhone,
  finalPrice,
  offerSchema,
  renderTemplate,
  templateParameters,
  shouldUpdateDelivery,
  calculateROI,
  Customer,
  Offer,
  CampaignInput,
} from '../lib/domain';
const customer: Customer = {
  id: 'customer-1',
  name: 'Customer',
  phone: '919999999999',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastVisitAt: '2026-08-04T10:00:00.000Z',
  marketing: { status: 'opted_in', at: '2026-01-01T00:00:00.000Z', source: 'signed_form' },
  testIds: ['cbc'],
  groups: ['wellness'],
  age: 62,
  visits: 2,
};
const audience = (
  type: CampaignInput['audience']['type'],
  extra: Partial<CampaignInput['audience']> = {},
): CampaignInput['audience'] => ({ type, testIds: [], groups: [], customerIds: [], ...extra });
test('every audience excludes absent, unasked, and withdrawn marketing consent', () => {
  for (const type of [
    'all',
    'existing',
    'last_visit',
    'test_history',
    'groups',
    'manual',
  ] as const) {
    for (const status of ['opted_out', 'not_asked'] as const)
      assert.equal(
        eligible(
          { ...customer, marketing: { ...customer.marketing, status } },
          audience(type, { testIds: ['cbc'], groups: ['wellness'], customerIds: ['customer-1'] }),
        ),
        false,
      );
    assert.equal(
      eligible({ ...customer, marketing: undefined } as unknown as Customer, audience(type)),
      false,
    );
  }
});
test('last visit boundaries, history, group and manual selection are enforced', () => {
  assert.equal(
    eligible(customer, audience('last_visit', { from: '2026-08-04', to: '2026-08-04' })),
    true,
  );
  assert.equal(eligible(customer, audience('last_visit', { to: '2026-08-03' })), false);
  assert.equal(eligible(customer, audience('test_history', { testIds: ['cbc'] })), true);
  assert.equal(eligible(customer, audience('test_history', { testIds: ['thyroid'] })), false);
  assert.equal(eligible(customer, audience('groups', { groups: ['wellness'] })), true);
  assert.equal(eligible(customer, audience('manual', { customerIds: ['different'] })), false);
  assert.equal(eligible({ ...customer, visits: 0 }, audience('existing')), false);
});
test('offer eligibility checks senior, first visit, repeat and verified referral', () => {
  const o = { eligibility: 'senior' } as Offer;
  assert.equal(offerEligible(o, customer), true);
  assert.equal(offerEligible(o, { ...customer, age: 59 }), false);
  assert.equal(offerEligible({ ...o, eligibility: 'new' }, customer), false);
  assert.equal(offerEligible({ ...o, eligibility: 'repeat' }, customer), true);
  assert.equal(offerEligible({ ...o, eligibility: 'referral' }, customer), false);
  assert.equal(
    offerEligible({ ...o, eligibility: 'referral' }, { ...customer, referralCode: 'verified' }),
    true,
  );
});
test('prices are calculated in paise with rounding and no negative balance', () => {
  assert.equal(finalPrice(149900, 'fixed', 50000), 99900);
  assert.equal(finalPrice(10001, 'percentage', 12.5), 8751);
  assert.equal(finalPrice(10000, 'percentage', 100), 0);
  assert.equal(finalPrice(1000, 'fixed', 2000), 0);
});
test('offer validation rejects reversed dates, invalid discounts, and missing tests', () => {
  const valid = {
    title: 'Full Body Checkup',
    description: 'A complete preventive package',
    type: 'Full Body Checkup',
    discountType: 'percentage',
    discountValue: 20,
    originalPrice: 149900,
    startsAt: '2026-11-01T00:00:00.000Z',
    expiresAt: '2026-12-01T00:00:00.000Z',
    testIds: ['cbc'],
  };
  assert.equal(offerSchema.safeParse(valid).success, true);
  assert.equal(offerSchema.safeParse({ ...valid, discountValue: 101 }).success, false);
  assert.equal(offerSchema.safeParse({ ...valid, expiresAt: valid.startsAt }).success, false);
  assert.equal(offerSchema.safeParse({ ...valid, testIds: [] }).success, false);
  assert.equal(
    offerSchema.safeParse({ ...valid, discountType: 'fixed', discountValue: 150000 }).success,
    false,
  );
});
test('normalizes Indian numbers and rejects invalid international input', () => {
  assert.equal(normalizePhone('+91 98765 43210'), '919876543210');
  assert.equal(normalizePhone('9876543210'), '919876543210');
  assert.equal(normalizePhone('+44 7700 900123'), '447700900123');
  assert.throws(() => normalizePhone('abc'));
  assert.throws(() => normalizePhone('01234567'));
});
test('named and positional placeholders map without changing approved wording', () => {
  assert.deepEqual(templateParameters('Hello {{1}}, {{offer_title}} {{1}}'), ['1', 'offer_title']);
  assert.equal(renderTemplate('Hello {{1}}, {{2}}', { 1: 'Asha' }), 'Hello Asha, {{2}}');
});
test('out-of-order, duplicate, or failed events cannot demote delivery and read receipts', () => {
  assert.equal(shouldUpdateDelivery('read', 'delivered'), false);
  assert.equal(shouldUpdateDelivery('delivered', 'failed'), false);
  assert.equal(shouldUpdateDelivery('sent', 'failed'), true);
  assert.equal(shouldUpdateDelivery('failed', 'delivered'), true);
  assert.equal(shouldUpdateDelivery('read', 'read'), false);
  assert.equal(shouldUpdateDelivery('accepted', 'sent'), true);
});
test('ROI is undefined when no spend is recorded, and uses collected revenue', () => {
  assert.equal(calculateROI(0, 0), null);
  assert.equal(calculateROI(30000, 10000), 200);
  assert.equal(calculateROI(0, 10000), -100);
});
