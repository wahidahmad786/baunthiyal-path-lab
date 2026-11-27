import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Customer, Offer } from '../lib/domain';
import {
  activeLinkedOffer,
  linkedCampaignAudience,
  linkedCampaignChat,
} from '../lib/linked-campaign';

const now = Date.parse('2026-11-27T16:00:00Z');
const offer: Offer = {
  id: 'offer',
  title: 'General checkup',
  description: 'A sample offer',
  type: 'Full Body Checkup',
  discountType: 'fixed',
  discountValue: 100,
  startsAt: '2026-11-27T09:00:00Z',
  expiresAt: '2026-11-28T09:00:00Z',
  eligibility: 'senior',
  originalPrice: 1000,
  offerPrice: 900,
  testIds: ['test'],
  createdAt: '2026-11-27T09:00:00Z',
  usedCount: 0,
};
const record = (
  id: string,
  marketing: Customer['marketing']['status'] = 'opted_in',
  age = 63,
  phone = '9198765432' + id,
): Customer => ({
  id,
  name: 'Example ' + id,
  phone,
  age,
  createdAt: offer.createdAt,
  groups: [],
  testIds: [],
  marketing: { status: marketing, at: offer.createdAt, source: 'test' },
});

test('linked campaigns select only opted-in, eligible, valid and distinct numbers', () => {
  const customers = [
    record('1'),
    record('2', 'opted_out'),
    record('3', 'not_asked'),
    record('4', 'opted_in', 24),
    record('5', 'opted_in', 61, 'not a number'),
    record('6', 'opted_in', 63, record('1').phone),
    record('7'),
  ];
  assert.deepEqual(
    linkedCampaignAudience(customers, offer, now).map((c) => c.id),
    ['1', '7'],
  );
  assert.deepEqual(linkedCampaignAudience(customers, offer, now + 86400000), []);
  assert.equal(activeLinkedOffer(offer, Date.parse(offer.startsAt) - 1), false);
  assert.equal(activeLinkedOffer(offer, Date.parse(offer.expiresAt)), false);
});

test('WhatsApp drafts encode the entire message without extra URL parameters and append opt-out', () => {
  const msg = 'नमस्ते 👋 ₹500 & book?#';
  const result = new URL(linkedCampaignChat('919876543211', msg));
  assert.equal(result.origin, 'https://wa.me');
  assert.equal(result.pathname, '/919876543211');
  assert.equal(result.hash, '');
  assert.deepEqual(
    [...result.searchParams.entries()],
    [['text', msg + '\n\nReply STOP to opt out.']],
  );
  assert.throws(() => linkedCampaignChat('9198765432?x', msg), /Invalid WhatsApp number/);
  assert.throws(() => linkedCampaignChat('919876543211', '   '), /Enter a message/);
  assert.doesNotThrow(() => linkedCampaignChat('919876543211', '\ud800'));
});
