import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { deleteApp } from 'firebase-admin/app';
import { auth, adminApp, db } from '../lib/server/firebase';
import { encryptConnection, type ConnectionRecord } from '../lib/whatsapp-connection';
import { clearServiceTokenCacheForTests } from '../lib/google-service-account';
import { handleTeam } from '../lib/team-api';
import { handleTemplateManager } from '../lib/template-manager-api';
import { handleConnectionHealth } from '../lib/connection-health-api';
import { handleAccountChat, chatHash } from '../lib/account-chat-api';
import { handleAccountBanners } from '../lib/account-banners-api';
import { handleWhatsAppWebhook } from '../lib/whatsapp-webhook';
import { newTemplateDraft } from '../lib/template-manager';
import type { ChatEnvironment } from '../lib/chat-types';

process.env.FIREBASE_PROJECT_ID ||= process.env.GCLOUD_PROJECT;
if (
  process.env.FIREBASE_PROJECT_ID !== 'demo-bpl' ||
  !process.env.FIREBASE_AUTH_EMULATOR_HOST ||
  !process.env.FIRESTORE_EMULATOR_HOST
)
  throw new Error('CRM tests require isolated demo-bpl emulators.');
const origin = 'https://lab.example.test',
  owner = 'crm-owner',
  staff = 'crm-staff',
  viewer = 'crm-viewer',
  outsider = 'crm-outsider';
const tokens: Record<string, string> = {};
let env: ChatEnvironment,
  customerId = '',
  templateId = 70000000;
let tokenValid = true,
  tokenExpiry = 0,
  outage = false,
  subscription = true,
  loseCreateResponse = false,
  rejectCreate = false;
let malformedCreate = false,
  malformedList = false,
  spareStaffInvite: unknown;
