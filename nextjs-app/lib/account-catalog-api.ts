import { z } from 'zod';
import { offerSchema, finalPrice, type Offer } from './domain';
import { REFERENCE_TESTS } from './test-reference';
import { allowedRequestOrigin } from './request-origin';

export type AccountCatalogEnvironment = {
  projectId: string;
  apiKey: string;
  authOrigin?: string;
  firestoreOrigin?: string;
  appOrigin?: string;
};
export type AccountCatalogEntry = {
  id: string;
  name: string;
  type: 'test' | 'package';
  price: number | null;
  category: string;
  aliases: string[];
  createdAt: string;
  updatedAt: string;
};
export const catalogInputSchema = z
  .object({
    id: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,100}$/)
      .optional(),
    name: z.string().trim().min(2).max(180),
    type: z.enum(['test', 'package']),
    price: z.number().int().min(0).max(100000000).nullable(),
    category: z.string().trim().min(1).max(80).default('General'),
    aliases: z
      .array(z.string().trim().min(1).max(100))
      .max(8)
      .default([])
      .transform((values) => [...new Set(values)]),
  })
  .strict();

type Value = {
  stringValue?: string;
  integerValue?: string;
  doubleValue?: number;
  nullValue?: null;
  timestampValue?: string;
  arrayValue?: { values?: Value[] };
};
type Document = { name: string; fields: Record<string, Value>; updateTime?: string };
class CatalogError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const str = (value: string): Value => ({ stringValue: value });
const numeric = (value: number): Value =>
  Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
const list = (values: string[]): Value => ({ arrayValue: { values: values.map(str) } });
const idFromName = (name: string) => name.slice(name.lastIndexOf('/') + 1);
const numberValue = (value: Value) =>
  value.integerValue === undefined ? Number(value.doubleValue) : Number(value.integerValue);
function fromTest(document: Document): AccountCatalogEntry {
  const f = document.fields;
  return {
    id: f.id.stringValue!,
    name: f.name.stringValue!,
    type: f.type.stringValue as 'test' | 'package',
    price: 'nullValue' in f.price ? null : numberValue(f.price),
    category: f.category.stringValue!,
    aliases: (f.aliases.arrayValue?.values || []).map((value) => value.stringValue!),
    createdAt: f.createdAt.timestampValue!,
    updatedAt: f.updatedAt.timestampValue!,
  };
}
function fromOffer(document: Document): Offer {
  const f = document.fields;
  return {
    id: f.id.stringValue!,
    title: f.title.stringValue!,
    description: f.description.stringValue!,
    type: f.type.stringValue as Offer['type'],
    discountType: f.discountType.stringValue as Offer['discountType'],
    discountValue: numberValue(f.discountValue),
    originalPrice: numberValue(f.originalPrice),
    offerPrice: numberValue(f.offerPrice),
    startsAt: f.startsAt.timestampValue!,
    expiresAt: f.expiresAt.timestampValue!,
    testIds: (f.testIds.arrayValue?.values || []).map((value) => value.stringValue!),
    eligibility: f.eligibility.stringValue as Offer['eligibility'],
    createdAt: f.createdAt.timestampValue!,
    usedCount: numberValue(f.usedCount),
  };
}
async function readJson(request: Request) {
  if (Number(request.headers.get('content-length')) > 32000)
    throw new CatalogError(413, 'Catalog details are too large.');
  if (!request.body) return {};
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 32000) {
      await reader.cancel();
      throw new CatalogError(413, 'Catalog details are too large.');
    }
    parts.push(value);
  }
  const all = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    all.set(part, offset);
    offset += part.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(all));
}

