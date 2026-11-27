import { openPersonal, sealPersonal } from './personal-auth';
import {
  ChatError,
  ChatStore,
  chatHash,
  conversationFrom,
  nextChatStatus,
} from './account-chat-api';
import type { PersonalImage } from './personal-image';
import type { ChatMessageStatus } from './chat-types';
export function personalPhone(jid?: string | null) {
  if (!jid || !/^\d+(?::\d+)?@s\.whatsapp\.net$/.test(jid)) return null;
  const phone = jid.split('@')[0].split(':')[0];
  return /^[1-9]\d{7,14}$/.test(phone) ? phone : null;
}
export const personalMessageId = async (phone: string, providerId: string) =>
  `personal-${await chatHash(`${phone}:${providerId}`)}`;
export async function recordPersonalMessage(
  store: ChatStore,
  event: {
    phone: string;
    providerId: string;
    text: string;
    outbound: boolean;
    name?: string;
    at: string;
    status: ChatMessageStatus;
    allowOptOut?: boolean;
    isPhoto?: boolean;
    image?: PersonalImage;
  },
) {
  const id = (await chatHash(event.phone)).slice(0, 32);
  const messageId = await personalMessageId(event.phone, event.providerId);
  for (let attempt = 0; attempt < 5; attempt++) {
    const [message, conversation, customer, receipt, contact] = await Promise.all([
      store.read(`conversations/${id}/messages/${messageId}`),
      store.read(`conversations/${id}`),
      store.read(`customers/${id}`),
      store.read(`personalReceipts/${messageId}`),
      store.read(`personalContacts/${id}`),
    ]);
    const current = conversationFrom(
      conversation?.data || {
        phone: event.phone,
        customerId: id,
        customerName:
          customer?.data.name ||
          contact?.data.name ||
          (!event.outbound ? event.name : '') ||
          event.phone,
      },
      id,
    );
    const isLatest =
      !current.lastMessageAt || Date.parse(event.at) >= Date.parse(current.lastMessageAt);
    const observedStatus = message
      ? nextChatStatus(message.data.status, event.status)
      : event.status;
    const status =
      receipt && event.outbound
        ? nextChatStatus(observedStatus, receipt.data.status)
        : observedStatus;
    const writes = [
      store.write(
        `conversations/${id}/messages/${messageId}`,
        {
          id: messageId,
          ownerId: store.uid,
          provider: 'personal',
          personalId: event.providerId,
          direction: event.outbound ? 'outbound' : 'inbound',
          type: event.isPhoto || message?.data.type === 'image' ? 'image' : 'text',
          imageAvailable: event.image ? true : message?.data.imageAvailable === true || undefined,
          text: (!event.isPhoto && message?.data.type === 'image'
            ? String(message.data.text || '')
            : event.text
          ).slice(0, 4096),
          createdAt: message?.data.createdAt || event.at,
          status,
        },
        message,
      ),
      store.write(
        `conversations/${id}`,
        {
          ...current,
          ownerId: store.uid,
          provider: 'personal',
          ...(isLatest
            ? {
                lastMessagePreview: (event.text || (event.isPhoto ? 'Photo' : '')).slice(0, 240),
                lastMessageAt: event.at,
                lastMessageStatus: status,
              }
            : {}),
          ...(!event.outbound && (!current.lastInboundAt || event.at > current.lastInboundAt)
            ? { lastInboundAt: event.at }
            : {}),
          unreadCount: current.unreadCount + (!event.outbound && !message ? 1 : 0),
        },
        conversation,
      ),
    ];
    if (event.image)
      writes.push(
        store.write(
          `personalMessageImages/${messageId}`,
          sealPersonal(
            JSON.stringify(event.image),
            store.uid,
            `image:${id}:${messageId}`,
            store.env.encryptionKey,
          ),
          undefined,
        ),
      );
    if (
      !message &&
      !event.isPhoto &&
      !event.outbound &&
      event.allowOptOut &&
      /^STOP$/i.test(event.text.trim()) &&
      customer &&
      customer.data.marketing?.status !== 'opted_out' &&
      Date.parse(event.at) >= Date.parse(customer.data.marketing?.at || '1970-01-01T00:00:00Z')
    ) {
      const eventId = `personal-stop-${await chatHash(event.providerId)}`;
      writes.push(
        store.write(
          `customers/${id}`,
          {
            marketing: {
              status: 'opted_out',
              source: 'whatsapp_personal_stop',
              at: event.at,
              eventId,
            },
          },
          customer,
          ['marketing'],
        ),
        store.write(
          `consentEvents/${eventId}`,
          {
            customerId: id,
            ownerId: store.uid,
            status: 'opted_out',
            source: 'whatsapp_personal_stop',
            at: event.at,
          },
          undefined,
        ),
      );
    }
    writes.push(
      store.write('inboxStatus/personalRevision', { at: new Date().toISOString() }, undefined),
    );
    try {
      await store.commit(writes);
      return messageId;
    } catch (e) {
      if (!(e instanceof ChatError && e.status === 409) || attempt === 4) throw e;
    }
  }
  throw new ChatError(503, 'Unable to record the linked WhatsApp message.');
}
export async function recordPersonalReceipt(
  store: ChatStore,
  phone: string,
  providerId: string,
  status: ChatMessageStatus,
) {
  const id = (await chatHash(phone)).slice(0, 32),
    messageId = await personalMessageId(phone, providerId);
  for (let attempt = 0; attempt < 4; attempt++) {
    const message = await store.read(`conversations/${id}/messages/${messageId}`);
    if (!message) {
      const archive = await store.read(`personalHistory/${id}`);
      if (archive) {
        const history = JSON.parse(
          openPersonal(archive.data, store.uid, `history:${id}`, store.env.encryptionKey),
        ) as { id: string; direction: string; status: ChatMessageStatus; createdAt: string }[];
        const historical = history.find((m) => m.id === messageId && m.direction === 'outbound');
        if (historical) {
          const next = nextChatStatus(historical.status, status);
          if (next === historical.status) return;
          historical.status = next;
          const conversation = await store.read(`conversations/${id}`);
          const writes = [
            store.write(
              `personalHistory/${id}`,
              {
                ...archive.data,
                ...sealPersonal(
                  JSON.stringify(history),
                  store.uid,
                  `history:${id}`,
                  store.env.encryptionKey,
                ),
                updatedAt: new Date().toISOString(),
              },
              archive,
            ),
            store.write(
              `conversations/${id}`,
              {
                historyUpdatedAt: new Date().toISOString(),
                ...(conversation?.data.lastMessageAt === historical.createdAt
                  ? { lastMessageStatus: next }
                  : {}),
              },
              conversation,
              [
                'historyUpdatedAt',
                ...(conversation?.data.lastMessageAt === historical.createdAt
                  ? ['lastMessageStatus']
                  : []),
              ],
            ),
            store.write(
              'inboxStatus/personalRevision',
              { at: new Date().toISOString() },
              undefined,
            ),
          ];
          try {
            await store.commit(writes);
            return;
          } catch (e) {
            if (!(e instanceof ChatError && e.status === 409) || attempt === 3) throw e;
            continue;
          }
        }
      }
      const previous = await store.read(`personalReceipts/${messageId}`);
      try {
        await store.commit([
          store.write(
            `personalReceipts/${messageId}`,
            {
              status: previous ? nextChatStatus(previous.data.status, status) : status,
              updatedAt: new Date().toISOString(),
            },
            previous,
          ),
        ]);
        return;
      } catch (e) {
        if (!(e instanceof ChatError && e.status === 409) || attempt === 3) throw e;
        continue;
      }
    }
    if (message.data.direction !== 'outbound') return;
    const next = nextChatStatus(message.data.status, status);
    if (next === message.data.status) return;
    const conversation = await store.read(`conversations/${id}`);
    const writes = [
      store.write(`conversations/${id}/messages/${messageId}`, { status: next }, message, [
        'status',
      ]),
    ];
    if (conversation?.data.lastMessageAt === message.data.createdAt)
      writes.push(
        store.write(`conversations/${id}`, { lastMessageStatus: next }, conversation, [
          'lastMessageStatus',
        ]),
      );
    writes.push(
      store.write('inboxStatus/personalRevision', { at: new Date().toISOString() }, undefined),
    );
    try {
      await store.commit(writes);
      return;
    } catch (e) {
      if (!(e instanceof ChatError && e.status === 409) || attempt === 3) throw e;
    }
  }
}
