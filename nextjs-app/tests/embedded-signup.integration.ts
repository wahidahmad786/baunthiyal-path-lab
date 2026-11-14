import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { deleteApp } from 'firebase-admin/app';
import { auth, adminApp, db } from '../lib/server/firebase';
import { handleEmbeddedSignup, type EmbeddedEnvironment } from '../lib/embedded-signup-api';
import { handleWhatsAppWebhook } from '../lib/whatsapp-webhook';
import { chatHash, handleAccountChat } from '../lib/account-chat-api';
import { decryptConnection } from '../lib/whatsapp-connection';
import { handleWhatsAppConnection } from '../lib/whatsapp-connection-api';
import { clearServiceTokenCacheForTests } from '../lib/google-service-account';

process.env.FIREBASE_PROJECT_ID ||= process.env.GCLOUD_PROJECT;
if (
  process.env.FIREBASE_PROJECT_ID !== 'demo-bpl' ||
  !process.env.FIREBASE_AUTH_EMULATOR_HOST ||
  !process.env.FIRESTORE_EMULATOR_HOST
)
  throw new Error('Embedded signup tests require isolated demo-bpl emulators.');
const origin = 'https://lab.example.test';
const users = ['signup-owner-a', 'signup-owner-b', 'signup-owner-c'];
const tokens: Record<string, string> = {};
let env: EmbeddedEnvironment;
let selected = {
  waba: '11111111',
  phoneId: '22222222',
  phone: '919876543210',
  coex: false,
  registered: true,
  appId: '55555555',
  type: 'SYSTEM_USER',
  scopeValid: true,
  subscriptionFails: false,
};
const calls: string[] = [];
const send = (async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname === 'oauth2.googleapis.com')
    return Response.json({ access_token: 'owner', expires_in: 3600 });
  if (url.hostname !== 'graph.facebook.com') return fetch(input, init);
  calls.push(url.pathname);
  if (url.pathname.endsWith('/oauth/access_token'))
    return Response.json({ access_token: 'emulator-business-token-for-' + selected.waba });
  if (url.pathname.endsWith('/debug_token'))
    return Response.json({
      data: {
        is_valid: true,
        app_id: selected.appId,
        type: selected.type,
        expires_at: 0,
        scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
        granular_scopes: [
          {
            scope: 'whatsapp_business_management',
            target_ids: [selected.scopeValid ? selected.waba : '99999999'],
          },
        ],
      },
    });
  if (url.pathname.endsWith('/phone_numbers'))
    return Response.json({
      data: [
        {
          id: selected.phoneId,
          display_phone_number: '+' + selected.phone,
          verified_name: 'Test lab',
          is_on_biz_app: selected.coex,
          platform_type: selected.registered ? 'CLOUD_API' : 'NOT_REGISTERED',
        },
      ],
    });
  if (url.pathname.endsWith('/app')) return Response.json({ id: selected.appId });
  if (url.pathname.endsWith('/register')) {
    assert.equal(selected.coex, false);
    return Response.json({ success: true });
  }
  if (url.pathname.endsWith('/smb_app_data'))
    return Response.json({ request_id: 'synthetic-sync-request' });
  if (url.pathname.endsWith('/subscribed_apps')) {
    if (selected.subscriptionFails)
      return Response.json(
        { error: { code: 200, message: 'emulator-sensitive-provider-message' } },
        { status: 400 },
      );
    const data = JSON.parse(String(init?.body));
    const callback = new URL(data.override_callback_uri);
    callback.searchParams.set('hub.mode', 'subscribe');
    callback.searchParams.set('hub.verify_token', data.verify_token);
    callback.searchParams.set('hub.challenge', 'synthetic-meta-challenge');
    const challenged = await handleWhatsAppWebhook(
      new Request(callback),
      callback.pathname.split('/').pop()!,
      env,
      send,
    );
    assert.equal(challenged.status, 200);
    assert.equal(await challenged.text(), 'synthetic-meta-challenge');
    return Response.json({ success: true });
  }
  throw new Error('Unexpected Meta request in isolated test');
}) as typeof fetch;
function request(action = '', uid = users[0], body?: unknown, cookie = '', requestOrigin = origin) {
  return new Request(origin + '/api/whatsapp/embedded-signup' + action, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: 'Bearer ' + (tokens[uid] || ''),
      Origin: requestOrigin,
      Cookie: cookie,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function start(uid = users[0]) {
  await db().doc(`bpl_customerWorkspaces/${uid}/integrationSessions/embedded-signup`).delete();
  const response = await handleEmbeddedSignup(request('/start', uid, {}), env, send);
  assert.equal(response.status, 200);
  const result = await response.json();
  return { sessionId: result.sessionId, cookie: response.headers.get('set-cookie')!.split(';')[0] };
}
async function complete(uid = users[0], session?: Awaited<ReturnType<typeof start>>) {
  const prepared = session || (await start(uid));
  return handleEmbeddedSignup(
    request(
      '/complete',
      uid,
      {
        sessionId: prepared.sessionId,
        code: 'synthetic-one-time-code',
        wabaId: selected.waba,
        phoneNumberId: selected.phoneId,
        event: selected.coex ? 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' : 'FINISH',
      },
      prepared.cookie,
    ),
    env,
    send,
  );
}
async function readConnection(uid = users[0]) {
  const document = await db().doc(`bpl_whatsappConnections/${uid}`).get();
  return decryptConnection(document.data() as any, uid, env.encryptionKey);
}
async function callback(uid: string, field: string, value: any, badSignature = false) {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: selected.waba,
        changes: [{ field, value: { metadata: { phone_number_id: selected.phoneId }, ...value } }],
      },
    ],
  });
  const signature = createHmac('sha256', badSignature ? 'wrong-secret' : env.metaAppSecret!)
    .update(body)
    .digest('hex');
  return handleWhatsAppWebhook(
    new Request(origin + '/webhook/' + uid, {
      method: 'POST',
      body,
      headers: { 'x-hub-signature-256': 'sha256=' + signature },
    }),
    uid,
    env,
    send,
  );
}
before(async () => {
  clearServiceTokenCacheForTests();
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const key = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString(
    'base64',
  );
  env = {
    projectId: 'demo-bpl',
    apiKey: 'test-only',
    encryptionKey: 'e'.repeat(64),
    appOrigin: origin,
    authOrigin: `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com`,
    firestoreOrigin: `http://${process.env.FIRESTORE_EMULATOR_HOST}`,
    serviceAccountJson: JSON.stringify({
      type: 'service_account',
      client_email: 'signup@demo-bpl.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\n' + key + '\n-----END PRIVATE KEY-----\n',
    }),
    metaAppId: '55555555',
    metaAppSecret: 'emulator-only-app-secret',
    metaConfigId: '66666666',
    embeddedEnabled: true,
    coexistenceEnabled: true,
    webhookBaseUrl: origin,
    webhookPublicReady: true,
  };
  for (const uid of users) {
    await auth().createUser({
      uid,
      email: uid + '@example.test',
      emailVerified: true,
      password: 'emulator-only-password',
    });
    const response = await fetch(`${env.authOrigin}/v1/accounts:signInWithPassword?key=test-only`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: uid + '@example.test',
        password: 'emulator-only-password',
        returnSecureToken: true,
      }),
    });
    tokens[uid] = (await response.json()).idToken;
    assert.ok(tokens[uid]);
  }
});
after(async () => {
  clearServiceTokenCacheForTests();
  await deleteApp(adminApp()!);
});
test('signup requires a verified portal session and rejects foreign origins', async () => {
  assert.equal((await handleEmbeddedSignup(request('', 'missing'), env, send)).status, 401);
  assert.equal(
    (
      await handleEmbeddedSignup(
        request('/start', users[0], {}, '', 'https://evil.test'),
        env,
        send,
      )
    ).status,
    403,
  );
  const status = await handleEmbeddedSignup(request(), env, send);
  assert.equal(status.status, 200);
  assert.equal((await status.text()).includes(env.metaAppSecret!), false);
  const disabled = await handleEmbeddedSignup(
    request('/start', users[0], {}),
    { ...env, metaConfigId: '' },
    send,
  );
  assert.equal(disabled.status, 503);
});
test('real emulator records store scoped encrypted business authorization after Meta callback validation', async () => {
  const response = await complete();
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.equal(body.includes('emulator-business-token'), false);
  assert.equal(body.includes(env.metaAppSecret!), false);
  const record = await readConnection();
  assert.equal(record.phoneNumberId, selected.phoneId);
  assert.equal(record.connectionMethod, 'embedded_signup');
  assert.equal(record.tokenExpiresAt, null);
  assert.ok(
    (await db().doc(`bpl_customerWorkspaces/${users[0]}/inboxStatus/webhook`).get()).data()
      ?.challengeAnsweredAt,
  );
  assert.equal(
    calls.some((x) => x.endsWith('/messages')),
    false,
  );
});
test('OAuth sessions are single-use and bound to both browser cookie and Google owner', async () => {
  const session = await start();
  const stolen = await complete(users[1], session);
  assert.equal(stolen.status, 409);
  assert.equal((await complete(users[0], { ...session, cookie: '' })).status, 409);
  assert.equal((await complete(users[0], session)).status, 200);
  const before = calls.length;
  assert.equal((await complete(users[0], session)).status, 409);
  assert.equal(calls.length, before);
});
test('credentials cannot be attached to an account outside the token grant', async () => {
  selected.scopeValid = false;
  assert.equal((await complete()).status, 403);
  selected.scopeValid = true;
  assert.equal((await readConnection()).phoneNumberId, selected.phoneId);
});
test('a different Google login cannot take over an existing WhatsApp account', async () => {
  const before = calls.filter((x) => x.endsWith('/subscribed_apps')).length;
  assert.equal((await complete(users[1])).status, 409);
  assert.equal(calls.filter((x) => x.endsWith('/subscribed_apps')).length, before);
});
test('advanced manual verification cannot bypass ownership protection', async () => {
  const response = await handleWhatsAppConnection(
    new Request(origin + '/api/whatsapp/integration', {
      method: 'POST',
      headers: {
        Origin: origin,
        Authorization: 'Bearer ' + tokens[users[2]],
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        phone: '+' + selected.phone,
        phoneNumberId: selected.phoneId,
        businessAccountId: selected.waba,
        appId: env.metaAppId,
        appSecret: env.metaAppSecret,
        accessToken: 'synthetic-manual-whatsapp-token',
        verifyToken: '',
        verify: true,
      }),
    }),
    env,
    send,
  );
  assert.equal(response.status, 409);
  assert.equal((await db().doc(`bpl_whatsappConnections/${users[2]}`).get()).exists, false);
});
test('Meta callback rejection leaves existing saved credentials unchanged and hides provider messages', async () => {
  const prior = await readConnection();
  selected.subscriptionFails = true;
  const response = await complete();
  assert.equal(response.status, 409);
  assert.equal((await response.text()).includes('emulator-sensitive'), false);
  selected.subscriptionFails = false;
  assert.equal((await readConnection()).accessToken, prior.accessToken);
});
test('wrong app tokens and temporary user tokens are refused', async () => {
  selected.appId = '99999999';
  assert.equal((await complete()).status, 409);
  selected.appId = env.metaAppId!;
  selected.type = 'USER';
  assert.equal((await complete()).status, 409);
  selected.type = 'SYSTEM_USER';
});
test('separate Google owners can connect separate numbers; Coexistence skips deregistration and registration', async () => {
  selected = {
    ...selected,
    waba: '77777777',
    phoneId: '88888888',
    phone: '919876543211',
    coex: true,
    registered: false,
  };
  const priorRegisters = calls.filter((x) => x.endsWith('/register')).length;
  assert.equal((await complete(users[1])).status, 200);
  assert.equal(calls.filter((x) => x.endsWith('/register')).length, priorRegisters);
  assert.equal(calls.filter((x) => x.endsWith('/smb_app_data')).length, 2);
  assert.equal((await readConnection(users[1])).coexistence, true);
  assert.notEqual(
    (await readConnection(users[0])).phoneNumberId,
    (await readConnection(users[1])).phoneNumberId,
  );
});
test('reconnecting a Business app number does not repeat its one-time synchronization', async () => {
  assert.equal((await complete(users[1])).status, 200);
  assert.equal(calls.filter((x) => x.endsWith('/smb_app_data')).length, 2);
  assert.equal(
    (await handleEmbeddedSignup(request('/start', users[1], {}), env, send)).status,
    200,
  );
});
test('signed Business app contacts, histories and echoes stay private and never invent marketing consent or a reply window', async () => {
  const uid = users[1],
    phone = '919876540000',
    timestamp = String(Math.floor(Date.now() / 1000));
  assert.equal(
    (
      await callback(uid, 'smb_app_state_sync', {
        state_sync: [
          {
            type: 'contact',
            action: 'add',
            contact: { phone_number: phone, full_name: 'Imported contact' },
          },
        ],
      })
    ).status,
    200,
  );
  const id = (await chatHash(phone)).slice(0, 32);
  assert.equal(
    (await db().doc(`bpl_customerWorkspaces/${uid}/customers/${id}`).get()).exists,
    false,
  );
  const history = {
    history: [
      {
        threads: [
          {
            id: phone,
            messages: [
              {
                id: 'wamid.fixture.history',
                from: phone,
                timestamp,
                type: 'text',
                text: { body: 'Old app message' },
              },
            ],
          },
        ],
      },
    ],
  };
  assert.equal((await callback(uid, 'history', history)).status, 200);
  assert.equal(
    (
      await callback(uid, 'smb_message_echoes', {
        message_echoes: [
          {
            id: 'wamid.fixture.echo',
            from: selected.phone,
            to: phone,
            timestamp,
            type: 'text',
            text: { body: 'Sent from Business app' },
          },
        ],
      })
    ).status,
    200,
  );
  const response = await handleAccountChat(
    new Request(origin + '/api/account/inbox/' + id, {
      headers: { Authorization: 'Bearer ' + tokens[uid] },
    }),
    env,
    send,
  );
  const detail = await response.json();
  assert.equal(detail.windowOpen, false);
  assert.equal(detail.messages.length, 2);
  assert.ok(detail.messages.some((m: any) => m.text === 'Sent from Business app'));
  assert.equal((await callback(uid, 'history', history, true)).status, 403);
  const access = await fetch(
    `${env.firestoreOrigin}/v1/projects/demo-bpl/databases/(default)/documents/bpl_customerWorkspaces/${uid}/integrationSessions/embedded-signup`,
    { headers: { Authorization: 'Bearer ' + tokens[uid] } },
  );
  assert.equal(access.status, 403);
});
test('Meta offboarding blocks API sends with an explicit reconnect reason', async () => {
  const uid = users[1];
  assert.equal(
    (
      await callback(uid, 'account_update', {
        event: 'PARTNER_REMOVED',
        waba_info: { waba_id: selected.waba },
      })
    ).status,
    200,
  );
  const result = await handleAccountChat(
    new Request(origin + '/api/account/inbox/setup', {
      method: 'POST',
      headers: { Origin: origin, Authorization: 'Bearer ' + tokens[uid] },
    }),
    env,
    send,
  );
  const state = await result.json();
  assert.equal(state.configured, false);
  assert.match(state.reason, /reconnect/i);
});
test('new Cloud API registration saves an encrypted PIN and the health check does not send messages', async () => {
  selected = {
    ...selected,
    waba: '33333333',
    phoneId: '44444444',
    phone: '919876543212',
    coex: false,
    registered: false,
  };
  const registeredBefore = calls.filter((x) => x.endsWith('/register')).length;
  const response = await complete(users[2]);
  assert.equal(response.status, 200);
  const result = await response.text();
  assert.equal(result.includes('registrationPin'), false);
  const record = await readConnection(users[2]);
  assert.match(record.registrationPin!, /^\d{6}$/);
  assert.equal(calls.filter((x) => x.endsWith('/register')).length, registeredBefore + 1);
  const checked = await handleEmbeddedSignup(request('/check', users[2], {}), env, send);
  assert.equal(checked.status, 200);
  assert.equal((await checked.json()).tokenExpiresAt, null);
  assert.equal(
    calls.some((x) => x.endsWith('/messages') || x.endsWith('/deregister')),
    false,
  );
});
