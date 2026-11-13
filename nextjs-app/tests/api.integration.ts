import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { deleteApp } from 'firebase-admin/app';
import { initializeApp as initializeClientApp, deleteApp as deleteClientApp } from 'firebase/app';
import {
  getAuth,
  connectAuthEmulator,
  GoogleAuthProvider,
  signInWithCredential,
  signOut,
} from 'firebase/auth';
import { auth, db, adminApp } from '../lib/server/firebase';
import { col } from '../lib/server/service';
process.env.FIREBASE_PROJECT_ID ||= process.env.GCLOUD_PROJECT;
if (
  process.env.FIREBASE_PROJECT_ID !== 'demo-bpl' ||
  !process.env.FIRESTORE_EMULATOR_HOST ||
  !process.env.FIREBASE_AUTH_EMULATOR_HOST
)
  throw new Error('HTTP integration tests must use the isolated demo-bpl emulators');
const origin = 'https://lab.example.test';
const base = 'http://127.0.0.1:3101';
let server: ChildProcess;
let session = '';
let offerId = '';
let campaignId = '';
let trackingToken = '';
let customerId = '';
let bookingId = '';
let jobId = '';
let output = '';
let accountBearer = '';
async function request(
  path: string,
  body?: unknown,
  authenticated = false,
  extra: Record<string, string> = {},
) {
  return fetch(base + '/api/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      origin,
      'Content-Type': 'application/json',
      ...(authenticated ? { cookie: session } : {}),
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
before(async () => {
  server = spawn(
    process.execPath,
    ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3101'],
    {
      env: {
        ...process.env,
        APP_URL: origin,
        GOOGLE_APPLICATION_CREDENTIALS: '',
        FIREBASE_STORAGE_BUCKET: '',
        FIREBASE_CLIENT_EMAIL: '',
        FIREBASE_PRIVATE_KEY: '',
        FIREBASE_USE_ADC: 'false',
        NEXT_PUBLIC_FIREBASE_API_KEY: 'emulator-key',
        NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'demo-bpl.firebaseapp.com',
        NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'demo-bpl',
        WHATSAPP_APP_SECRET: 'api-test-app-secret',
        WHATSAPP_CONNECTION_ENCRYPTION_KEY: 'b'.repeat(64),
        WHATSAPP_SERVICE_ACCOUNT_FILE: '',
        WHATSAPP_SERVICE_ACCOUNT_JSON: '',
        WHATSAPP_WEBHOOK_BASE_URL: origin,
        WHATSAPP_WEBHOOK_PUBLIC_READY: 'true',
        WHATSAPP_PHONE_NUMBER_ID: 'api-test-phone',
        PUBLIC_RATE_LIMIT_SECRET: 'test-only-rate-secret-32-characters-long',
        CRON_SECRET: 'test-only-worker-secret-32-characters-long',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  server.stdout?.on('data', (d) => (output += d));
  server.stderr?.on('data', (d) => (output += d));
  const started = Date.now();
  while (Date.now() - started < 30000) {
    if (server.exitCode !== null) throw new Error('HTTP test server failed: ' + output);
    try {
      if ((await fetch(base)).ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!(await fetch(base)).ok) throw new Error('HTTP test server did not become ready');
  const user = await auth().createUser({
    uid: 'http-test-admin',
    email: 'admin@example.test',
    password: 'emulator-only-password',
  });
  await auth().setCustomUserClaims(user.uid, { bplAdmin: true });
  const login = await fetch(
    `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=emulator-only`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@example.test',
        password: 'emulator-only-password',
        returnSecureToken: true,
      }),
    },
  );
  const { idToken } = await login.json();
  assert.ok(idToken);
  const res = await request('session', { idToken });
  assert.equal(res.status, 200, await res.clone().text());
  session = res.headers.get('set-cookie')!.split(';')[0];
});
after(async () => {
  if (server?.exitCode === null) {
    server.kill('SIGTERM');
    await once(server, 'exit');
  }
  await deleteApp(adminApp());
});
test('Google sign-in links the pre-authorized account and server rejects other Google accounts', async () => {
  const owner = await auth().createUser({
    uid: 'google-test-lab-owner',
    email: 'google-owner@example.test',
    emailVerified: true,
  });
  await auth().setCustomUserClaims(owner.uid, { bplAdmin: true });
  const client = initializeClientApp(
    { projectId: 'demo-bpl', apiKey: 'emulator-only' },
    'google-signin-test',
  );
  const clientAuth = getAuth(client);
  connectAuthEmulator(clientAuth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, {
    disableWarnings: true,
  });
  async function googleLogin(email: string, sub: string) {
    // Unsigned provider credentials are accepted only by the isolated Auth emulator.
    const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const token = `${encoded({ alg: 'none', typ: 'JWT' })}.${encoded({
      iss: 'https://accounts.google.com',
      aud: 'emulator-only',
      sub,
      email,
      email_verified: true,
      iat: now,
      exp: now + 3600,
    })}.`;
    return signInWithCredential(clientAuth, GoogleAuthProvider.credential(token));
  }
  try {
    const credential = await googleLogin('google-owner@example.test', 'google-owner-subject');
    assert.equal(
      credential.user.uid,
      owner.uid,
      'Google must retain the existing administrator UID',
    );
    const token = await credential.user.getIdTokenResult(true);
    assert.equal(token.signInProvider, 'google.com');
    assert.equal(token.claims.bplAdmin, true);
    accountBearer = token.token;
    const login = await request('session', { idToken: token.token });
    assert.equal(login.status, 200, await login.clone().text());
    assert.match(login.headers.get('set-cookie') || '', /HttpOnly/i);
    await signOut(clientAuth);
    const outsider = await googleLogin('google-other@example.test', 'google-other-subject');
    const rejected = await request('session', { idToken: await outsider.user.getIdToken() });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.get('set-cookie'), null);
  } finally {
    await signOut(clientAuth);
    await deleteClientApp(client);
  }
});
test('public HTTPS account saves work through the internal HTTP server and foreign origins remain blocked', async () => {
  assert.ok(accountBearer);
  const headers = { Authorization: `Bearer ${accountBearer}` };
  const input = {
    phone: '+15551869875',
    phoneNumberId: '123456789',
    businessAccountId: '987654321',
    appId: '555555555',
    accessToken: 'emulator-api-access-token-123456789',
    appSecret: 'emulator-api-secret-123456789',
    verifyToken: 'emulator-http-proxy-verification-token',
    verify: false,
  };
  const saved = await request('whatsapp/integration', input, false, headers);
  assert.equal(saved.status, 200, await saved.clone().text());
  const data = await saved.json();
  assert.equal(data.connection.verifyTokenSaved, true);
  assert.equal(data.webhook.callbackUrl, `${origin}/webhook/google-test-lab-owner`);
  assert.ok(!JSON.stringify(data).includes(input.verifyToken));
  const copied = await request('whatsapp/integration/verification-token', {}, false, headers);
  assert.equal(copied.status, 200);
  assert.equal((await copied.json()).verifyToken, input.verifyToken);
  const foreign = await request('whatsapp/integration', input, false, {
    ...headers,
    origin: 'https://attacker.example',
  });
  assert.equal(foreign.status, 403);
  const customer = await request(
    'account/customers',
    {
      name: 'Proxy Test Customer',
      phone: '+919876543211',
      marketingConsent: false,
      consentSource: 'Emulator test only',
      groups: [],
    },
    false,
    headers,
  );
  assert.equal(customer.status, 201, await customer.clone().text());
  const catalog = await request(
    'account/catalog',
    { name: 'Proxy Test Assay', type: 'test', price: 10000, category: 'General', aliases: [] },
    false,
    headers,
  );
  assert.equal(catalog.status, 201, await catalog.clone().text());
  assert.equal((await fetch(base + '/webhook/google-test-lab-owner')).status, 403);
  assert.equal(
    (await fetch(base + '/webhook/google-test-lab-owner', { method: 'POST', body: '{}' })).status,
    403,
  );
});
test('branded page renders and all patient/campaign records require administrator access', async () => {
  const page = await fetch(base);
  assert.match(await page.text(), /Baunthiyal Path Lab/);
  assert.equal((await request('state')).status, 401);
  assert.equal((await request('setup')).status, 401);
  const health = await request('health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');
  assert.equal((await request('export?format=xlsx')).status, 401);
  assert.equal(
    (
      await request('customers', {
        name: 'Private Customer',
        phone: '9999999999',
        marketingConsent: true,
        consentSource: 'test',
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request('customers', { name: 'Private Customer' }, true, {
        origin: 'https://attacker.example',
      })
    ).status,
    403,
  );
});
test('registration keeps marketing unselected and offer creation uses real catalog records', async () => {
  let res = await request(
    'customers',
    {
      name: 'HTTP Test Customer',
      phone: '+91 98765 43219',
      marketingConsent: false,
      consentSource: 'in_person_registration',
    },
    true,
  );
  assert.equal(res.status, 201, await res.clone().text());
  customerId = (await res.json()).id;
  assert.equal(
    (await col('customers').doc(customerId).get()).data()?.marketing.status,
    'not_asked',
  );
  res = await request(
    'tests',
    { name: 'HTTP Complete Checkup', price: 149900, type: 'package' },
    true,
  );
  assert.equal(res.status, 201);
  const testId = (await res.json()).id;
  res = await request(
    'offers',
    {
      title: 'HTTP Wellness Offer',
      description: 'A health checkup test offer',
      type: 'Full Body Checkup',
      discountType: 'fixed',
      discountValue: 50000,
      originalPrice: 149900,
      startsAt: new Date(Date.now() - 3600000).toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      testIds: [testId],
      eligibility: 'all',
    },
    true,
  );
  assert.equal(res.status, 201, await res.clone().text());
  const offer = await res.json();
  offerId = offer.id;
  assert.match(offerId, /BPL-OFFER-/);
  assert.equal(offer.offerPrice, 99900);
  res = await request(
    'campaigns',
    {
      name: 'HTTP Campaign',
      type: 'Health package',
      offerId,
      templateId: '',
      variables: {},
      audience: { type: 'all', testIds: [], groups: [], customerIds: [] },
      scheduledAt: null,
      bannerPath: '',
    },
    true,
  );
  assert.equal(res.status, 201);
  const c = await res.json();
  campaignId = c.id;
  trackingToken = c.trackingToken;
  assert.equal(c.status, 'draft');
  assert.equal((await request('public/offer/' + trackingToken)).status, 410);
});
test('public links expose offers only, bookings are deduplicated, and marketing requests remain unverified', async () => {
  await col('campaigns').doc(campaignId).update({ status: 'running' });
  const offer = await request('public/offer/' + trackingToken);
  assert.equal(offer.status, 200);
  const payload = await offer.json();
  assert.equal(payload.offer.title, 'HTTP Wellness Offer');
  assert.equal(payload.customers, undefined);
  assert.equal(payload.phone, undefined);
  const input = {
    name: 'HTTP Test Customer',
    phone: '+91 98765 43219',
    marketingConsent: true,
    website: '',
  };
  const res = await request('public/book/' + trackingToken, input, false, {
    'x-forwarded-for': '127.0.0.2',
  });
  assert.equal(res.status, 201, await res.clone().text());
  assert.equal(
    (
      await request('public/book/' + trackingToken, input, false, {
        'x-forwarded-for': '127.0.0.2',
      })
    ).status,
    409,
  );
  assert.equal(
    (await col('customers').doc(customerId).get()).data()?.marketing.status,
    'not_asked',
  );
  const bookings = await col('bookings').where('campaignId', '==', campaignId).get();
  assert.equal(bookings.size, 1);
  bookingId = bookings.docs[0].id;
  assert.equal((await col('notifications').where('bookingId', '==', bookingId).get()).size, 1);
  assert.equal(
    (await col('consentRequests').where('bookingId', '==', bookingId).get()).docs[0].data().status,
    'pending_phone_verification',
  );
});
test('job cards apply the actual offer, duplicate creation is rejected, and payments cannot exceed balance', async () => {
  let res = await request(`bookings/${bookingId}/job`, { customerId }, true);
  assert.equal(res.status, 200, await res.clone().text());
  jobId = (await res.json()).jobId;
  const job = (await col('jobs').doc(jobId).get()).data()!;
  assert.equal(job.total, 99900);
  assert.equal(job.discount, 50000);
  assert.equal(job.paid, 0);
  assert.equal((await request(`bookings/${bookingId}/job`, { customerId }, true)).status, 409);
  res = await request(
    `jobs/${jobId}/payments`,
    { amount: 50000, method: 'upi', reference: 'http-payment-1' },
    true,
  );
  assert.equal(res.status, 200);
  assert.equal(
    (
      await request(
        `jobs/${jobId}/payments`,
        { amount: 50000, method: 'upi', reference: 'http-payment-1' },
        true,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await request(
        `jobs/${jobId}/payments`,
        { amount: 50000, method: 'upi', reference: 'http-payment-2' },
        true,
      )
    ).status,
    400,
  );
  assert.equal((await col('jobs').doc(jobId).get()).data()?.paid, 50000);
});
test('private branded receipts and aggregate Excel/PDF reports are generated from stored records', async () => {
  const receipt = await request(`jobs/${jobId}/receipt`, undefined, true);
  assert.equal(receipt.status, 200);
  assert.equal(receipt.headers.get('content-type'), 'application/pdf');
  assert.equal((await receipt.arrayBuffer()).byteLength > 500, true);
  assert.equal((await request(`jobs/${jobId}/receipt`)).status, 401);
  const excel = await request('export?format=xlsx', undefined, true);
  assert.equal(excel.status, 200);
  assert.match(excel.headers.get('content-disposition')!, /BPL-campaign-results\.xlsx/);
  const workbook = Buffer.from(await excel.arrayBuffer());
  assert.equal(workbook.subarray(0, 2).toString(), 'PK');
  const pdf = await request('export?format=pdf', undefined, true);
  assert.equal(pdf.status, 200);
  assert.equal(
    Buffer.from(await pdf.arrayBuffer())
      .subarray(0, 4)
      .toString(),
    '%PDF',
  );
});
test('webhooks reject unsigned requests and worker execution requires its own secret', async () => {
  assert.equal((await request('worker', {})).status, 401);
  const webhook = await request('webhook', { object: 'whatsapp_business_account' });
  assert.equal(webhook.status, 401);
});

test('signed STOP events withdraw consent once and preserve the essential notification boundary', async () => {
  const consent = await request(
    `customers/${customerId}/consent`,
    { status: 'opted_in', source: 'verified_in_person_test', confirmed: true },
    true,
  );
  assert.equal(consent.status, 200);
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: 'api-test-phone' },
              messages: [{ id: 'http-stop-1', from: '919876543219', text: { body: 'STOP' } }],
            },
          },
        ],
      },
    ],
  };
  const signature =
    'sha256=' +
    createHmac('sha256', 'api-test-app-secret').update(JSON.stringify(payload)).digest('hex');
  assert.equal(
    (await request('webhook', payload, false, { 'x-hub-signature-256': signature })).status,
    200,
  );
  assert.equal(
    (await request('webhook', payload, false, { 'x-hub-signature-256': signature })).status,
    200,
  );
  const customer = (await col('customers').doc(customerId).get()).data()!;
  assert.equal(customer.marketing.status, 'opted_out');
  assert.equal(customer.essentialNotifications, undefined);
  const events = await col('consentEvents').where('customerId', '==', customerId).get();
  assert.equal(events.docs.filter((d) => d.data().source === 'whatsapp_stop').length, 1);
});

test('administrator setup verification checks real emulator services without exposing records or credentials', async () => {
  const response = await request('setup', undefined, true);
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(
    report.checks.find((c: { name: string }) => c.name === 'Firestore').status,
    'verified',
  );
  assert.equal(
    report.checks.find((c: { name: string }) => c.name === 'Firebase Authentication').status,
    'verified',
  );
  assert.equal(
    report.checks.find((c: { name: string }) => c.name === 'Scheduled worker activity').status,
    'waiting',
  );
  assert.equal(report.ready, false);
  assert.equal(report.customers, undefined);
  assert.equal(report.token, undefined);
});
