import {
  ChatError,
  ChatStore,
  chatHash,
  chatJson,
  conversationFrom,
  nextChatStatus,
  readChatBody,
  readChatConnection,
  safeUid,
  type ChatDocument,
} from './account-chat-api';
import type { ChatEnvironment, ChatMessageStatus } from './chat-types';
import { pendingEmbeddedChallenge } from './embedded-signup-api';
import type { ConnectionRecord } from './whatsapp-connection';

function object(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;
}
function validPhone(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{7,14}$/.test(value);
}
function providerTime(value: unknown) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds * 1000 > Date.now() + 5 * 60000)
    throw new ChatError(400, 'Invalid provider timestamp.');
  return new Date(seconds * 1000).toISOString();
}
async function equalSecret(a: string, b: string) {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  const aa = new Uint8Array(left),
    bb = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < aa.length; index++) difference |= aa[index] ^ bb[index];
  return difference === 0;
}
export function isStopMessage(text: string) {
  return /^\s*(STOP(?:\s+ALL)?|UNSUBSCRIBE|CANCEL|END|QUIT)\s*[.!]?\s*$/i.test(text);
}
async function retryConflict(run: () => Promise<void>) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await run();
      return;
    } catch (e) {
      if (!(e instanceof ChatError && e.code === 'CONFLICT') || attempt === 4) throw e;
    }
  }
}
async function saveInbound(
  store: ChatStore,
  value: Record<string, any>,
  message: Record<string, any>,
  historical = false,
) {
  if (
    !validPhone(message.from) ||
    typeof message.id !== 'string' ||
    !message.id ||
    message.id.length > 1024
  )
    throw new ChatError(400, 'Invalid inbound message.');
  const id = (await chatHash(message.from)).slice(0, 32);
  const messageId = `meta-${await chatHash(message.id)}`;
  const createdAt = providerTime(message.timestamp);
  const textMessage = message.type === 'text' && typeof message.text?.body === 'string';
  const text = textMessage
    ? message.text.body.slice(0, 4096)
    : `[${String(message.type || 'Unsupported').slice(0, 50)} message received in WhatsApp]`;
  await retryConflict(async () => {
    const [existing, conversationDoc, customer] = await Promise.all([
      store.read(`conversations/${id}/messages/${messageId}`),
      store.read(`conversations/${id}`),
      store.read(`customers/${id}`),
    ]);
    if (existing && (historical || existing.data.source !== 'business_app_history')) return;
    const contact = (Array.isArray(value.contacts) ? value.contacts : []).find(
      (entry: any) => entry?.wa_id === message.from,
    );
    const name =
      typeof customer?.data.name === 'string'
        ? customer.data.name
        : typeof contact?.profile?.name === 'string'
          ? contact.profile.name.slice(0, 120)
          : 'WhatsApp customer';
    const current = conversationFrom(
      conversationDoc?.data || { phone: message.from, customerId: id, customerName: name },
      id,
    );
    const latest =
      !current.lastMessageAt || Date.parse(createdAt) >= Date.parse(current.lastMessageAt);
    const latestInbound =
      conversationDoc?.data.phoneNumberId !== value.metadata.phone_number_id ||
      !current.lastInboundAt ||
      Date.parse(createdAt) > Date.parse(current.lastInboundAt);
    const conversation = {
      ...current,
      lastInboundAt:
        conversationDoc?.data.phoneNumberId === value.metadata.phone_number_id
          ? current.lastInboundAt
          : null,
      ownerId: store.uid,
      phoneNumberId: value.metadata.phone_number_id,
      phone: message.from,
      customerName: name,
      unreadCount: current.unreadCount + (historical ? 0 : 1),
      ...(latest
        ? {
            lastMessageAt: createdAt,
            lastMessagePreview: text.slice(0, 240),
            lastMessageStatus: 'received',
          }
        : {}),
      ...(!historical && latestInbound ? { lastInboundAt: createdAt } : {}),
    };
    const writes: unknown[] = [
      store.write(
        `conversations/${id}/messages/${messageId}`,
        {
          ownerId: store.uid,
          id: messageId,
          metaId: message.id,
          direction: 'inbound',
          type: textMessage ? 'text' : 'unsupported',
          text,
          status: 'received',
          createdAt,
          providerAt: createdAt,
          source: historical ? 'business_app_history' : 'cloud_api',
        },
        existing,
      ),
      store.write(`conversations/${id}`, conversation, conversationDoc),
    ];
    if (
      !historical &&
      customer &&
      textMessage &&
      isStopMessage(text) &&
      customer.data.marketing?.status !== 'opted_out'
    ) {
      const eventId = crypto.randomUUID();
      const at = new Date().toISOString();
      const source = 'customer_whatsapp_stop';
      writes.push(
        store.write(
          `customers/${id}`,
          { marketing: { status: 'opted_out', source, at, eventId } },
          customer,
          ['marketing'],
        ),
      );
      writes.push(
        store.write(
          `consentEvents/${eventId}`,
          {
            ownerId: store.uid,
            customerId: id,
            status: 'opted_out',
            source,
            actor: store.uid,
            createdAt: at,
          },
          null,
        ),
      );
    }
    await store.commit(writes);
  });
}
async function saveStatus(
  store: ChatStore,
  event: Record<string, any>,
  phoneNumberId: string,
  echo?: Record<string, any>,
) {
  if (
    !validPhone(event.recipient_id) ||
    typeof event.id !== 'string' ||
    !event.id ||
    event.id.length > 1024
  )
    throw new ChatError(400, 'Invalid provider receipt.');
  if (!['sent', 'delivered', 'read', 'failed'].includes(event.status)) return;
  const id = (await chatHash(event.recipient_id)).slice(0, 32);
  const messageId = `meta-${await chatHash(event.id)}`;
  const providerAt = providerTime(event.timestamp);
  await retryConflict(async () => {
    const [existing, conversationDoc, customer] = await Promise.all([
      store.read(`conversations/${id}/messages/${messageId}`),
      store.read(`conversations/${id}`),
      store.read(`customers/${id}`),
    ]);
    const previous = existing?.data.status || 'accepted';
    const status = nextChatStatus(previous, event.status as ChatMessageStatus);
    if (existing && status === previous && !echo) return;
    const current = conversationFrom(
      conversationDoc?.data || {
        phone: event.recipient_id,
        customerId: id,
        customerName: customer?.data.name || 'WhatsApp customer',
      },
      id,
    );
    if (conversationDoc?.data.phoneNumberId !== phoneNumberId) current.lastInboundAt = null;
    const createdAt = existing?.data.createdAt || providerAt;
    const stored = { ...(existing?.data || {}) };
    if (status !== 'failed') delete stored.error;
    const message = {
      ...stored,
      ownerId: store.uid,
      id: messageId,
      metaId: event.id,
      direction: 'outbound',
      type: echo
        ? echo.type === 'text' && typeof echo.text?.body === 'string'
          ? 'text'
          : 'unsupported'
        : existing?.data.type || 'unsupported',
      text:
        (echo
          ? typeof echo.text?.body === 'string'
            ? echo.text.body.slice(0, 4096)
            : `[${String(echo.type || 'Unsupported').slice(0, 50)} message sent in WhatsApp Business app]`
          : existing?.data.text) ||
        '[Outbound message status received from Meta; content is not available]',
      status,
      createdAt,
      providerAt,
      ...(echo ? { source: 'business_app' } : {}),
      ...(status === 'failed'
        ? {
            error: Number.isSafeInteger(Number(event.errors?.[0]?.code))
              ? `Meta reported a delivery failure (code ${Number(event.errors[0].code)}).`
              : 'Meta reported a delivery failure.',
          }
        : {}),
    };
    const latest =
      !current.lastMessageAt || Date.parse(createdAt) >= Date.parse(current.lastMessageAt);
    await store.commit([
      store.write(`conversations/${id}/messages/${messageId}`, message, existing),
      store.write(
        `conversations/${id}`,
        {
          ...current,
          ownerId: store.uid,
          phoneNumberId,
          ...(latest
            ? {
                lastMessagePreview: String(message.text).slice(0, 240),
                lastMessageAt: createdAt,
                lastMessageStatus: status,
              }
            : {}),
        },
        conversationDoc,
      ),
    ]);
  });
}

