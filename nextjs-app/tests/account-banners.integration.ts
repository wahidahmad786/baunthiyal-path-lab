import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { deleteApp } from 'firebase-admin/app';
import { auth, adminApp, db } from '../lib/server/firebase';
import { handleAccountBanners, type BannerEnvironment } from '../lib/account-banners-api';
import { clearServiceTokenCacheForTests } from '../lib/google-service-account';
import { sendTemplate, uploadTemplateImage, validateTemplate } from '../lib/server/whatsapp';
process.env.FIREBASE_PROJECT_ID ||= process.env.GCLOUD_PROJECT;
if (
  process.env.FIREBASE_PROJECT_ID !== 'demo-bpl' ||
  !process.env.FIREBASE_AUTH_EMULATOR_HOST ||
  !process.env.FIRESTORE_EMULATOR_HOST
)
  throw new Error('Banner tests require isolated demo-bpl emulators.');
const origin = 'https://lab.test';
const tokens: Record<string, string> = {};
const png = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  ),
);
let env: BannerEnvironment;
const transport = (async (url, init) =>
  new URL(String(url)).hostname === 'oauth2.googleapis.com'
    ? Response.json({ access_token: 'owner', expires_in: 3600 })
    : fetch(url, init)) as typeof fetch;
before(async () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  clearServiceTokenCacheForTests();
  env = {
    projectId: 'demo-bpl',
    apiKey: 'emulator',
    serviceAccountJson: JSON.stringify({
      type: 'service_account',
      client_email: 'banners@demo-bpl.iam.gserviceaccount.com',
      private_key: privateKey,
    }),
    authOrigin: `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com`,
    firestoreOrigin: `http://${process.env.FIRESTORE_EMULATOR_HOST}`,
  };
  for (const uid of ['banner-owner', 'banner-other', 'banner-unverified']) {
    await auth().createUser({
      uid,
      email: uid + '@example.test',
      password: 'banner-emulator-password',
      emailVerified: uid !== 'banner-unverified',
    });
    const signed = await fetch(`${env.authOrigin}/v1/accounts:signInWithPassword?key=emulator`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: uid + '@example.test',
        password: 'banner-emulator-password',
        returnSecureToken: true,
      }),
    });
    tokens[uid] = (await signed.json()).idToken;
    assert.ok(tokens[uid]);
  }
});
after(async () => {
  await deleteApp(adminApp());
});
function request(uid: string, path = '', content?: Uint8Array, type = 'image/png') {
  return new Request(origin + '/api/account/banners' + path, {
    method: content ? 'POST' : 'GET',
    headers: {
      Authorization: 'Bearer ' + tokens[uid],
      origin,
      'Content-Type': type,
      'X-Banner-Name': 'health-offer.png',
    },
    ...(content ? { body: new Uint8Array(content) } : {}),
  });
}
test('banner is persisted, recoverable after reload, deduplicated and isolated from another account', async () => {
  const saved = await handleAccountBanners(request('banner-owner', '', png), env, transport);
  assert.equal(saved.status, 201);
  const value = await saved.json();
  assert.match(value.path, /^account-banners\/banner-owner\/[a-f0-9]{32}$/);
  const document = await db()
    .doc('bpl_customerWorkspaces/banner-owner/banners/' + value.id)
    .get();
  assert.ok(document.exists);
  assert.equal(document.data()!.ownerId, 'banner-owner');
  const loaded = await handleAccountBanners(
    request('banner-owner', '/' + value.id),
    env,
    transport,
  );
  assert.equal(loaded.status, 200);
  assert.equal(loaded.headers.get('content-type'), 'image/png');
  assert.deepEqual(new Uint8Array(await loaded.arrayBuffer()), png);
  const duplicate = await handleAccountBanners(request('banner-owner', '', png), env, transport);
  assert.equal(duplicate.status, 200);
  const foreign = await handleAccountBanners(
    request('banner-other', '/' + value.id),
    env,
    transport,
  );
  assert.equal(foreign.status, 404);
  assert.equal(
    (await db().collection('bpl_customerWorkspaces/banner-owner/banners').get()).size,
    1,
  );
});
test('unverified accounts, non-images and over-limit data cannot create banners', async () => {
  assert.equal(
    (await handleAccountBanners(request('banner-unverified', '', png), env, transport)).status,
    403,
  );
  assert.equal(
    (
      await handleAccountBanners(
        request('banner-other', '', new TextEncoder().encode('<svg/>'), 'image/svg+xml'),
        env,
        transport,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await handleAccountBanners(
        request('banner-other', '', new Uint8Array(601 * 1024)),
        env,
        transport,
      )
    ).status,
    413,
  );
  assert.equal(
    (await db().collection('bpl_customerWorkspaces/banner-other/banners').get()).size,
    0,
  );
});
test('saved banner delivery uploads real multipart media and uses its Meta ID; approved footer wording remains valid', async () => {
  const oldFetch = globalThis.fetch;
  const keys = [
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_BUSINESS_ACCOUNT_ID',
    'WHATSAPP_APP_SECRET',
    'WHATSAPP_VERIFY_TOKEN',
  ];
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  keys.forEach((k) => (process.env[k] = 'emulator-only-value'));
  process.env.WHATSAPP_PHONE_NUMBER_ID = '123456789';
  let uploads = 0,
    messages = 0;
  globalThis.fetch = (async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/media')) {
      uploads++;
      assert.ok(init!.body instanceof FormData);
      assert.equal(new Headers(init!.headers).has('Content-Type'), false);
      const file = (init!.body as FormData).get('file') as File;
      assert.equal(file.type, 'image/png');
      assert.deepEqual(new Uint8Array(await file.arrayBuffer()), png);
      return Response.json({ id: '987654321' });
    }
    assert.ok(path.endsWith('/messages'));
    messages++;
    const payload = JSON.parse(String(init!.body));
    assert.deepEqual(payload.template.components[0].parameters[0].image, { id: '987654321' });
    return Response.json({ messages: [{ id: 'wamid.emulator-only' }] });
  }) as typeof fetch;
  try {
    const media = await uploadTemplateImage(png, 'image/png');
    const template = {
      id: '12345',
      name: 'approved_banner',
      language: 'en',
      status: 'APPROVED',
      category: 'MARKETING',
      header: 'IMAGE',
      body: 'Hello {{1}}, book {{2}}.',
      footer: 'Baunthiyal Path Lab. Your Health, Our Priority. Reply STOP to opt out.',
    };
    validateTemplate(
      template,
      { '1': 'customer_name', '2': 'booking_link' },
      'account-banners/banner-owner/' + 'a'.repeat(32),
    );
    assert.equal(
      await sendTemplate(
        '919876543210',
        template,
        { '1': 'Customer', '2': 'https://lab.test/book/example' },
        media,
      ),
      'wamid.emulator-only',
    );
    assert.equal(uploads, 1);
    assert.equal(messages, 1);
  } finally {
    globalThis.fetch = oldFetch;
    for (const k of keys) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
  }
});
