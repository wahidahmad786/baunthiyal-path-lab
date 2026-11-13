import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleAccountCustomers } from '../lib/account-customers-api';
import { customerConsentSchema, customerInputSchema } from '../lib/customer-input';

const env = { projectId: 'demo-bpl', apiKey: 'test-key' };
const origin = 'https://lab.example.test';
const input = {
  name: 'Test Customer',
  phone: '+91 98765 43210',
  age: 23,
  groups: [' BLOOD TEST ', 'BLOOD TEST'],
  marketingConsent: true,
  consentSource: 'by staff',
};
const request = (options: RequestInit = {}) =>
  new Request(`${origin}/api/account/customers`, options);

test('customer input normalizes contact details, requires explicit consent, and rejects privileges or invalid evidence', () => {
  const parsed = customerInputSchema.parse(input);
  assert.equal(parsed.phone, '919876543210');
  assert.deepEqual(parsed.groups, ['BLOOD TEST']);
  assert.equal(customerInputSchema.safeParse({ ...input, bplAdmin: true }).success, false);
  assert.equal(
    customerInputSchema.safeParse({ ...input, marketingConsent: 'true' }).success,
    false,
  );
  assert.equal(customerInputSchema.safeParse({ ...input, age: 131 }).success, false);
  assert.equal(customerInputSchema.safeParse({ ...input, consentSource: ' ' }).success, false);
  assert.equal(
    customerConsentSchema.safeParse({
      status: 'opted_in',
      source: 'customer request',
      confirmed: false,
    }).success,
    false,
  );
  assert.equal(
    customerConsentSchema.safeParse({
      status: 'opted_out',
      source: 'customer STOP',
      confirmed: true,
    }).success,
    true,
  );
});

test('unauthenticated and cross-origin registration never reaches customer storage', async () => {
  const forbidden = (async () => {
    throw new Error('External calls must not occur');
  }) as typeof fetch;
  assert.equal((await handleAccountCustomers(request(), env, forbidden)).status, 401);
  assert.equal(
    (
      await handleAccountCustomers(
        request({
          method: 'POST',
          headers: { origin: 'https://attacker.example', authorization: 'Bearer token' },
          body: JSON.stringify(input),
        }),
        env,
        forbidden,
      )
    ).status,
    403,
  );
  let calls = 0;
  const unverified = (async () => {
    calls++;
    return Response.json({ users: [{ localId: 'test-owner', emailVerified: false }] });
  }) as typeof fetch;
  assert.equal(
    (
      await handleAccountCustomers(
        request({ headers: { authorization: 'Bearer token' } }),
        env,
        unverified,
      )
    ).status,
    403,
  );
  assert.equal(calls, 1);
});

test('customer list uses database count queries and reports truncation without inventing totals from loaded rows', async () => {
  const sent: string[] = [];
  const customer = {
    name: 'projects/demo-bpl/databases/(default)/documents/bpl_customerWorkspaces/test-owner/customers/a',
    fields: {
      id: { stringValue: 'a'.repeat(32) },
      name: { stringValue: 'Test Customer' },
      phone: { stringValue: '919876543210' },
      createdAt: { timestampValue: '2026-01-01T00:00:00Z' },
      testIds: { arrayValue: {} },
      groups: { arrayValue: {} },
      visits: { integerValue: '0' },
      marketing: {
        mapValue: {
          fields: {
            status: { stringValue: 'not_asked' },
            source: { stringValue: 'staff registration' },
            at: { timestampValue: '2026-01-01T00:00:00Z' },
            eventId: { stringValue: '' },
          },
        },
      },
    },
  };
  const mock = (async (url, init) => {
    sent.push(String(url));
    if (String(url).includes('accounts:lookup'))
      return Response.json({ users: [{ localId: 'test-owner', emailVerified: true }] });
    assert.ok(String(url).includes('/bpl_customerWorkspaces/test-owner'));
    if (String(url).endsWith(':runAggregationQuery')) {
      const query = JSON.parse(String(init?.body)).structuredAggregationQuery.structuredQuery;
      return Response.json([
        { result: { aggregateFields: { total: { integerValue: query.where ? '460' : '1250' } } } },
      ]);
    }
    return Response.json({ documents: [customer], nextPageToken: 'more-records' });
  }) as typeof fetch;
  const response = await handleAccountCustomers(
    request({ headers: { authorization: 'Bearer token' } }),
    env,
    mock,
  );
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.customers.length, 1);
  assert.equal(result.totalCustomers, 1250);
  assert.equal(result.optedIn, 460);
  assert.equal(result.truncated, true);
  assert.equal(result.customers[0].ownerId, undefined);
  assert.equal(result.customers[0].marketing.eventId, undefined);
  assert.equal(sent.filter((url) => url.endsWith(':runAggregationQuery')).length, 2);
});
