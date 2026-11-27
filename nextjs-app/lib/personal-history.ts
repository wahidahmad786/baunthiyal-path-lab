import {
  ChatError,
  ChatStore,
  chatHash,
  conversationFrom,
  nextChatStatus,
} from './account-chat-api';
import { openPersonal, sealPersonal } from './personal-auth';
import { personalMessageId, personalPhone } from './personal-events';
import { capturePersonalImage, isPersonalPhoto, type PersonalImage } from './personal-image';
import type { ChatMessage, ChatMessageStatus } from './chat-types';
import type { WAMessage } from '@whiskeysockets/baileys';
export type PersonalHistoryStatus = {
  phase: 'waiting' | 'requested' | 'syncing' | 'ready' | 'needs_relink' | 'error';
  message: string;
  progress: number | null;
  chats: number;
  messages: number;
  requestedAt?: string | null;
  updatedAt?: string;
  lastSyncedAt?: string | null;
  requestId?: string;
};
export type PersonalHistoryMessage = ChatMessage & {
  personalId: string;
  source: 'phone_history';
  personalImage?: PersonalImage;
};
export const historyStatusPath = 'personalHistoryStatus/current';
export const historyLimits = { chats: 500, messagesPerChat: 500, bytesPerChat: 520000 };
export function personalReceiptStatus(value: unknown, outbound: boolean): ChatMessageStatus {
  if (!outbound) return 'received';
  if (value == null) return 'unknown';
  const code = Number(value);
  return code >= 4
    ? 'read'
    : code === 3
      ? 'delivered'
      : code === 2
        ? 'sent'
        : code === 0
          ? 'failed'
          : 'unknown';
}
export async function personalMessageFrom(
  message: WAMessage,
  phone: string,
  normalize: (value: any) => any,
): Promise<PersonalHistoryMessage | null> {
  if (!message.key.id || !message.message) return null;
  const seconds = Number(message.messageTimestamp);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds * 1000 > Date.now() + 60000) return null;
  const content = normalize(message.message);
  if (
    !content ||
    content.protocolMessage ||
    content.reactionMessage ||
    content.senderKeyDistributionMessage
  )
    return null;
  const expiration = Number(
    (message as any).ephemeralDuration || content.extendedTextMessage?.contextInfo?.expiration || 0,
  );
  if (expiration > 0 && (seconds + expiration) * 1000 < Date.now()) return null;
  const viewOnce =
    message.message.viewOnceMessage ||
    message.message.viewOnceMessageV2 ||
    message.message.viewOnceMessageV2Extension;
  const isPhoto = isPersonalPhoto(message);
  const personalImage = isPhoto ? capturePersonalImage(message) : undefined;
  const text = isPhoto
    ? content.imageMessage?.caption || ''
    : viewOnce
      ? '[View-once message — open in WhatsApp]'
      : content.imageMessage
        ? '[Private photo — open in WhatsApp]'
        : content.conversation ||
          content.extendedTextMessage?.text ||
          content.videoMessage?.caption ||
          (content.videoMessage
            ? '[Video]'
            : content.audioMessage
              ? '[Voice message]'
              : content.documentMessage
                ? `[Document: ${String(content.documentMessage.fileName || 'attachment').slice(0, 150)}]`
                : content.stickerMessage
                  ? '[Sticker]'
                  : content.contactMessage
                    ? `[Contact: ${String(content.contactMessage.displayName || 'contact').slice(0, 150)}]`
                    : content.locationMessage
                      ? '[Location]'
                      : '[WhatsApp attachment]');
  return {
    id: await personalMessageId(phone, message.key.id),
    personalId: message.key.id,
    source: 'phone_history',
    direction: message.key.fromMe ? 'outbound' : 'inbound',
    type: isPhoto
      ? 'image'
      : typeof content.conversation === 'string' || content.extendedTextMessage
        ? 'text'
        : 'unsupported',
    text: String(text).slice(0, 4096),
    ...(personalImage ? { personalImage } : {}),
    createdAt: new Date(seconds * 1000).toISOString(),
    status: personalReceiptStatus(
      Object.hasOwn(message, 'status') ? message.status : undefined,
      !!message.key.fromMe,
    ),
  };
}
export function historyContactPhone(value: {
  id?: string | null;
  phoneNumber?: string | null;
  pnJid?: string | null;
}) {
  return (
    personalPhone(value.id) ||
    personalPhone(value.phoneNumber) ||
    personalPhone(value.pnJid) ||
    (value.phoneNumber && /^[1-9]\d{7,14}$/.test(value.phoneNumber) ? value.phoneNumber : null)
  );
}
export async function savePersonalContact(store: ChatStore, phone: string, name: string) {
  if (!/^[1-9]\d{7,14}$/.test(phone) || !name.trim()) return;
  name = name.trim().slice(0, 120);
  const id = (await chatHash(phone)).slice(0, 32);
  for (let attempt = 0; attempt < 4; attempt++) {
    const [old, conversation, customer] = await Promise.all([
      store.read(`personalContacts/${id}`),
      store.read(`conversations/${id}`),
      store.read(`customers/${id}`),
    ]);
    if (
      old?.data.name === name &&
      (!conversation || conversation.data.customerName === (customer?.data.name || name))
    )
      return;
    const writes = [
      store.write(
        `personalContacts/${id}`,
        { ownerId: store.uid, id, phone, name, updatedAt: new Date().toISOString() },
        old,
      ),
    ];
    if (conversation && conversation.data.customerName !== (customer?.data.name || name))
      writes.push(
        store.write(
          `conversations/${id}`,
          { customerName: customer?.data.name || name },
          conversation,
          ['customerName'],
        ),
      );
    if (conversation)
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
export async function readPersonalHistory(
  store: ChatStore,
  id: string,
): Promise<{ messages: PersonalHistoryMessage[]; clipped: boolean }> {
  const doc = await store.read(`personalHistory/${id}`);
  if (!doc) return { messages: [], clipped: false };
  try {
    const messages = JSON.parse(
      openPersonal(doc.data, store.uid, `history:${id}`, store.env.encryptionKey),
    );
    if (!Array.isArray(messages) || messages.length > historyLimits.messagesPerChat)
      throw new Error();
    return { messages, clipped: doc.data.clipped === true };
  } catch {
    throw new ChatError(503, 'Saved phone history could not be opened. Please retry sync.');
  }
}
export async function savePersonalHistoryChat(
  store: ChatStore,
  phone: string,
  name: string,
  incoming: PersonalHistoryMessage[],
  chat?: { unreadCount?: number | null; at?: string | null; clipped?: boolean },
) {
  const id = (await chatHash(phone)).slice(0, 32);
  for (let attempt = 0; attempt < 4; attempt++) {
    const [archive, existing, customer, contact] = await Promise.all([
      store.read(`personalHistory/${id}`),
      store.read(`conversations/${id}`),
      store.read(`customers/${id}`),
      store.read(`personalContacts/${id}`),
    ]);
    const previous: PersonalHistoryMessage[] = archive
      ? JSON.parse(openPersonal(archive.data, store.uid, `history:${id}`, store.env.encryptionKey))
      : [];
    const merged = new Map(previous.map((m) => [m.id, m]));
    for (const m of incoming) {
      const prior = merged.get(m.id);
      merged.set(
        m.id,
        prior
          ? {
              ...(m.type === 'image' ? { ...prior, ...m } : prior),
              ...(m.personalImage ? { personalImage: m.personalImage } : {}),
              status: nextChatStatus(prior.status, m.status),
            }
          : m,
      );
    }
    let messages = [...merged.values()].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
    let clipped =
      archive?.data.clipped === true ||
      chat?.clipped === true ||
      messages.length > historyLimits.messagesPerChat;
    messages = messages.slice(-historyLimits.messagesPerChat);
    let retainedBytes = 2,
      firstRetained = messages.length;
    for (let i = messages.length - 1; i >= 0; i--) {
      const bytes =
        Buffer.byteLength(JSON.stringify(messages[i]), 'utf8') +
        (firstRetained < messages.length ? 1 : 0);
      if (retainedBytes + bytes > historyLimits.bytesPerChat) break;
      retainedBytes += bytes;
      firstRetained = i;
    }
    if (firstRetained > 0) {
      messages = messages.slice(firstRetained);
      clipped = true;
    }
    const unchanged =
      archive &&
      JSON.stringify(messages) === JSON.stringify(previous) &&
      clipped === !!archive.data.clipped;
    const current = conversationFrom(
      existing?.data || {
        phone,
        customerId: id,
        customerName: customer?.data.name || contact?.data.name || name || phone,
      },
      id,
    );
    const latest = messages.at(-1),
      newer = latest && (!current.lastMessageAt || latest.createdAt > current.lastMessageAt);
    const summary = {
      ...current,
      ownerId: store.uid,
      provider: 'personal',
      historyUpdatedAt:
        messages.length && !unchanged
          ? new Date().toISOString()
          : existing?.data.historyUpdatedAt || null,
      customerName: customer?.data.name || name || contact?.data.name || current.customerName,
      ...(newer
        ? {
            lastMessageAt: latest.createdAt,
            lastMessagePreview: (latest.text || (latest.type === 'image' ? 'Photo' : '')).slice(
              0,
              240,
            ),
            lastMessageStatus: latest.status,
          }
        : {}),
      ...(!existing && !latest && chat?.at ? { lastMessageAt: chat.at } : {}),
      // Importing old chats does not create new unread events or marketing consent.
      ...(!existing && chat?.unreadCount != null
        ? { unreadCount: Math.max(0, Math.min(9999, Math.trunc(chat.unreadCount))) }
        : {}),
    };
    const writes = [];
    if (!unchanged && messages.length)
      writes.push(
        store.write(
          `personalHistory/${id}`,
          {
            ...sealPersonal(
              JSON.stringify(messages),
              store.uid,
              `history:${id}`,
              store.env.encryptionKey,
            ),
            count: messages.length,
            clipped,
            updatedAt: new Date().toISOString(),
          },
          archive,
        ),
      );
    if (
      !existing ||
      Object.entries(summary).some(
        ([key, value]) => JSON.stringify(existing.data[key]) !== JSON.stringify(value),
      )
    )
      writes.push(store.write(`conversations/${id}`, summary, existing));
    if (!writes.length) return { count: messages.length, id };
    writes.push(
      store.write('inboxStatus/personalRevision', { at: new Date().toISOString() }, undefined),
    );
    try {
      await store.commit(writes);
      return { count: messages.length, id };
    } catch (e) {
      if (!(e instanceof ChatError && e.status === 409) || attempt === 3) throw e;
    }
  }
  throw new ChatError(503, 'Phone chat history could not be saved.');
}
export async function personalHistoryStatus(store: ChatStore): Promise<PersonalHistoryStatus> {
  const doc = await store.read(historyStatusPath);
  if (!doc)
    return {
      phase: 'waiting',
      progress: null,
      chats: 0,
      messages: 0,
      message: 'Sync chats from your phone to load available conversations.',
    };
  const { phase, progress, chats, messages, message, requestedAt, updatedAt, lastSyncedAt } =
    doc.data;
  const stalled =
    ['requested', 'syncing'].includes(phase) &&
    Date.parse(updatedAt || requestedAt || '') < Date.now() - 90000;
  return {
    phase: stalled ? 'needs_relink' : phase,
    progress: typeof progress === 'number' ? progress : null,
    chats: Number(chats || 0),
    messages: Number(messages || 0),
    message: stalled
      ? 'Your phone has not sent more history. Keep WhatsApp online and retry sync, or re-link this device to import history.'
      : message,
    requestedAt: requestedAt || null,
    updatedAt,
    lastSyncedAt: lastSyncedAt || null,
  };
}
export async function ingestPersonalHistory(
  store: ChatStore,
  batch: {
    chats: any[];
    contacts: any[];
    messages: WAMessage[];
  },
  resolve: (key: {
    remoteJid?: string | null;
    remoteJidAlt?: string | null;
  }) => Promise<string | null>,
  normalize: (value: any) => any,
  onProgress?: (counts: { chats: number; messages: number }) => Promise<void>,
) {
  const names = new Map<string, string>();
  for (const c of batch.contacts.slice(0, 2000)) {
    const phone =
      historyContactPhone(c) || (await resolve({ remoteJid: c.id, remoteJidAlt: c.phoneNumber }));
    const name = String(c.name || c.notify || c.verifiedName || '')
      .trim()
      .slice(0, 120);
    if (phone && name) {
      names.set(phone, name);
    }
  }
  const chats = new Map<
    string,
    { name: string; unreadCount?: number; at?: string; messages: WAMessage[]; clipped?: boolean }
  >();
  for (const c of batch.chats) {
    const phone =
      historyContactPhone(c) || (await resolve({ remoteJid: c.id, remoteJidAlt: c.pnJid }));
    if (!phone || (!chats.has(phone) && chats.size >= historyLimits.chats)) continue;
    const seconds = Number(c.conversationTimestamp || c.lastMessageRecvTimestamp || 0);
    chats.set(phone, {
      name: names.get(phone) || String(c.name || c.displayName || ''),
      unreadCount: typeof c.unreadCount === 'number' ? c.unreadCount : undefined,
      at:
        seconds > 0 && seconds * 1000 <= Date.now() + 60000
          ? new Date(seconds * 1000).toISOString()
          : undefined,
      messages: [],
    });
  }
  for (const m of batch.messages) {
    const phone = await resolve(m.key);
    if (!phone) continue;
    if (!chats.has(phone)) {
      if (chats.size >= historyLimits.chats) continue;
      chats.set(phone, {
        name: names.get(phone) || (!m.key.fromMe ? m.pushName : '') || '',
        messages: [],
      });
    }
    const group = chats.get(phone)!;
    group.messages.push(m);
    if (group.messages.length > historyLimits.messagesPerChat * 2) {
      group.clipped = true;
      group.messages
        .sort((a, b) => Number(b.messageTimestamp) - Number(a.messageTimestamp))
        .splice(historyLimits.messagesPerChat);
    }
  }
  let messageCount = 0,
    completed = 0;
  const entries = [...chats.entries()];
  for (let offset = 0; offset < entries.length; offset += 4) {
    await Promise.all(
      entries.slice(offset, offset + 4).map(async ([phone, chat]) => {
        if (chat.messages.length > historyLimits.messagesPerChat) chat.clipped = true;
        const selected = chat.messages
          .sort((a, b) => Number(b.messageTimestamp) - Number(a.messageTimestamp))
          .slice(0, historyLimits.messagesPerChat);
        const messages = (
          await Promise.all(selected.map((m) => personalMessageFrom(m, phone, normalize)))
        ).filter((m): m is PersonalHistoryMessage => !!m);
        const saved = await savePersonalHistoryChat(store, phone, chat.name, messages, chat);
        messageCount += saved.count;
        completed++;
      }),
    );
    await onProgress?.({ chats: completed, messages: messageCount });
  }
  const contacts = [...names.entries()];
  for (let offset = 0; offset < contacts.length; offset += 8) {
    await Promise.all(
      contacts
        .slice(offset, offset + 8)
        .map(([phone, name]) => savePersonalContact(store, phone, name)),
    );
    if (offset % 40 === 0) await onProgress?.({ chats: completed, messages: messageCount });
  }
  return { chats: chats.size, messages: messageCount };
}