const calls = { debug: 0, create: 0, uploads: 0, messages: 0 };
const providerTemplates: any[] = [];
const connection: ConnectionRecord = {
  phone: '+916395951791',
  phoneNumberId: '12345678',
  businessAccountId: '87654321',
  appId: '55555555',
  accessToken: 'synthetic-crm-business-access-token',
  appSecret: 'synthetic-crm-app-secret',
  verifyToken: 'synthetic-crm-webhook-token',
  verifiedAt: new Date().toISOString(),
  verifiedName: 'Baunthiyal Path Lab',
};
const transport = (async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname === 'oauth2.googleapis.com')
    return Response.json({ access_token: 'owner', expires_in: 3600 });
  if (url.hostname !== 'graph.facebook.com') {
    assert.ok(
      ['localhost', '127.0.0.1'].includes(url.hostname),
      'No real external API calls in emulator tests',
    );
    return fetch(input, init);
  }
  if (outage) throw new Error(connection.accessToken + ' provider diagnostic must not escape');
  if (url.pathname.endsWith('/debug_token')) {
    calls.debug++;
    return Response.json({
      data: {
        is_valid: tokenValid,
        app_id: connection.appId,
        type: 'SYSTEM_USER',
        expires_at: tokenExpiry,
        data_access_expires_at: 0,
        scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
      },
    });
  }
  if (url.pathname.endsWith('/' + connection.phoneNumberId))
    return Response.json({ id: connection.phoneNumberId, display_phone_number: connection.phone });
  if (url.pathname.endsWith('/subscribed_apps'))
    return Response.json({
      data: subscription ? [{ whatsapp_business_api_data: { id: connection.appId } }] : [],
    });
  if (url.pathname.endsWith('/uploads')) {
    calls.uploads++;
    assert.ok(Number(url.searchParams.get('file_length')) > 20);
    return Response.json({ id: 'upload:synthetic_image_123?sig=synthetic' });
  }
  if (url.pathname.includes('/upload:')) {
    assert.equal(new Headers(init?.headers).get('file_offset'), '0');
    assert.equal(
      new Headers(init?.headers).get('authorization'),
      'OAuth ' + connection.accessToken,
    );
    return Response.json({ h: 'synthetic-genuine-provider-image-handle' });
  }
  if (url.pathname.endsWith('/message_templates')) {
    if (init?.method === 'POST') {
      calls.create++;
      const payload = JSON.parse(String(init.body));
      if (rejectCreate)
        return Response.json(
          { error: { code: 100, message: connection.accessToken } },
          { status: 400 },
        );
      const item = { id: String(++templateId), ...payload, status: 'PENDING' };
      providerTemplates.push(item);
      if (loseCreateResponse) throw new Error(connection.accessToken);
      if (malformedCreate) return new Response('incomplete provider response', { status: 200 });
      return Response.json({ id: item.id, status: item.status, category: item.category });
    }
    return Response.json(malformedList ? {} : { data: providerTemplates });
  }
  if (url.pathname.endsWith('/messages')) {
    calls.messages++;
    return Response.json({ messages: [{ id: 'wamid.synthetic.crm.' + calls.messages }] });
  }
  throw new Error('Unexpected synthetic Meta request');
}) as typeof fetch;
function req(path: string, uid = owner, data?: unknown) {
  return new Request(origin + '/api/' + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: {
      Origin: origin,
      Authorization: 'Bearer ' + tokens[uid],
      'Content-Type': 'application/json',
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
}
async function team(path = '', uid = owner, data?: unknown) {
  return handleTeam(req('account/team' + path, uid, data), env, transport);
}
async function resetHealth() {
  await db().doc(`bpl_customerWorkspaces/${owner}/integrationHealth/current`).delete();
  await db().doc(`bpl_customerWorkspaces/${owner}/integrationHealth/lease`).delete();
}
async function health() {
  return handleConnectionHealth(req('account/connection-health'), env, transport);
}
async function makeDraft(name: string, extra: Record<string, any> = {}) {
  const response = await handleTemplateManager(
    req('account/templates/drafts', owner, { draft: { ...newTemplateDraft(), name, ...extra } }),
    env,
    transport,
  );
  assert.equal(response.status, 201);
  return (await response.json()).draft;
}
async function submit(id: string) {
  return handleTemplateManager(
    req('account/templates/drafts/' + id + '/submit', owner, {}),
    env,
    transport,
  );
}
async function sync() {
  await db().doc(`bpl_customerWorkspaces/${owner}/templateSync/current`).delete();
  return handleTemplateManager(req('account/templates/sync', owner, {}), env, transport);
}
async function invite(uid: string, role: string) {
  const response = await team('/invites', owner, { email: uid + '@example.test', role });
  assert.equal(response.status, 201);
  const link = new URL((await response.json()).inviteUrl);
  return { owner: link.searchParams.get('owner'), token: link.searchParams.get('token') };
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
    encryptionKey: 'f'.repeat(64),
    appOrigin: origin,
    authOrigin: `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com`,
    firestoreOrigin: `http://${process.env.FIRESTORE_EMULATOR_HOST}`,
    webhookBaseUrl: origin,
    webhookPublicReady: true,
    serviceAccountJson: JSON.stringify({
      type: 'service_account',
      client_email: 'crm@demo-bpl.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\n' + key + '\n-----END PRIVATE KEY-----\n',
    }),
  };
  for (const uid of [owner, staff, viewer, outsider]) {
    await auth().createUser({
      uid,
      email: uid + '@example.test',
      displayName: uid,
      emailVerified: true,
      password: 'synthetic-emulator-password',
    });
    const response = await fetch(`${env.authOrigin}/v1/accounts:signInWithPassword?key=test-only`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: uid + '@example.test',
        password: 'synthetic-emulator-password',
        returnSecureToken: true,
      }),
    });
    tokens[uid] = (await response.json()).idToken;
    assert.ok(tokens[uid]);
  }
  await db()
    .doc(`bpl_whatsappConnections/${owner}`)
    .set({
      ownerId: owner,
      ...(await encryptConnection(connection, owner, env.encryptionKey)),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  const phone = '919876543210';
  customerId = (await chatHash(phone)).slice(0, 32);
  await db()
    .doc(`bpl_customerWorkspaces/${owner}/customers/${customerId}`)
    .set({
      id: customerId,
      ownerId: owner,
      name: 'Synthetic customer',
      phone,
      groups: [],
      createdAt: new Date().toISOString(),
      marketing: { status: 'not_asked', source: 'emulator', at: new Date().toISOString() },
    });
  const callback = new URL(origin + '/webhook/' + owner);
  callback.searchParams.set('hub.mode', 'subscribe');
  callback.searchParams.set('hub.challenge', 'synthetic');
  callback.searchParams.set('hub.verify_token', connection.verifyToken);
  assert.equal(
    (await handleWhatsAppWebhook(new Request(callback), owner, env, transport)).status,
    200,
  );
});
after(async () => {
  clearServiceTokenCacheForTests();
  await deleteApp(adminApp()!);
});

