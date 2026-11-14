import {
  ChatError,
  ChatStore,
  chatHash,
  chatJson,
  firestoreFields,
  readChatBody,
  readChatConnection,
  verifyUser,
} from './account-chat-api';
import type { ChatEnvironment } from './chat-types';
import { embeddedCompletionSchema, type EmbeddedStatus } from './embedded-signup';
import { allowedRequestOrigin } from './request-origin';
import { claimWhatsAppAccount } from './whatsapp-account-owner';
import {
  connectionSummary,
  decryptConnection,
  encryptConnection,
  verifyMetaConnection,
  type ConnectionRecord,
  type EncryptedConnection,
} from './whatsapp-connection';

export type EmbeddedEnvironment = ChatEnvironment & {
  metaAppId?: string;
  metaAppSecret?: string;
  metaConfigId?: string;
  embeddedEnabled?: boolean;
  coexistenceEnabled?: boolean;
};
const sessionPath = 'integrationSessions/embedded-signup';
const cookieName = '__Secure-bpl-wa-connect';
const idPattern = /^[1-9]\d{4,29}$/;
const random = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
const at = () => new Date().toISOString();
const expiry = (seconds: unknown) =>
  Number(seconds) > 0 && Number.isFinite(Number(seconds))
    ? new Date(Number(seconds) * 1000).toISOString()
    : null;
export function embeddedStatus(env: EmbeddedEnvironment): EmbeddedStatus {
  let callbackValid = false;
  try {
    const url = new URL(env.webhookBaseUrl || '');
    callbackValid = url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    /* Not configured. */
  }
  const ready = !!(
    env.embeddedEnabled &&
    idPattern.test(env.metaAppId || '') &&
    idPattern.test(env.metaConfigId || '') &&
    (env.metaAppSecret?.length || 0) >= 16 &&
    /^[a-f0-9]{64}$/i.test(env.encryptionKey) &&
    env.serviceAccountJson &&
    env.webhookPublicReady &&
    callbackValid
  );
  return {
    ready,
    appId: ready ? env.metaAppId! : null,
    configId: ready ? env.metaConfigId! : null,
    graphVersion: /^v\d+\.\d+$/.test(env.graphVersion || '') ? env.graphVersion! : 'v23.0',
    coexistence: ready && env.coexistenceEnabled === true,
    reason: ready
      ? null
      : 'Quick connect is awaiting the portal owner’s Meta setup. Each user will connect their own WhatsApp account after this is enabled. Your existing connection remains available below.',
  };
}
function cookie(request: Request) {
  return (
    (request.headers.get('cookie') || '')
      .split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith(cookieName + '='))
      ?.slice(cookieName.length + 1) || ''
  );
}
async function proof(secret: string, token: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return Array.from(
    new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(token))),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
