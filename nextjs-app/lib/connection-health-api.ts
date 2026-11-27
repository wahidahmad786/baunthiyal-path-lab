import {
  ChatError,
  ChatStore,
  chatHash,
  chatJson,
  readChatConnection,
  verifyUser,
} from './account-chat-api';
import { inspectMetaToken, metaJson, MetaGraphError } from './meta-client';
import { allowedRequestOrigin } from './request-origin';
import type { ChatEnvironment } from './chat-types';
import type { ConnectionAlert, ConnectionHealth } from './crm-types';

const iso = () => new Date().toISOString();
function expires(value: unknown) {
  const n = Number(value);
  return n > 0 && Number.isFinite(n) && n < 253402300799 ? new Date(n * 1000).toISOString() : null;
}
type Issue = { id: string; title: string; message: string; severity: 'warning' | 'error' };
async function alertsFor(store: ChatStore): Promise<ConnectionAlert[]> {
  const listed = await store.list('connectionAlerts', 'lastSeenAt desc', 30);
  return listed.docs
    .map((d) => ({ id: d.name.split('/').pop()!, ...d.data }) as ConnectionAlert)
    .filter((d) => !d.resolvedAt);
}
async function persistAlerts(store: ChatStore, issues: Issue[]) {
  const existing = await store.list('connectionAlerts', 'lastSeenAt desc', 30);
  const writes: unknown[] = [];
  for (const issue of issues) {
    const previous = existing.docs.find((d) => d.name.endsWith('/' + issue.id));
    writes.push(
      store.write(
        `connectionAlerts/${issue.id}`,
        {
          ...issue,
          firstSeenAt: previous?.data.resolvedAt ? iso() : previous?.data.firstSeenAt || iso(),
          lastSeenAt: iso(),
          resolvedAt: null,
          dismissedAt: previous?.data.resolvedAt ? null : previous?.data.dismissedAt || null,
        },
        previous || null,
      ),
    );
  }
  for (const old of existing.docs)
    if (!old.data.resolvedAt && !issues.some((i) => old.name.endsWith('/' + i.id)))
      writes.push(
        store.write(
          `connectionAlerts/${old.name.split('/').pop()}`,
          { ...old.data, resolvedAt: iso() },
          old,
        ),
      );
  if (writes.length) await store.commit(writes);
}
async function currentHealth(store: ChatStore, force: boolean): Promise<ConnectionHealth> {
  const connection = await readChatConnection(store);
  const fingerprint = connection
    ? await chatHash(
        [
          connection.accessToken,
          connection.phoneNumberId,
          connection.appId,
          connection.appSecret,
          connection.verifiedAt,
          store.env.webhookPublicReady,
          store.env.webhookBaseUrl,
        ].join(':'),
      )
    : 'none';
  const snapshot = await store.read('integrationHealth/current');
  if (
    snapshot?.data.fingerprint === fingerprint &&
    Date.parse(snapshot.data.public?.nextCheckAt || '') > Date.now() &&
    (!force || Date.parse(snapshot.data.public?.checkedAt || '') > Date.now() - 30000)
  )
    return { ...snapshot.data.public, alerts: await alertsFor(store) };
  const lease = await store.read('integrationHealth/lease');
  if (lease && Date.parse(lease.data.expiresAt) > Date.now())
    return {
      ...(snapshot?.data.public || {
        state: 'unknown',
        checkedAt: null,
        nextCheckAt: null,
        tokenExpiresAt: null,
        dataAccessExpiresAt: null,
        webhookReady: false,
        message: 'Connection check is in progress.',
      }),
      alerts: await alertsFor(store),
    };
  try {
    await store.commit([
      store.write(
        'integrationHealth/lease',
        { expiresAt: new Date(Date.now() + 90000).toISOString() },
        lease,
      ),
    ]);
  } catch (error) {
    if (error instanceof ChatError && error.code === 'CONFLICT')
      return {
        ...(snapshot?.data.public || {
          state: 'unknown',
          checkedAt: null,
          nextCheckAt: null,
          tokenExpiresAt: null,
          dataAccessExpiresAt: null,
          webhookReady: false,
          message: 'Connection check is in progress.',
        }),
        alerts: await alertsFor(store),
      };
    throw error;
  }
  const issues: Issue[] = [];
  let state: ConnectionHealth['state'] = 'healthy',
    tokenExpiresAt: string | null = null,
    dataAccessExpiresAt: string | null = null;
  let webhookReady = false,
    message = 'Meta credentials and the saved webhook verification are available.';
  if (!connection) {
    state = 'not_connected';
    message = 'Connect your WhatsApp Business account to enable API messaging.';
  } else {
    try {
      const info = await inspectMetaToken(connection, store.send, store.env.graphVersion);
      tokenExpiresAt = expires(info.expires_at);
      dataAccessExpiresAt = expires(info.data_access_expires_at);
      if (
        !info.is_valid ||
        String(info.app_id) !== connection.appId ||
        [tokenExpiresAt, dataAccessExpiresAt].some(
          (value) => value && Date.parse(value) <= Date.now(),
        )
      ) {
        issues.push({
          id: 'token-invalid',
          title: 'Reconnect WhatsApp',
          severity: 'error',
          message:
            'Meta access expired or was revoked. Reconnect in WhatsApp Integration. Your saved records are kept.',
        });
      } else {
        if (
          !['whatsapp_business_messaging', 'whatsapp_business_management'].every((scope) =>
            info.scopes?.includes(scope),
          )
        )
          issues.push({
            id: 'permissions-missing',
            title: 'WhatsApp permissions need attention',
            severity: 'error',
            message:
              'Meta access is missing messaging or account-management permissions. Reconnect and grant the required access.',
          });
        await metaJson(
          connection,
          connection.phoneNumberId,
          store.send,
          store.env.graphVersion,
          undefined,
          { fields: 'id,display_phone_number' },
        );
        for (const [id, end, title] of [
          ['token-expiring', tokenExpiresAt, 'WhatsApp token expires soon'],
          ['access-expiring', dataAccessExpiresAt, 'WhatsApp permission expires soon'],
        ] as const)
          if (end && Date.parse(end) < Date.now() + 7 * 86400000)
            issues.push({
              id,
              title,
              severity: 'warning',
              message: `Meta access ends on ${new Date(end).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST. Reconnect before this date.`,
            });
      }
      const webhook = await store.read('inboxStatus/webhook');
      webhookReady = !!(
        store.env.webhookPublicReady &&
        store.env.webhookBaseUrl &&
        webhook?.data.phoneNumberId === connection.phoneNumberId &&
        (webhook.data.challengeAnsweredAt || webhook.data.lastSignedEventAt) &&
        !webhook.data.disconnectedAt
      );
      if (info.is_valid && String(info.app_id) === connection.appId) {
        const subscribed = await metaJson(
          connection,
          `${connection.businessAccountId}/subscribed_apps`,
          store.send,
          store.env.graphVersion,
        );
        if (!Array.isArray(subscribed.data))
          throw new MetaGraphError(502, 0, 'Meta did not return the webhook subscription status.');
        webhookReady =
          webhookReady &&
          subscribed.data.some(
            (entry: any) =>
              String(entry.whatsapp_business_api_data?.id || entry.id) === connection.appId,
          );
      }
      if (!webhookReady)
        issues.push({
          id: 'webhook-unready',
          title: 'Incoming messages are not ready',
          severity: 'warning',
          message:
            'Open WhatsApp Integration and complete or reconnect the signed Meta callback subscription.',
        });
      if (!connection.verifiedAt)
        issues.push({
          id: 'connection-unverified',
          title: 'Verify your WhatsApp connection',
          severity: 'warning',
          message:
            'These saved credentials have not been verified. Open WhatsApp Integration and verify them.',
        });
      if (issues.length) {
        state = 'action_required';
        message = issues[0].message;
      }
    } catch (error) {
      if (error instanceof MetaGraphError && [190, 102, 104].includes(error.code)) {
        state = 'action_required';
        issues.push({
          id: 'token-invalid',
          title: 'Reconnect WhatsApp',
          severity: 'error',
          message: error.message,
        });
      } else if (error instanceof MetaGraphError && error.status === 403) {
        state = 'action_required';
        issues.push({
          id: 'permissions-missing',
          title: 'WhatsApp permissions need attention',
          severity: 'error',
          message: error.message,
        });
      } else {
        state = 'unknown';
        issues.push({
          id: 'provider-unavailable',
          title: 'WhatsApp status could not be checked',
          severity: 'warning',
          message:
            error instanceof MetaGraphError
              ? error.message
              : 'The connection check could not complete. Try checking again shortly.',
        });
      }
      message = issues[0].message;
    }
  }
  // A provider outage is not evidence that older authorization failures have resolved.
  if (state === 'unknown') {
    const prior = await alertsFor(store);
    for (const alert of prior)
      if (!issues.some((i) => i.id === alert.id))
        issues.push({
          id: alert.id,
          title: alert.title,
          message: alert.message,
          severity: alert.severity,
        });
  }
  await persistAlerts(store, issues);
  const health = {
    state,
    tokenExpiresAt,
    dataAccessExpiresAt,
    webhookReady,
    message,
    checkedAt: iso(),
    nextCheckAt: new Date(Date.now() + (state === 'unknown' ? 60000 : 300000)).toISOString(),
  };
  await store.commit([
    store.write('integrationHealth/current', { fingerprint, public: health }, undefined),
    store.remove('integrationHealth/lease'),
  ]);
  return { ...health, alerts: await alertsFor(store) };
}
export async function handleConnectionHealth(
  request: Request,
  env: ChatEnvironment,
  send: typeof fetch = fetch,
) {
  try {
    if (!['GET', 'POST'].includes(request.method))
      return chatJson({ error: 'Method not allowed' }, 405);
    if (request.method === 'POST' && !allowedRequestOrigin(request, env.appOrigin))
      throw new ChatError(403, 'Request origin is not allowed');
    const user = await verifyUser(request, env, send);
    const store = await ChatStore.open(env, user.uid, send, user.token, true);
    const path = new URL(request.url).pathname;
    const dismiss = /^\/api\/account\/connection-health\/alerts\/([a-z-]{1,60})\/dismiss$/.exec(
      path,
    );
    if (dismiss && request.method === 'POST') {
      const existing = await store.read(`connectionAlerts/${dismiss[1]}`);
      if (!existing) throw new ChatError(404, 'Alert not found.');
      await store.commit([
        store.write(
          `connectionAlerts/${dismiss[1]}`,
          { ...existing.data, dismissedAt: iso() },
          existing,
        ),
      ]);
      return chatJson({ message: 'Alert acknowledged.' });
    }
    if (
      path !== '/api/account/connection-health' &&
      path !== '/api/account/connection-health/check'
    )
      throw new ChatError(404, 'Connection check not found.');
    return chatJson(await currentHealth(store, request.method === 'POST'));
  } catch (error) {
    if (error instanceof ChatError) return chatJson({ error: error.message }, error.status);
    return chatJson(
      { error: 'Unable to check the WhatsApp connection right now. Please try again.' },
      503,
    );
  }
}