async function saveContact(store: ChatStore, value: Record<string, any>, item: any) {
  if (item?.type !== 'contact' || item.action !== 'add') return;
  const phone = String(item.contact?.phone_number || '').replace(/\D/g, '');
  if (!validPhone(phone)) return; // Phone-less business-scoped identities are not phone recipients.
  const id = (await chatHash(phone)).slice(0, 32);
  await retryConflict(async () => {
    const [conversation, customer] = await Promise.all([
      store.read(`conversations/${id}`),
      store.read(`customers/${id}`),
    ]);
    const current = conversationFrom(conversation?.data || { phone }, id);
    await store.commit([
      store.write(
        `conversations/${id}`,
        {
          ...current,
          ownerId: store.uid,
          phoneNumberId: value.metadata.phone_number_id,
          lastInboundAt:
            conversation?.data.phoneNumberId === value.metadata.phone_number_id
              ? current.lastInboundAt
              : null,
          customerName:
            customer?.data.name ||
            String(item.contact.full_name || item.contact.first_name || current.customerName).slice(
              0,
              120,
            ),
        },
        conversation,
      ),
    ]);
  });
  // Importing a contact never creates marketing consent or a customer registration.
}
async function saveBusinessAppChange(
  store: ChatStore,
  connection: ConnectionRecord,
  field: string,
  value: Record<string, any>,
) {
  if (field === 'smb_app_state_sync') {
    for (const item of Array.isArray(value.state_sync) ? value.state_sync : [])
      await saveContact(store, value, item);
  } else if (field === 'smb_message_echoes') {
    for (const item of Array.isArray(value.message_echoes) ? value.message_echoes : []) {
      if (!validPhone(item?.to) || item.from !== connection.phone.replace(/\D/g, '')) continue;
      await saveStatus(
        store,
        { id: item.id, timestamp: item.timestamp, recipient_id: item.to, status: 'sent' },
        connection.phoneNumberId,
        item,
      );
    }
  } else if (field === 'history') {
    for (const chunk of Array.isArray(value.history) ? value.history : []) {
      if (chunk.errors) continue; // A customer may decline history sharing.
      for (const thread of Array.isArray(chunk.threads) ? chunk.threads : []) {
        const phone = thread.id || thread.context?.wa_id;
        if (!validPhone(phone)) continue;
        for (const item of Array.isArray(thread.messages) ? thread.messages : []) {
          if (item.from === phone) await saveInbound(store, value, item, true);
          else if (item.from === connection.phone.replace(/\D/g, '')) {
            const status = ['sent', 'delivered', 'read', 'failed'].includes(
              item.history_context?.status,
            )
              ? item.history_context.status
              : 'sent';
            await saveStatus(
              store,
              { id: item.id, timestamp: item.timestamp, recipient_id: phone, status },
              connection.phoneNumberId,
              item,
            );
          }
        }
      }
    }
  }
}
async function saveWebhookStatus(store: ChatStore, values: Record<string, unknown>) {
  await retryConflict(async () => {
    const status = await store.read('inboxStatus/webhook');
    await store.commit([
      store.write(
        'inboxStatus/webhook',
        {
          ...(status && status.data.phoneNumberId === values.phoneNumberId ? status.data : {}),
          ownerId: store.uid,
          ...values,
        },
        status,
      ),
    ]);
  });
}

