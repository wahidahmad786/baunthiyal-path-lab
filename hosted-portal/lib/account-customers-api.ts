import type { Customer } from './domain';
import { customerConsentSchema, customerInputSchema } from './customer-input';

export type AccountCustomerEnvironment = {
  projectId: string;
  apiKey: string;
  authOrigin?: string;
  firestoreOrigin?: string;
};

type FirestoreValue = {
  stringValue?: string;
  timestampValue?: string;
  integerValue?: string;
  mapValue?: { fields: Record<string, FirestoreValue> };
  arrayValue?: { values?: FirestoreValue[] };
};
type FirestoreDocument = { name: string; fields: Record<string, FirestoreValue> };

class CustomerError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const string = (value: string): FirestoreValue => ({ stringValue: value });
const array = (values: string[]): FirestoreValue => ({
  arrayValue: { values: values.map(string) },
});

async function readInput(request: Request) {
  if (Number(request.headers.get('content-length')) > 16384)
    throw new CustomerError(413, 'Customer details are too large.');
  if (!request.body) throw new CustomerError(400, 'Enter customer details.');
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 16384) {
      await reader.cancel();
      throw new CustomerError(413, 'Customer details are too large.');
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

async function customerId(phone: string) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(phone))),
    (byte) => byte.toString(16).padStart(2, '0'),
  )
    .join('')
    .slice(0, 32);
}

function fromDocument(document: FirestoreDocument): Customer {
  const fields = document.fields;
  const marketing = fields.marketing.mapValue!.fields;
  return {
    id: fields.id.stringValue!,
    name: fields.name.stringValue!,
    phone: fields.phone.stringValue!,
    createdAt: fields.createdAt.timestampValue!,
    groups: (fields.groups.arrayValue?.values || []).map((value) => value.stringValue!),
    testIds: (fields.testIds.arrayValue?.values || []).map((value) => value.stringValue!),
    visits: Number(fields.visits.integerValue),
    marketing: {
      status: marketing.status.stringValue as Customer['marketing']['status'],
      source: marketing.source.stringValue!,
      at: marketing.at.timestampValue!,
    },
    ...(fields.age ? { age: Number(fields.age.integerValue) } : {}),
  };
}