export async function handleAccountCatalog(
  request: Request,
  env: AccountCatalogEnvironment,
  send: typeof fetch = fetch,
): Promise<Response> {
  try {
    if (!['GET', 'POST'].includes(request.method))
      return json({ error: 'Method not allowed' }, 405);
    if (request.method === 'POST' && !allowedRequestOrigin(request, env.appOrigin))
      throw new CatalogError(403, 'Request origin is not allowed');
    const authorization = request.headers.get('authorization') || '';
    const token =
      authorization.length < 16384 ? authorization.match(/^Bearer (\S+)$/)?.[1] : undefined;
    if (!token) throw new CatalogError(401, 'Sign in with Google to manage tests and offers.');
    const auth = await send(
      `${env.authOrigin || 'https://identitytoolkit.googleapis.com'}/v1/accounts:lookup?key=${encodeURIComponent(env.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: token }),
        signal: AbortSignal.timeout(15000),
      },
    );
    const user = (await auth.json()).users?.[0];
    if (!auth.ok || !user || user.disabled)
      throw new CatalogError(401, 'Your sign-in has expired. Please sign in again.');
    if (!user.emailVerified)
      throw new CatalogError(403, 'Use a verified Google account to manage your catalog.');
    const uid = user.localId;
    if (typeof uid !== 'string' || !uid || uid.length > 128 || uid.includes('/'))
      throw new CatalogError(401, 'Unable to verify your account. Please sign in again.');
    const documents = `${env.firestoreOrigin || 'https://firestore.googleapis.com'}/v1/projects/${env.projectId}/databases/(default)/documents`;
    const parent = `${documents}/bpl_customerWorkspaces/${encodeURIComponent(uid)}`;
    const nameParent = `projects/${env.projectId}/databases/(default)/documents/bpl_customerWorkspaces/${uid}`;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const path = new URL(request.url).pathname.replace(/\/$/, '');
    const commit = (writes: unknown[]) =>
      send(`${documents}:commit`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ writes }),
        signal: AbortSignal.timeout(25000),
      });
    const batchGet = async (ids: string[]) => {
      if (!ids.length) return new Map<string, Document>();
      const response = await send(`${documents}:batchGet`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ documents: ids.map((id) => `${nameParent}/tests/${id}`) }),
        signal: AbortSignal.timeout(25000),
      });
      if (!response.ok)
        throw new CatalogError(503, 'Unable to read your test catalog. Please try again.');
      const rows = await response.json();
      if (!Array.isArray(rows))
        throw new CatalogError(503, 'Unable to read your test catalog. Please try again.');
      const found = new Map<string, Document>();
      for (const row of rows) if (row.found) found.set(idFromName(row.found.name), row.found);
      return found;
    };
    const count = async (priced: boolean) => {
      const response = await send(`${parent}:runAggregationQuery`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          structuredAggregationQuery: {
            structuredQuery: {
              from: [{ collectionId: 'tests' }],
              ...(priced
                ? {
                    where: {
                      fieldFilter: {
                        field: { fieldPath: 'price' },
                        op: 'GREATER_THAN_OR_EQUAL',
                        value: numeric(0),
                      },
                    },
                  }
                : {}),
            },
            aggregations: [{ alias: 'total', count: {} }],
          },
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok)
        throw new CatalogError(503, 'Unable to load catalog totals. Please try again.');
      const rows = await response.json();
      const value = rows.find((row: { result?: unknown }) => row.result)?.result?.aggregateFields
        ?.total?.integerValue;
      if (value === undefined)
        throw new CatalogError(503, 'Unable to load catalog totals. Please try again.');
      return Number(value);
    };
    if (path === '/api/account/catalog' && request.method === 'GET') {
      const list = async (collection: string, order: string, limit: number) => {
        const [fieldPath, direction = 'asc'] = order.split(' ');
        const response = await send(`${parent}:runQuery`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            structuredQuery: {
              from: [{ collectionId: collection }],
              orderBy: [
                {
                  field: { fieldPath },
                  direction: direction === 'desc' ? 'DESCENDING' : 'ASCENDING',
                },
              ],
              limit: limit + 1,
            },
          }),
          signal: AbortSignal.timeout(20000),
        });
        if (!response.ok)
          throw new CatalogError(503, 'Unable to load your catalog and offers. Please try again.');
        const rows = await response.json();
        const documents = rows
          .filter((row: { document?: Document }) => row.document)
          .map((row: { document: Document }) => row.document);
        return { documents: documents.slice(0, limit), truncated: documents.length > limit };
      };
      const [tests, offers, totalTests, pricedTests] = await Promise.all([
        list('tests', 'name', 1000),
        list('offers', 'createdAt desc', 200),
        count(false),
        count(true),
      ]);
      return json({
        tests: (tests.documents || []).map(fromTest),
        offers: (offers.documents || []).map(fromOffer),
        totalTests,
        pricedTests,
        truncated: tests.truncated || offers.truncated,
        testsTruncated: tests.truncated,
        offersTruncated: offers.truncated,
        limits: { tests: 1000, offers: 200 },
      });
    }
    if (request.method === 'POST' && path === '/api/account/catalog/import-reference') {
      const parsed = z
        .object({})
        .strict()
        .safeParse(await readJson(request));
      if (!parsed.success)
        throw new CatalogError(400, 'Reference import does not accept rate overrides.');
      let imported = 0;
      let skipped = 0;
      for (let offset = 0; offset < REFERENCE_TESTS.length; offset += 400) {
        let remaining = REFERENCE_TESTS.slice(offset, offset + 400);
        for (let attempt = 0; remaining.length; attempt++) {
          const existing = await batchGet(remaining.map((test) => test.id));
          skipped += existing.size;
          remaining = remaining.filter((test) => !existing.has(test.id));
          if (!remaining.length) break;
          if (attempt >= 3)
            throw new CatalogError(
              409,
              'Your catalog changed during import. Retry to add the remaining reference tests. Existing rates are preserved.',
            );
          const timestamp = new Date().toISOString();
          const writes = remaining.map((test) => {
            const parsedTest = catalogInputSchema.parse({
              id: test.id,
              name: test.name,
              category: test.category,
              aliases: [...test.aliases],
              type: 'test',
              price: null,
            });
            return {
              update: {
                name: `${nameParent}/tests/${test.id}`,
                fields: {
                  ownerId: str(uid),
                  id: str(test.id),
                  name: str(parsedTest.name),
                  type: str('test'),
                  price: { nullValue: null },
                  category: str(parsedTest.category),
                  aliases: list(parsedTest.aliases),
                  createdAt: { timestampValue: timestamp },
                  updatedAt: { timestampValue: timestamp },
                },
              },
              currentDocument: { exists: false },
            };
          });
          const saved = await commit(writes);
          if (saved.ok) {
            imported += remaining.length;
            break;
          }
          // A concurrent import may create a subset. Re-read and retry only still-missing IDs.
          if (![400, 403, 409, 412].includes(saved.status))
            throw new CatalogError(
              503,
              'Unable to import reference tests. Existing rates were preserved; please retry.',
            );
        }
      }
      return json({
        imported,
        skipped,
        totalReference: REFERENCE_TESTS.length,
        message: `Added ${imported} reference tests. Existing tests and rates were preserved.`,
      });
    }
    const edit = path.match(/^\/api\/account\/catalog\/([A-Za-z0-9_-]{1,100})$/);
    if (request.method === 'POST' && (path === '/api/account/catalog' || edit)) {
      const parsed = catalogInputSchema.safeParse(await readJson(request));
      if (!parsed.success)
        throw new CatalogError(400, parsed.error.issues.map((issue) => issue.message).join('. '));
      const input = parsed.data;
      if (edit && input.id && input.id !== edit[1])
        throw new CatalogError(400, 'The test ID does not match the selected catalog entry.');
      const id = edit?.[1] || input.id || `BPL-CAT-${crypto.randomUUID()}`;
      const response = await send(`${parent}/tests/${id}`, {
        headers,
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok && response.status !== 404)
        throw new CatalogError(503, 'Unable to read this catalog entry. Please try again.');
      const previous = response.ok ? await response.json() : null;
      const timestamp = new Date().toISOString();
      const fields = {
        ownerId: str(uid),
        id: str(id),
        name: str(input.name),
        type: str(input.type),
        price: input.price === null ? { nullValue: null } : numeric(input.price),
        category: str(input.category),
        aliases: list(input.aliases),
        createdAt: { timestampValue: previous?.fields.createdAt.timestampValue || timestamp },
        updatedAt: { timestampValue: timestamp },
      };
      const saved = await commit([
        {
          update: { name: `${nameParent}/tests/${id}`, fields },
          currentDocument: previous ? { updateTime: previous.updateTime } : { exists: false },
        },
      ]);
      if (!saved.ok)
        throw new CatalogError(
          [409, 412].includes(saved.status) ? 409 : 503,
          'Unable to save this catalog entry. Refresh the catalog and try again.',
        );
      const entry = fromTest({ name: `${nameParent}/tests/${id}`, fields });
      return json({ ...entry, test: entry }, previous ? 200 : 201);
    }
    if (request.method === 'POST' && path === '/api/account/offers') {
      const raw = await readJson(request);
      const parsed = offerSchema.safeParse(raw);
      if (!parsed.success)
        throw new CatalogError(400, parsed.error.issues.map((issue) => issue.message).join('. '));
      const input = parsed.data;
      const allowed = [
        'title',
        'description',
        'type',
        'discountType',
        'discountValue',
        'originalPrice',
        'startsAt',
        'expiresAt',
        'testIds',
        'eligibility',
      ];
      if (Object.keys(raw as object).some((key) => !allowed.includes(key)))
        throw new CatalogError(400, 'Enter only the offer fields shown in this form.');
      if (
        input.testIds.length > 20 ||
        new Set(input.testIds).size !== input.testIds.length ||
        input.testIds.some((id) => !/^[A-Za-z0-9_-]{1,100}$/.test(id))
      )
        throw new CatalogError(400, 'Select up to 20 distinct saved tests or packages.');
      if (input.discountType === 'fixed' && !Number.isInteger(input.discountValue))
        throw new CatalogError(400, 'Fixed discounts must use whole paise.');
      const records = await batchGet(input.testIds);
      if (records.size !== input.testIds.length)
        throw new CatalogError(400, 'Select tests or packages saved in your own catalog.');
      let originalPrice = 0;
      for (const id of input.testIds) {
        const price = records.get(id)!.fields.price;
        if (!price || 'nullValue' in price)
          throw new CatalogError(
            400,
            'Set a lab rate for every selected test or package before creating an offer.',
          );
        const value = numberValue(price);
        if (!Number.isSafeInteger(value) || value <= 0)
          throw new CatalogError(
            400,
            'Selected tests and packages need a positive lab rate before an offer can be created.',
          );
        originalPrice += value;
      }
      if (originalPrice !== input.originalPrice)
        throw new CatalogError(
          400,
          'Catalog rates changed. Select the tests again so the original price matches their current total.',
        );
      const id = `BPL-OFFER-${crypto.randomUUID()}`;
      const timestamp = new Date().toISOString();
      const offer: Offer = {
        ...input,
        id,
        offerPrice: finalPrice(originalPrice, input.discountType, input.discountValue),
        createdAt: timestamp,
        usedCount: 0,
      };
      const fields = {
        ownerId: str(uid),
        id: str(id),
        title: str(offer.title),
        description: str(offer.description),
        type: str(offer.type),
        discountType: str(offer.discountType),
        discountValue: numeric(offer.discountValue),
        originalPrice: numeric(offer.originalPrice),
        offerPrice: numeric(offer.offerPrice),
        startsAt: { timestampValue: offer.startsAt },
        expiresAt: { timestampValue: offer.expiresAt },
        testIds: list(offer.testIds),
        eligibility: str(offer.eligibility),
        createdAt: { timestampValue: timestamp },
        usedCount: numeric(0),
      };
      const saved = await commit([
        {
          update: { name: `${nameParent}/offers/${id}`, fields },
          currentDocument: { exists: false },
        },
      ]);
      if (!saved.ok) throw new CatalogError(503, 'Unable to save this offer. Please try again.');
      return json({ ...offer, offer }, 201);
    }
    throw new CatalogError(404, 'Route not found');
  } catch (error) {
    if (error instanceof CatalogError) return json({ error: error.message }, error.status);
    if (error instanceof SyntaxError)
      return json({ error: 'Enter valid catalog or offer details.' }, 400);
    return json({ error: 'Unable to load or save your catalog. Please try again.' }, 503);
  }
}