export async function handleWhatsAppWebhook(
  request: Request,
  uid: string,
  env: ChatEnvironment,
  send: typeof fetch = fetch,
): Promise<Response> {
  try {
    if (!safeUid(uid)) throw new ChatError(404, 'Callback not found.');
    if (!['GET', 'POST'].includes(request.method))
      return chatJson({ error: 'Method not allowed' }, 405);
    const url = new URL(request.url);
    if (
      request.method === 'GET' &&
      (url.searchParams.get('hub.mode') !== 'subscribe' ||
        (url.searchParams.get('hub.challenge')?.length || 0) > 512 ||
        !url.searchParams.get('hub.challenge'))
    )
      throw new ChatError(403, 'Invalid callback verification request.');
    const signature = request.headers.get('x-hub-signature-256') || '';
    if (request.method === 'POST' && !/^sha256=[a-f0-9]{64}$/i.test(signature))
      throw new ChatError(403, 'Invalid callback signature.');
    const store = await ChatStore.open(env, uid, send, undefined, true);
    const connection = await readChatConnection(store);
    if (
      request.method === 'GET' &&
      (!connection?.verifyToken ||
        !(await equalSecret(
          url.searchParams.get('hub.verify_token') || '',
          connection.verifyToken,
        )))
    ) {
      const pending = await pendingEmbeddedChallenge(
        store,
        url.searchParams.get('hub.verify_token') || '',
      );
      if (pending)
        return new Response(url.searchParams.get('hub.challenge'), {
          headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
        });
    }
    if (!connection) throw new ChatError(404, 'Callback not found.');
    if (request.method === 'GET') {
      if (
        !connection.verifyToken ||
        !(await equalSecret(url.searchParams.get('hub.verify_token') || '', connection.verifyToken))
      )
        throw new ChatError(403, 'Invalid callback verification token.');
      await saveWebhookStatus(store, {
        challengeAnsweredAt: new Date().toISOString(),
        phoneNumberId: connection.phoneNumberId,
      });
      return new Response(url.searchParams.get('hub.challenge'), {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    const body = await readChatBody(request, 1024 * 1024);
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(connection.appSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const signed = Uint8Array.from(signature.slice(7).match(/../g)!, (value) =>
      parseInt(value, 16),
    );
    if (!(await crypto.subtle.verify('HMAC', key, signed, body)))
      throw new ChatError(403, 'Invalid callback signature.');
    const payload = object(JSON.parse(new TextDecoder().decode(body)));
    if (
      !payload ||
      payload.object !== 'whatsapp_business_account' ||
      !Array.isArray(payload.entry) ||
      payload.entry.length > 100
    )
      throw new ChatError(400, 'Invalid callback payload.');
    let processed = 0;
    let matchedSender = false;
    for (const entry of payload.entry) {
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];
      if (changes.length > 100) throw new ChatError(413, 'Too many callback changes.');
      for (const change of changes) {
        const value = object(change?.value);
        if (
          connection.coexistence &&
          change?.field === 'account_update' &&
          value &&
          (value.waba_info?.waba_id === connection.businessAccountId ||
            entry.id === connection.businessAccountId) &&
          ['PARTNER_REMOVED', 'ACCOUNT_OFFBOARDED'].includes(value.event)
        ) {
          await saveWebhookStatus(store, {
            phoneNumberId: connection.phoneNumberId,
            disconnectedAt: new Date().toISOString(),
          });
          continue;
        }
        if (
          connection.coexistence &&
          ['history', 'smb_app_state_sync', 'smb_message_echoes'].includes(change?.field) &&
          value?.metadata?.phone_number_id === connection.phoneNumberId
        ) {
          await saveBusinessAppChange(store, connection, change.field, value);
          matchedSender = true;
          continue;
        }
        if (
          change?.field !== 'messages' ||
          !value ||
          value.metadata?.phone_number_id !== connection.phoneNumberId
        )
          continue;
        matchedSender = true;
        const messages = Array.isArray(value.messages) ? value.messages : [];
        const statuses = Array.isArray(value.statuses) ? value.statuses : [];
        if (
          messages.length + statuses.length > 100 ||
          processed + messages.length + statuses.length > 200
        )
          throw new ChatError(413, 'Too many callback events.');
        for (const message of messages) {
          const item = object(message);
          if (!item) throw new ChatError(400, 'Invalid inbound message.');
          await saveInbound(store, value, item);
          processed++;
        }
        for (const status of statuses) {
          const item = object(status);
          if (!item) throw new ChatError(400, 'Invalid delivery receipt.');
          await saveStatus(store, item, connection.phoneNumberId);
          processed++;
        }
      }
    }
    if (matchedSender)
      await saveWebhookStatus(store, {
        lastSignedEventAt: new Date().toISOString(),
        phoneNumberId: connection.phoneNumberId,
      });
    return chatJson({ received: true });
  } catch (error) {
    if (error instanceof ChatError)
      return chatJson(
        { error: error.message, ...(error.code ? { code: error.code } : {}) },
        error.status,
      );
    if (error instanceof SyntaxError) return chatJson({ error: 'Invalid callback payload.' }, 400);
    return chatJson({ error: 'The callback could not be recorded. Please retry.' }, 503);
  }
}