test('team invitations are email-bound, single-use and do not grant access before acceptance', async () => {
  const input = await invite(staff, 'staff');
  spareStaffInvite = await invite(staff, 'staff');
  assert.equal((await team('?workspace=' + owner, staff)).status, 403);
  assert.equal((await team('/accept', outsider, input)).status, 403);
  assert.equal((await team('/accept', staff, input)).status, 200);
  assert.equal((await team('/accept', staff, input)).status, 403);
  const context = await team('?workspace=' + owner, staff);
  assert.equal(context.status, 200);
  const body = await context.json();
  assert.equal(body.role, 'staff');
  assert.equal(body.canWrite, true);
  assert.ok(body.workspaces.some((w: any) => w.id === owner));
  assert.equal(
    body.members.some((m: any) => m.email),
    false,
  );
});
test('viewer roles can read but cannot invite, assign, add notes, manage quick replies or send', async () => {
  const staleStaffInvite = await invite(viewer, 'staff');
  const input = await invite(viewer, 'viewer');
  assert.equal((await team('/accept', viewer, input)).status, 200);
  assert.equal((await team('/accept', viewer, staleStaffInvite)).status, 403);
  const context = await team('?workspace=' + owner, viewer);
  assert.equal((await context.json()).canWrite, false);
  for (const [path, data] of [
    ['/invites', { email: 'bad@example.test', role: 'staff' }],
    ['/quick-replies', { title: 't', text: 't' }],
    [`/conversations/${customerId}/meta`, { assignedTo: null, labels: [], status: 'open' }],
    [`/conversations/${customerId}/notes`, { text: 'bad' }],
  ] as const)
    assert.equal((await team(path + '?workspace=' + owner, viewer, data)).status, 403);
  const response = await handleAccountChat(
    req(`account/inbox/${customerId}/send?workspace=${owner}`, viewer, {
      text: 'not allowed',
      requestId: crypto.randomUUID(),
    }),
    env,
    transport,
  );
  assert.equal(response.status, 403);
  assert.equal(calls.messages, 0);
});
test('staff assignment, labels, internal notes and quick replies use real isolated records', async () => {
  assert.equal(
    (await team('/quick-replies', owner, { title: 'Welcome', text: 'How can we help?' })).status,
    201,
  );
  const changed = await team(`/conversations/${customerId}/meta?workspace=${owner}`, staff, {
    assignedTo: staff,
    labels: ['Follow up', 'Follow up'],
    status: 'open',
  });
  assert.equal(changed.status, 200);
  const note = await team(`/conversations/${customerId}/notes?workspace=${owner}`, staff, {
    text: 'Internal note only',
  });
  assert.equal(note.status, 201);
  const n = await note.json();
  assert.equal(n.authorId, staff);
  assert.equal(
    (
      await team(`/conversations/${customerId}/notes?workspace=${owner}`, staff, {
        text: 'Spoofed',
        authorId: owner,
      })
    ).status,
    400,
  );
  const result = await team(`/conversations/${customerId}?workspace=${owner}`, viewer);
  const data = await result.json();
  assert.deepEqual(data.meta.labels, ['Follow up']);
  assert.equal(data.notes[0].text, 'Internal note only');
  assert.equal(calls.messages, 0);
  assert.equal((await team(`/conversations/${customerId}`, staff)).status, 404);
});
test('staff sends use the owner connection and retain the real customer reply-window guard', async () => {
  const before = calls.messages;
  assert.equal(
    (
      await handleAccountChat(
        req(`account/inbox/${customerId}/send?workspace=${owner}`, staff, {
          text: 'Reply',
          requestId: crypto.randomUUID(),
        }),
        env,
        transport,
      )
    ).status,
    409,
  );
  assert.equal(calls.messages, before);
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: connection.phoneNumberId },
              messages: [
                {
                  id: 'wamid.synthetic.crm.inbound',
                  from: '919876543210',
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: 'Need a booking' },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  const signature = createHmac('sha256', connection.appSecret).update(body).digest('hex');
  assert.equal(
    (
      await handleWhatsAppWebhook(
        new Request(origin + '/webhook/' + owner, {
          method: 'POST',
          headers: { 'x-hub-signature-256': 'sha256=' + signature },
          body,
        }),
        owner,
        env,
        transport,
      )
    ).status,
    200,
  );
  const response = await handleAccountChat(
    req(`account/inbox/${customerId}/send?workspace=${owner}`, staff, {
      text: 'Happy to help',
      requestId: crypto.randomUUID(),
    }),
    env,
    transport,
  );
  assert.equal(response.status, 201);
  assert.equal(calls.messages, before + 1);
});
test('removing a member immediately revokes both chat and note access', async () => {
  assert.equal((await team('/members/' + staff, owner, {})).status, 200);
  assert.equal((await team(`/conversations/${customerId}?workspace=${owner}`, staff)).status, 403);
  assert.equal(
    (await handleAccountChat(req('account/inbox?workspace=' + owner, staff), env, transport))
      .status,
    403,
  );
  const index = await db().doc(`bpl_customerWorkspaces/${staff}/teamAccess/${owner}`).get();
  assert.equal(index.exists, false);
  assert.equal((await team('/accept', staff, spareStaffInvite)).status, 403);
});
test('concurrent health checks share one provider check instead of multiplying Meta requests', async () => {
  await resetHealth();
  const before = calls.debug;
  const responses = await Promise.all([health(), health()]);
  assert.deepEqual(
    responses.map((r) => r.status),
    [200, 200],
  );
  assert.equal(calls.debug, before + 1);
});
test('healthy connection checks are cached and expiring access creates a persistent alert', async () => {
  await resetHealth();
  const response = await health();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).state, 'healthy');
  const debug = calls.debug;
  assert.equal((await health()).status, 200);
  assert.equal(calls.debug, debug);
  tokenExpiry = Math.floor(Date.now() / 1000) + 3600;
  await resetHealth();
  const expiring = await (await health()).json();
  assert.equal(expiring.state, 'action_required');
  assert.ok(expiring.alerts.some((a: any) => a.id === 'token-expiring'));
  assert.equal(
    (
      await handleConnectionHealth(
        req('account/connection-health/alerts/token-expiring/dismiss', owner, {}),
        env,
        transport,
      )
    ).status,
    200,
  );
  assert.ok(
    (await (await health()).json()).alerts.find((a: any) => a.id === 'token-expiring').dismissedAt,
  );
});
test('expired tokens and provider outages are distinguished and never erase unresolved errors', async () => {
  tokenValid = false;
  await resetHealth();
  const expired = await (await health()).json();
  assert.equal(expired.state, 'action_required');
  assert.ok(expired.alerts.some((a: any) => a.id === 'token-invalid'));
  outage = true;
  await resetHealth();
  const unknown = await (await health()).json();
  assert.equal(unknown.state, 'unknown');
  assert.ok(unknown.alerts.some((a: any) => a.id === 'token-invalid'));
  assert.equal(JSON.stringify(unknown).includes(connection.accessToken), false);
  outage = false;
  tokenValid = true;
  tokenExpiry = 0;
  await resetHealth();
  const recovered = await (await health()).json();
  assert.equal(recovered.state, 'healthy');
  assert.equal(recovered.alerts.length, 0);
});
test('template drafts persist without sending or faking approval and reject cross-owner edits and injected status', async () => {
  const draft = await makeDraft('bpl_draft_test');
  assert.equal(draft.state, 'DRAFT');
  assert.equal(calls.create, 0);
  const foreign = await handleTemplateManager(
    req('account/templates/drafts/' + draft.id, outsider, {
      draft: { ...newTemplateDraft(), name: 'bad_edit' },
      expectedRevision: 1,
    }),
    env,
    transport,
  );
  assert.equal(foreign.status, 404);
  const injection = await handleTemplateManager(
    req('account/templates/drafts', owner, {
      draft: { ...newTemplateDraft(), name: 'bad_status', providerStatus: 'APPROVED' },
    }),
    env,
    transport,
  );
  assert.equal(injection.status, 400);
  const read = await handleTemplateManager(req('account/templates'), env, transport);
  assert.equal(
    (await read.json()).drafts.some((d: any) => d.id === draft.id),
    true,
  );
});
test('concurrent submit clicks create one actual Meta request and approval comes only from provider refresh', async () => {
  const draft = await makeDraft('bpl_submit_once');
  const before = calls.create;
  const responses = await Promise.all([submit(draft.id), submit(draft.id)]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  assert.equal(calls.create, before + 1);
  providerTemplates.find((t) => t.name === 'bpl_submit_once').status = 'APPROVED';
  assert.equal((await sync()).status, 200);
  const read = await (await handleTemplateManager(req('account/templates'), env, transport)).json();
  assert.equal(read.templates.find((t: any) => t.name === 'bpl_submit_once').status, 'APPROVED');
  assert.equal(read.drafts.find((d: any) => d.id === draft.id).providerStatus, 'APPROVED');
});
test('a lost Meta create response stays unconfirmed and resolves by provider sync without automatic resubmission', async () => {
  const draft = await makeDraft('bpl_uncertain_submit');
  const before = calls.create;
  loseCreateResponse = true;
  const failed = await submit(draft.id);
  assert.equal(failed.status, 503);
  assert.equal((await failed.text()).includes(connection.accessToken), false);
  loseCreateResponse = false;
  assert.equal((await submit(draft.id)).status, 409);
  assert.equal(calls.create, before + 1);
  assert.equal((await sync()).status, 200);
  const record = (
    await db().doc(`bpl_customerWorkspaces/${owner}/templateDrafts/${draft.id}`).get()
  ).data();
  assert.equal(record?.state, 'SUBMITTED');
  assert.ok(record?.metaId);
});
test('malformed provider responses keep submissions unconfirmed and never fabricate template deletion', async () => {
  const draft = await makeDraft('bpl_incomplete_response');
  malformedCreate = true;
  assert.equal((await submit(draft.id)).status, 502);
  malformedCreate = false;
  assert.equal(
    (await db().doc(`bpl_customerWorkspaces/${owner}/templateDrafts/${draft.id}`).get()).data()
      ?.state,
    'SUBMISSION_UNKNOWN',
  );
  const before = (
    await db().collection(`bpl_customerWorkspaces/${owner}/templateRecords`).get()
  ).docs.map((d) => [d.id, d.data().status]);
  malformedList = true;
  assert.equal((await sync()).status, 502);
  malformedList = false;
  const after = (
    await db().collection(`bpl_customerWorkspaces/${owner}/templateRecords`).get()
  ).docs.map((d) => [d.id, d.data().status]);
  assert.deepEqual(after, before);
});
test('Meta template rejection and missing examples do not become approved or delivered messages', async () => {
  const draft = await makeDraft('bpl_bad_examples', { examples: [] });
  const before = calls.create;
  assert.equal((await submit(draft.id)).status, 400);
  assert.equal(calls.create, before);
  const rejected = await makeDraft('bpl_rejected');
  rejectCreate = true;
  const response = await submit(rejected.id);
  rejectCreate = false;
  assert.equal(response.status, 409);
  assert.equal((await response.text()).includes(connection.accessToken), false);
  assert.equal(
    (await db().doc(`bpl_customerWorkspaces/${owner}/templateDrafts/${rejected.id}`).get()).data()
      ?.state,
    'DRAFT',
  );
});
test('image templates upload real owned bytes to Meta and use the returned sample handle', async () => {
  const bytes = Uint8Array.from(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  const uploaded = await handleAccountBanners(
    new Request(origin + '/api/account/banners', {
      method: 'POST',
      headers: {
        Origin: origin,
        Authorization: 'Bearer ' + tokens[owner],
        'Content-Type': 'image/png',
      },
      body: bytes,
    }),
    { ...env, serviceAccountJson: env.serviceAccountJson! },
    transport,
  );
  assert.equal(uploaded.status, 201);
  const bannerPath = (await uploaded.json()).path;
  const draft = await makeDraft('bpl_image_submit', { headerType: 'IMAGE', bannerPath });
  assert.equal((await submit(draft.id)).status, 200);
  assert.equal(calls.uploads, 1);
  const payload = providerTemplates.find((t) => t.name === 'bpl_image_submit');
  assert.deepEqual(payload.components[0].example.header_handle, [
    'synthetic-genuine-provider-image-handle',
  ]);
  const foreign = await handleTemplateManager(
    req('account/templates/drafts', outsider, {
      draft: { ...newTemplateDraft(), name: 'bpl_stolen_image', headerType: 'IMAGE', bannerPath },
    }),
    env,
    transport,
  );
  assert.equal(foreign.status, 400);
});
test('new CRM collections reject direct client reads and forged writes even from the owner', async () => {
  for (const path of [
    `bpl_customerWorkspaces/${owner}/connectionAlerts/token-invalid`,
    `bpl_customerWorkspaces/${owner}/teamMembers/${viewer}`,
    `bpl_customerWorkspaces/${owner}/templateSync/current`,
  ]) {
    const response = await fetch(
      `${env.firestoreOrigin}/v1/projects/demo-bpl/databases/(default)/documents/${path}`,
      { headers: { Authorization: 'Bearer ' + tokens[owner] } },
    );
    assert.equal(response.status, 403);
  }
});