async function graph(
  env: EmbeddedEnvironment,
  path: string,
  token: string,
  send: typeof fetch,
  data?: Record<string, unknown>,
  query?: Record<string, string>,
) {
  const url = new URL(`https://graph.facebook.com/${embeddedStatus(env).graphVersion}/${path}`);
  for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value);
  const response = await send(url, {
    method: data ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(data ? { body: JSON.stringify(data) } : {}),
    signal: AbortSignal.timeout(18000),
  });
  const result = await response.json();
  if (!response.ok || result.error) {
    const code = Number(result.error?.code);
    throw new ChatError(
      409,
      [190, 102, 104].includes(code)
        ? 'Meta access has expired or was revoked. Choose Reconnect WhatsApp and approve access again.'
        : [10, 200].includes(code)
          ? 'Meta has not granted the required WhatsApp permissions. The portal owner must complete Meta App Review and access verification.'
          : 'Meta could not complete this connection step. Check your business access and try Connect WhatsApp again.',
      [190, 102, 104].includes(code) ? 'META_RECONNECT_REQUIRED' : 'META_ONBOARDING_FAILED',
    );
  }
  return result;
}
async function tokenInformation(
  env: EmbeddedEnvironment,
  appId: string,
  appSecret: string,
  token: string,
  send: typeof fetch,
) {
  const result = await graph(env, 'debug_token', `${appId}|${appSecret}`, send, undefined, {
    input_token: token,
  });
  const d = result.data;
  if (
    !d?.is_valid ||
    String(d.app_id) !== appId ||
    (Number(d.expires_at) > 0 && Number(d.expires_at) * 1000 <= Date.now()) ||
    (Number(d.data_access_expires_at) > 0 && Number(d.data_access_expires_at) * 1000 <= Date.now())
  )
    throw new ChatError(
      409,
      'Meta authorization is no longer valid. Reconnect your WhatsApp account.',
      'META_RECONNECT_REQUIRED',
    );
  return d;
}
// Called only for Meta's verification challenge. The candidate cannot replace a working
// connection until Meta has verified the new callback and all onboarding steps succeed.
export async function pendingEmbeddedChallenge(
  store: ChatStore,
  verifyToken: string,
): Promise<ConnectionRecord | null> {
  const pending = await store.read(sessionPath);
  if (
    !pending?.data.candidate ||
    pending.data.phase !== 'finalizing' ||
    Date.parse(pending.data.expiresAt) <= Date.now()
  )
    return null;
  const candidate = await decryptConnection(
    pending.data.candidate as EncryptedConnection,
    store.uid,
    store.env.encryptionKey,
  );
  if (!verifyToken || (await chatHash(verifyToken)) !== (await chatHash(candidate.verifyToken)))
    return null;
  await store.commit([
    store.write(sessionPath, { ...pending.data, challengeAnsweredAt: at() }, pending),
  ]);
  return candidate;
}
export async function handleEmbeddedSignup(
  request: Request,
  env: EmbeddedEnvironment,
  send: typeof fetch = fetch,
) {
  try {
    const action = new URL(request.url).pathname.split('/').pop();
    if (
      !['GET', 'POST'].includes(request.method) ||
      (request.method === 'GET' && action !== 'embedded-signup')
    )
      return chatJson({ error: 'Method not allowed' }, 405);
    if (request.method === 'POST' && !allowedRequestOrigin(request, env.appOrigin))
      throw new ChatError(403, 'Request origin is not allowed');
    const identity = await verifyUser(request, env, send);
    const status = embeddedStatus(env);
    if (request.method === 'GET') return chatJson(status);
    if (action !== 'check' && !status.ready)
      throw new ChatError(503, status.reason!, 'EMBEDDED_SIGNUP_NOT_READY');
    const store = await ChatStore.open(env, identity.uid, send, identity.token, true);
    if (action === 'check') {
      const record = await readChatConnection(store);
      if (!record) throw new ChatError(409, 'Connect WhatsApp first.');
      const info = await tokenInformation(
        env,
        record.appId,
        record.appSecret,
        record.accessToken,
        send,
      );
      await verifyMetaConnection(record, status.graphVersion, send);
      const expiresAt = expiry(info.expires_at),
        dataAccessExpiresAt = expiry(info.data_access_expires_at);
      return chatJson({
        valid: true,
        checkedAt: at(),
        tokenExpiresAt: expiresAt,
        dataAccessExpiresAt,
        message: expiresAt
          ? 'Meta access is valid. Reconnect before its expiry to keep API access available.'
          : 'Meta access is valid with no scheduled token expiry. Meta permissions and account eligibility still apply.',
      });
    }
    const previousSession = await store.read(sessionPath);
    if (action === 'start') {
      if (
        previousSession &&
        previousSession.data.phase !== 'complete' &&
        Date.parse(previousSession.data.updatedAt || '') > Date.now() - 5000
      )
        throw new ChatError(429, 'Please wait a few seconds before trying again.');
      const nonce = random();
      await store.commit([
        store.write(
          sessionPath,
          {
            ownerId: identity.uid,
            stateHash: await chatHash(nonce),
            phase: 'pending',
            expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
            updatedAt: at(),
          },
          previousSession,
        ),
      ]);
      const response = chatJson({ ...status, sessionId: nonce });
      response.headers.set(
        'Set-Cookie',
        `${cookieName}=${nonce}; HttpOnly; Secure; SameSite=Strict; Path=/api/whatsapp/embedded-signup; Max-Age=600`,
      );
      return response;
    }
    if (action !== 'complete') return chatJson({ error: 'Not found' }, 404);
    const body = JSON.parse(new TextDecoder().decode(await readChatBody(request, 16000)));
    const parsed = embeddedCompletionSchema.safeParse(body);
    if (!parsed.success)
      throw new ChatError(
        400,
        'Meta did not return a complete WhatsApp selection. Connect again and finish every step.',
      );
    const input = parsed.data;
    if (
      cookie(request) !== input.sessionId ||
      !previousSession ||
      previousSession.data.stateHash !== (await chatHash(input.sessionId)) ||
      previousSession.data.phase !== 'pending' ||
      Date.parse(previousSession.data.expiresAt) <= Date.now()
    )
      throw new ChatError(
        409,
        'This connection session expired or was already used. Choose Connect WhatsApp again.',
        'SIGNUP_SESSION_EXPIRED',
      );
    if (input.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' && !status.coexistence)
      throw new ChatError(
        409,
        'WhatsApp Business app onboarding is not enabled for this portal yet. Your mobile app has not been changed.',
      );
    await store.commit([
      store.write(
        sessionPath,
        { ...previousSession.data, phase: 'exchanging', updatedAt: at() },
        previousSession,
      ),
    ]);
    // The one-use code expires after 30 seconds. Exchange it immediately; never log it.
    const exchanged = await graph(
      env,
      'oauth/access_token',
      `${env.metaAppId}|${env.metaAppSecret}`,
      send,
      undefined,
      { client_id: env.metaAppId!, client_secret: env.metaAppSecret!, code: input.code },
    );
    if (typeof exchanged.access_token !== 'string' || exchanged.access_token.length < 20)
      throw new ChatError(409, 'Meta did not return a business access token. Connect again.');
    const accessToken = exchanged.access_token as string;
    const info = await tokenInformation(env, env.metaAppId!, env.metaAppSecret!, accessToken, send);
    if (
      !['SYSTEM_USER', 'BUSINESS_INTEGRATION_SYSTEM_USER'].includes(info.type) ||
      !['whatsapp_business_management', 'whatsapp_business_messaging'].every((scope) =>
        info.scopes?.includes(scope),
      )
    )
      throw new ChatError(
        409,
        'The portal’s Meta login configuration must issue a business system user token with WhatsApp management and messaging access.',
      );
    const grants = (info.granular_scopes || []).filter((g: any) =>
      ['whatsapp_business_management', 'whatsapp_business_messaging'].includes(g.scope),
    );
    if (
      grants.some(
        (g: any) => Array.isArray(g.target_ids) && !g.target_ids.map(String).includes(input.wabaId),
      )
    )
      throw new ChatError(403, 'The selected WhatsApp account was not granted to this connection.');
    const appProof = await proof(env.metaAppSecret!, accessToken);
    const phoneList = await graph(
      env,
      `${input.wabaId}/phone_numbers`,
      accessToken,
      send,
      undefined,
      {
        fields: 'id,display_phone_number,verified_name,is_on_biz_app,platform_type',
        limit: '100',
        appsecret_proof: appProof,
      },
    );
    const phones = Array.isArray(phoneList.data) ? phoneList.data : [];
    const phone = input.phoneNumberId
      ? phones.find((p: any) => p.id === input.phoneNumberId)
      : phones.length === 1
        ? phones[0]
        : null;
    if (!phone)
      throw new ChatError(
        409,
        'Select one WhatsApp phone number in Meta and finish the connection.',
      );
    const coexistence = phone.is_on_biz_app === true;
    if (coexistence && !status.coexistence)
      throw new ChatError(
        409,
        'Business app onboarding is awaiting the portal owner’s Coexistence setup.',
      );
    const record: ConnectionRecord = {
      appId: env.metaAppId!,
      appSecret: env.metaAppSecret!,
      accessToken,
      phone: '+' + String(phone.display_phone_number).replace(/\D/g, ''),
      phoneNumberId: phone.id,
      businessAccountId: input.wabaId,
      verifyToken: random(),
      verifiedAt: at(),
      verifiedName: String(phone.verified_name || ''),
      connectionMethod: 'embedded_signup',
      tokenExpiresAt: expiry(info.expires_at),
      dataAccessExpiresAt: expiry(info.data_access_expires_at),
      coexistence,
    };
    const connectionDoc = await store.read(`bpl_whatsappConnections/${identity.uid}`, true);
    await claimWhatsAppAccount(store, input.wabaId);
    const registrationPath = `integrationSecrets/registration-${phone.id}`;
    const registration = !coexistence ? await store.read(registrationPath) : null;
    if (registration?.data.envelope) {
      const prior = await decryptConnection(
        registration.data.envelope as EncryptedConnection,
        identity.uid,
        env.encryptionKey,
      );
      if (prior.phoneNumberId === phone.id && prior.registrationPin)
        record.registrationPin = prior.registrationPin;
    }
    if (!coexistence && phone.platform_type !== 'CLOUD_API') {
      const pin =
        record.registrationPin ||
        String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
      record.registrationPin = pin;
      await store.commit([
        store.write(
          registrationPath,
          {
            envelope: await encryptConnection(record, identity.uid, env.encryptionKey),
            updatedAt: at(),
          },
          registration,
        ),
      ]);
      const registered = await graph(
        env,
        `${phone.id}/register`,
        accessToken,
        send,
        { messaging_product: 'whatsapp', pin },
        { appsecret_proof: appProof },
      );
      if (registered.success !== true)
        throw new ChatError(
          409,
          'Meta has not registered this number for Cloud API. Finish its verification in Meta.',
        );
    }
    const candidate = await encryptConnection(record, identity.uid, env.encryptionKey);
    const claimedSession = await store.read(sessionPath);
    if (
      !claimedSession ||
      claimedSession.data.stateHash !== (await chatHash(input.sessionId)) ||
      claimedSession.data.phase !== 'exchanging'
    )
      throw new ChatError(409, 'Another connection session started. Please reconnect.');
    await store.commit([
      store.write(
        sessionPath,
        { ...claimedSession.data, phase: 'finalizing', candidate, updatedAt: at() },
        claimedSession,
      ),
    ]);
    const callback = `${new URL(env.webhookBaseUrl!).origin}/webhook/${encodeURIComponent(identity.uid)}`;
    const subscription = await graph(
      env,
      `${input.wabaId}/subscribed_apps`,
      accessToken,
      send,
      { override_callback_uri: callback, verify_token: record.verifyToken },
      { appsecret_proof: appProof },
    );
    if (subscription.success !== true)
      throw new ChatError(
        409,
        'Meta has not accepted the webhook subscription. Reconnect after checking the portal callback.',
      );
    const finalSession = await store.read(sessionPath);
    if (
      !finalSession?.data.challengeAnsweredAt ||
      finalSession.data.stateHash !== (await chatHash(input.sessionId))
    )
      throw new ChatError(409, 'Meta has not verified the account callback yet. Please reconnect.');
    await store.commit([
      {
        update: {
          name: `projects/${env.projectId}/databases/(default)/documents/bpl_whatsappConnections/${identity.uid}`,
          fields: firestoreFields({
            ownerId: identity.uid,
            ...candidate,
            createdAt: connectionDoc?.data.createdAt || at(),
            updatedAt: at(),
          }),
        },
        currentDocument: connectionDoc
          ? { updateTime: connectionDoc.updateTime }
          : { exists: false },
      },
      store.write(
        'inboxStatus/webhook',
        {
          ownerId: identity.uid,
          phoneNumberId: record.phoneNumberId,
          challengeAnsweredAt: finalSession.data.challengeAnsweredAt,
        },
        undefined,
      ),
      store.write(
        sessionPath,
        { ownerId: identity.uid, phase: 'complete', updatedAt: at(), expiresAt: at() },
        finalSession,
      ),
    ]);
    let syncNeedsAttention = false;
    if (coexistence) {
      const syncPath = `integrationSessions/business-app-sync-${record.phoneNumberId}`;
      for (const syncType of ['smb_app_state_sync', 'history']) {
        const existingSync = await store.read(syncPath);
        if (existingSync?.data[syncType]) {
          if (existingSync.data[syncType].phase !== 'requested') syncNeedsAttention = true;
          continue;
        }
        // Meta allows each sync initiation once. Record the attempt before calling;
        // an ambiguous failure requires review instead of blindly repeating it.
        const current = existingSync?.data || {
          ownerId: identity.uid,
          phoneNumberId: record.phoneNumberId,
        };
        await store.commit([
          store.write(
            syncPath,
            { ...current, [syncType]: { phase: 'requesting', startedAt: at() } },
            existingSync,
          ),
        ]);
        try {
          const result = await graph(
            env,
            `${record.phoneNumberId}/smb_app_data`,
            accessToken,
            send,
            { messaging_product: 'whatsapp', sync_type: syncType },
            { appsecret_proof: appProof },
          );
          const snapshot = await store.read(syncPath);
          await store.commit([
            store.write(
              syncPath,
              {
                ...snapshot!.data,
                [syncType]: {
                  phase: 'requested',
                  requestedAt: at(),
                  requestId: String(result.request_id || ''),
                },
              },
              snapshot,
            ),
          ]);
        } catch {
          syncNeedsAttention = true;
        }
      }
    }
    const response = chatJson({
      connection: connectionSummary(record),
      message: syncNeedsAttention
        ? 'WhatsApp connected. Business app synchronization needs administrator review within 24 hours. Keep your WhatsApp Business app open.'
        : 'WhatsApp connected securely to your Google account. Signing out will not remove this connection.',
    });
    response.headers.set(
      'Set-Cookie',
      `${cookieName}=; HttpOnly; Secure; SameSite=Strict; Path=/api/whatsapp/embedded-signup; Max-Age=0`,
    );
    return response;
  } catch (error) {
    if (error instanceof ChatError)
      return chatJson(
        { error: error.message, code: error.code || 'WHATSAPP_CONNECT_FAILED' },
        error.status,
      );
    if (error instanceof SyntaxError)
      return chatJson({ error: 'Invalid connection request.' }, 400);
    // Provider messages, codes, request URLs and credentials must never escape here.
    return chatJson(
      {
        error:
          'WhatsApp connection could not be completed. Your saved connection was kept. Please try again.',
      },
      503,
    );
  }
}