export async function handleAccountCustomers(
  request: Request,
  env: AccountCustomerEnvironment,
  send: typeof fetch = fetch,
): Promise<Response> {
  try {
    if (!['GET', 'POST'].includes(request.method))
      return json({ error: 'Method not allowed' }, 405);
    if (request.method === 'POST' && request.headers.get('origin') !== new URL(request.url).origin)
      throw new CustomerError(403, 'Request origin is not allowed');
    const authorization = request.headers.get('authorization') || '';
    const token =
      authorization.length < 16384 ? authorization.match(/^Bearer (\S+)$/)?.[1] : undefined;
    if (!token) throw new CustomerError(401, 'Sign in with Google to save and view customers.');
    const authResponse = await send(
      `${env.authOrigin || 'https://identitytoolkit.googleapis.com'}/v1/accounts:lookup?key=${encodeURIComponent(env.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: token }),
        signal: AbortSignal.timeout(15000),
      },
    );
    const user = (await authResponse.json()).users?.[0];
    if (!authResponse.ok || !user || user.disabled)
      throw new CustomerError(401, 'Your sign-in has expired. Please sign in again.');
    if (!user.emailVerified)
      throw new CustomerError(403, 'Use a verified Google account to register customers.');
    const uid = user.localId;
    if (typeof uid !== 'string' || !uid || uid.length > 128 || uid.includes('/'))
      throw new CustomerError(401, 'Unable to verify your account. Please sign in again.');
    const documents = `${env.firestoreOrigin || 'https://firestore.googleapis.com'}/v1/projects/${env.projectId}/databases/(default)/documents`;
    const parent = `${documents}/bpl_customerWorkspaces/${encodeURIComponent(uid)}`;
    const customerPath = `projects/${env.projectId}/databases/(default)/documents/bpl_customerWorkspaces/${uid}/customers`;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const pathname = new URL(request.url).pathname;
    const consentMatch = pathname.match(/^\/api\/account\/customers\/([a-f0-9]{32})\/consent\/?$/);
    if (consentMatch) {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      const parsed = customerConsentSchema.safeParse(await readInput(request));
      if (!parsed.success)
        throw new CustomerError(400, parsed.error.issues.map((issue) => issue.message).join('. '));
      const id = consentMatch[1];
      const existing = await send(`${parent}/customers/${id}`, {
        headers,
        signal: AbortSignal.timeout(15000),
      });
      if (existing.status === 404)
        throw new CustomerError(404, 'Customer not found in your audience.');
      if (!existing.ok)
        throw new CustomerError(503, 'Unable to load this customer. Please try again.');
      const document = await existing.json();
      const eventId = crypto.randomUUID();
      const timestamp = new Date().toISOString();
      const { status, source } = parsed.data;
      const marketing = {
        mapValue: {
          fields: {
            status: string(status),
            source: string(source),
            at: { timestampValue: timestamp },
            eventId: string(eventId),
          },
        },
      };
      const saved = await send(`${documents}:commit`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          writes: [
            {
              update: { name: `${customerPath}/${id}`, fields: { marketing } },
              updateMask: { fieldPaths: ['marketing'] },
              currentDocument: { updateTime: document.updateTime },
            },
            {
              update: {
                name: `${customerPath.replace(/\/customers$/, '/consentEvents')}/${eventId}`,
                fields: {
                  ownerId: string(uid),
                  customerId: string(id),
                  status: string(status),
                  source: string(source),
                  actor: string(uid),
                  createdAt: { timestampValue: timestamp },
                },
              },
              currentDocument: { exists: false },
            },
          ],
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!saved.ok) {
        const failure = await saved.json().catch(() => ({}));
        if (
          saved.status === 409 ||
          saved.status === 412 ||
          failure.error?.status === 'FAILED_PRECONDITION'
        )
          throw new CustomerError(
            409,
            'This customer changed while you were editing. Refresh and try again.',
          );
        throw new CustomerError(503, 'Unable to update this preference. Please try again.');
      }
      return json({
        customer: fromDocument({ ...document, fields: { ...document.fields, marketing } }),
      });
    }
    if (!/^\/api\/account\/customers\/?$/.test(pathname))
      throw new CustomerError(404, 'Route not found');

    if (request.method === 'GET') {
      const count = async (optedIn: boolean) => {
        const query = {
          from: [{ collectionId: 'customers' }],
          ...(optedIn
            ? {
                where: {
                  fieldFilter: {
                    field: { fieldPath: 'marketing.status' },
                    op: 'EQUAL',
                    value: string('opted_in'),
                  },
                },
              }
            : {}),
        };
        const response = await send(`${parent}:runAggregationQuery`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            structuredAggregationQuery: {
              structuredQuery: query,
              aggregations: [{ alias: 'total', count: {} }],
            },
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok)
          throw new CustomerError(503, 'Unable to load customer totals. Please try again.');
        const result = await response.json();
        const value = result.find((item: { result?: unknown }) => item.result)?.result
          ?.aggregateFields?.total?.integerValue;
        if (value === undefined)
          throw new CustomerError(503, 'Unable to load customer totals. Please try again.');
        return Number(value);
      };
      const [response, totalCustomers, optedIn] = await Promise.all([
        send(`${parent}/customers?pageSize=1000&orderBy=createdAt%20desc`, {
          headers,
          signal: AbortSignal.timeout(15000),
        }),
        count(false),
        count(true),
      ]);
      if (!response.ok)
        throw new CustomerError(503, 'Unable to load your customers. Please try again.');
      const result = await response.json();
      return json({
        customers: (result.documents || []).map(fromDocument),
        totalCustomers,
        optedIn,
        truncated: !!result.nextPageToken,
        limits: { customers: 1000 },
      });
    }

    const parsed = customerInputSchema.safeParse(await readInput(request));
    if (!parsed.success)
      throw new CustomerError(400, parsed.error.issues.map((issue) => issue.message).join('. '));
    const input = parsed.data;
    const id = await customerId(input.phone);
    const alreadyRegistered = await send(`${parent}/customers/${id}`, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (alreadyRegistered.ok)
      throw new CustomerError(
        409,
        'This phone number is already registered in your customer audience.',
      );
    if (alreadyRegistered.status !== 404)
      throw new CustomerError(503, 'Unable to check this customer. Please try again.');
    const timestamp = new Date().toISOString();
    const status = input.marketingConsent ? 'opted_in' : 'not_asked';
    const eventId = input.marketingConsent ? crypto.randomUUID() : '';
    const customer: Customer = {
      id,
      name: input.name,
      phone: input.phone,
      createdAt: timestamp,
      groups: input.groups,
      testIds: [],
      visits: 0,
      marketing: { status, source: input.consentSource, at: timestamp },
      ...(input.age === undefined ? {} : { age: input.age }),
    };
    const fields: Record<string, FirestoreValue> = {
      ownerId: string(uid),
      id: string(id),
      name: string(customer.name),
      phone: string(customer.phone),
      createdAt: { timestampValue: timestamp },
      groups: array(customer.groups),
      testIds: array([]),
      visits: { integerValue: '0' },
      marketing: {
        mapValue: {
          fields: {
            status: string(status),
            source: string(input.consentSource),
            at: { timestampValue: timestamp },
            eventId: string(eventId),
          },
        },
      },
      ...(input.age === undefined ? {} : { age: { integerValue: String(input.age) } }),
    };
    const writes: unknown[] = [
      { update: { name: `${customerPath}/${id}`, fields }, currentDocument: { exists: false } },
    ];
    if (input.marketingConsent) {
      writes.push({
        update: {
          name: `${customerPath.replace(/\/customers$/, '/consentEvents')}/${eventId}`,
          fields: {
            ownerId: string(uid),
            customerId: string(id),
            status: string('opted_in'),
            source: string(input.consentSource),
            actor: string(uid),
            createdAt: { timestampValue: timestamp },
          },
        },
        currentDocument: { exists: false },
      });
    }
    const saved = await send(`${documents}:commit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ writes }),
      signal: AbortSignal.timeout(15000),
    });
    if (!saved.ok) {
      const failure = await saved.json().catch(() => ({}));
      if (saved.status === 409 || failure.error?.status === 'ALREADY_EXISTS')
        throw new CustomerError(
          409,
          'This phone number is already registered in your customer audience.',
        );
      // Concurrent registrations may fail rules before the exists:false precondition.
      // Inspect only this account's record before reporting an actionable duplicate error.
      const raced = await send(`${parent}/customers/${id}`, {
        headers,
        signal: AbortSignal.timeout(15000),
      });
      if (raced.ok)
        throw new CustomerError(
          409,
          'This phone number is already registered in your customer audience.',
        );
      throw new CustomerError(503, 'Unable to save this customer. Please try again.');
    }
    return json({ ...customer, customer }, 201);
  } catch (error) {
    if (error instanceof CustomerError) return json({ error: error.message }, error.status);
    if (error instanceof SyntaxError) return json({ error: 'Enter valid customer details.' }, 400);
    return json({ error: 'Unable to save or load customers. Please try again.' }, 503);
  }
}
