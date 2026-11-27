import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleAccountCatalog, catalogInputSchema } from '../lib/account-catalog-api';
import { REFERENCE_TESTS } from '../lib/test-reference';

const env = { projectId: 'demo-bpl', apiKey: 'test-key' };
const origin = 'https://lab.example.test';
const request = (path = '/catalog', data?: unknown) =>
  new Request(`${origin}/api/account${path}`, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer test-token', origin, 'Content-Type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
const offer = {
  title: 'Wellness checkup',
  description: 'A genuine test offer',
  type: 'Seasonal Offer',
  discountType: 'percentage',
  discountValue: 12.5,
  originalPrice: 149900,
  startsAt: '2026-01-01T00:00:00Z',
  expiresAt: '2026-02-01T00:00:00Z',
  testIds: ['test-1'],
  eligibility: 'all',
};
test('catalog input preserves unknown rates as null and rejects invalid prices and role fields', () => {
  assert.equal(
    catalogInputSchema.parse({
      name: 'Complete blood count',
      type: 'test',
      price: null,
      category: 'Haematology',
      aliases: ['CBC'],
    }).price,
    null,
  );
  for (const price of [-1, 1.5, 100000001])
    assert.equal(catalogInputSchema.safeParse({ name: 'CBC', type: 'test', price }).success, false);
  assert.equal(catalogInputSchema.safeParse({ name: 'CBC', type: 'test', price: 0 }).success, true);
  assert.equal(
    catalogInputSchema.safeParse({ name: 'CBC', type: 'test', price: 100, ownerId: 'another-user' })
      .success,
    false,
  );
});
test('catalog authentication rejects missing and unverified identities before database access', async () => {
  const noCall = (async () => {
    throw new Error('No external call expected');
  }) as typeof fetch;
  assert.equal(
    (await handleAccountCatalog(new Request(origin + '/api/account/catalog'), env, noCall)).status,
    401,
  );
  const user = (async () =>
    Response.json({ users: [{ localId: 'owner', emailVerified: false }] })) as typeof fetch;
  assert.equal((await handleAccountCatalog(request(), env, user)).status, 403);
  const foreign = new Request(origin + '/api/account/catalog', {
    method: 'POST',
    headers: { origin: 'https://other.example', Authorization: 'Bearer token' },
    body: '{}',
  });
  assert.equal((await handleAccountCatalog(foreign, env, noCall)).status, 403);
});
test('offers verify current own rates, reject unpriced or inconsistent totals, and calculate the saved discount', async () => {
  let price: number | null = 149900;
  let writes: unknown[] = [];
  const send = (async (input, init) => {
    const url = String(input);
    if (url.includes('accounts:lookup'))
      return Response.json({ users: [{ localId: 'catalog-owner', emailVerified: true }] });
    if (url.endsWith(':batchGet')) {
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.documents, [
        'projects/demo-bpl/databases/(default)/documents/bpl_customerWorkspaces/catalog-owner/tests/test-1',
      ]);
      return Response.json([
        {
          found: {
            name: body.documents[0],
            fields: {
              price: price === null ? { nullValue: null } : { integerValue: String(price) },
            },
          },
        },
      ]);
    }
    assert.ok(url.endsWith(':commit'));
    writes = JSON.parse(String(init?.body)).writes;
    return Response.json({ writeResults: [{}] });
  }) as typeof fetch;
  price = null;
  assert.equal((await handleAccountCatalog(request('/offers', offer), env, send)).status, 400);
  assert.equal(writes.length, 0);
  price = 0;
  assert.equal((await handleAccountCatalog(request('/offers', offer), env, send)).status, 400);
  price = 150000;
  assert.equal((await handleAccountCatalog(request('/offers', offer), env, send)).status, 400);
  price = 149900;
  const response = await handleAccountCatalog(request('/offers', offer), env, send);
  assert.equal(response.status, 201, await response.clone().text());
  const result = await response.json();
  assert.equal(result.offerPrice, 131162);
  assert.match(result.id, /^BPL-OFFER-[a-f0-9-]{36}$/);
  assert.equal(writes.length, 1);
  const first = writes[0] as { update: { fields: Record<string, unknown> } };
  assert.deepEqual(first.update.fields.startsAt, { timestampValue: offer.startsAt });
  assert.equal(
    (
      await handleAccountCatalog(
        request('/offers', {
          ...offer,
          testIds: Array.from({ length: 21 }, (_, i) => `test-${i}`),
        }),
        env,
        send,
      )
    ).status,
    400,
  );
});
test('reference import adds only missing records at null rates and preserves existing names and prices', async () => {
  const missing = new Set([REFERENCE_TESTS[0].id]);
  let writeCount = 0;
  const send = (async (input, init) => {
    const url = String(input);
    if (url.includes('accounts:lookup'))
      return Response.json({ users: [{ localId: 'catalog-owner', emailVerified: true }] });
    const body = JSON.parse(String(init?.body));
    if (url.endsWith(':batchGet'))
      return Response.json(
        body.documents.map((name: string) =>
          missing.has(name.split('/').at(-1)!)
            ? { missing: name }
            : {
                found: {
                  name,
                  fields: {
                    name: { stringValue: 'My existing name' },
                    price: { integerValue: '40000' },
                  },
                },
              },
        ),
      );
    assert.ok(url.endsWith(':commit'));
    assert.ok(body.writes.length <= 400);
    writeCount += body.writes.length;
    for (const write of body.writes) {
      assert.deepEqual(write.currentDocument, { exists: false });
      assert.deepEqual(write.update.fields.price, { nullValue: null });
      assert.equal(write.update.fields.id.stringValue, REFERENCE_TESTS[0].id);
      missing.delete(write.update.fields.id.stringValue);
    }
    return Response.json({ writeResults: body.writes.map(() => ({})) });
  }) as typeof fetch;
  const first = await handleAccountCatalog(request('/catalog/import-reference', {}), env, send);
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal((await first.json()).imported, 1);
  const second = await handleAccountCatalog(request('/catalog/import-reference', {}), env, send);
  const result = await second.json();
  assert.equal(result.imported, 0);
  assert.equal(result.skipped, REFERENCE_TESTS.length);
  assert.equal(writeCount, 1);
});

test('published benchmark rates cover the pending reference catalog without invented IDs', async () => {
  const { REFERENCE_RATE_ROWS } = await import('../lib/reference-rates');
  const withoutBenchmarks = new Set(['BPL-REF-0136', 'BPL-REF-0438', 'BPL-REF-0439']);
  assert.deepEqual(
    new Set(REFERENCE_RATE_ROWS.map((row) => row.id)),
    new Set(REFERENCE_TESTS.filter((row) => !withoutBenchmarks.has(row.id)).map((row) => row.id)),
  );
  assert.equal(REFERENCE_RATE_ROWS.length, 436);
  for (const row of REFERENCE_RATE_ROWS) {
    assert.ok(Number.isSafeInteger(row.rupees) && row.rupees > 0);
    assert.equal(new URL(row.source).protocol, 'https:');
  }
});

test('reference rate preview is read-only and apply protects existing prices and catalog fields', async () => {
  let writes: any[] = [];
  let conflict = true;
  let saved = false;
  const send = (async (input, init) => {
    const url = String(input);
    if (url.includes('accounts:lookup'))
      return Response.json({ users: [{ localId: 'catalog-owner', emailVerified: true }] });
    const body = JSON.parse(String(init?.body));
    if (url.endsWith(':batchGet')) {
      assert.equal(body.documents.length, 436);
      assert.ok(body.documents.every((name: string) => name.includes('/catalog-owner/tests/')));
      return Response.json(
        body.documents.slice(0, 4).map((name: string, i: number) => ({
          found: {
            name,
            updateTime: '2026-11-25T00:00:00Z',
            fields: {
              ownerId: { stringValue: i === 3 ? 'other' : 'catalog-owner' },
              id: { stringValue: REFERENCE_TESTS[i].id },
              type: { stringValue: 'test' },
              name: { stringValue: i === 2 ? 'Changed test identity' : REFERENCE_TESTS[i].name },
              price: i === 1 || (i === 0 && saved) ? { integerValue: '100' } : { nullValue: null },
            },
          },
        })),
      );
    }
    assert.ok(url.endsWith(':commit'));
    if (conflict) return Response.json({ error: 'precondition failed' }, { status: 409 });
    writes = body.writes;
    saved = true;
    return Response.json({ writeResults: writes.map(() => ({})) });
  }) as typeof fetch;
  const path = '/catalog/reference-rates';
  const preview = await handleAccountCatalog(request(path), env, send);
  assert.equal((await preview.json()).eligible, 1);
  assert.equal(writes.length, 0);
  assert.equal((await handleAccountCatalog(request(path, {}), env, send)).status, 400);
  assert.equal(
    (await handleAccountCatalog(request(path, { confirm: true }), env, send)).status,
    409,
  );
  assert.equal(writes.length, 0);
  conflict = false;
  const result = await handleAccountCatalog(request(path, { confirm: true }), env, send);
  assert.equal((await result.json()).updated, 1);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].update.fields.price, { integerValue: '28000' });
  assert.deepEqual(writes[0].updateMask.fieldPaths, ['price', 'updatedAt']);
  assert.equal(writes[0].currentDocument.updateTime, '2026-11-25T00:00:00Z');
  assert.equal(
    (await (await handleAccountCatalog(request(path, { confirm: true }), env, send)).json())
      .updated,
    0,
  );
});
