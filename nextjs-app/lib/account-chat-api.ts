import { readPersonalHistory, personalHistoryStatus } from './personal-history';
import { providerDocument } from './whatsapp-provider';
import { personalStatus, sendPersonal, requestPersonalHistory } from './personal-whatsapp';
import { personalMessageId } from './personal-events';
import { parseAttachmentUpload, reserveAttachmentUpload } from './personal-attachment-send';
import { openPersonal } from './personal-auth';
import {
  attachmentFromRecord,
  oldPersonalImage,
  personalMediaBytes,
  type PersonalMedia,
} from './personal-image';
import { z } from 'zod';
import { normalizePhone } from './domain';
import { allowedRequestOrigin } from './request-origin';
import { metaTestSender, replyBlockFor } from './chat-reply-state';
import { metaReplyError } from './meta-reply-error';
import {
  decryptConnection,
  type ConnectionRecord,
  type EncryptedConnection,
} from './whatsapp-connection';
import { getServiceAccessToken } from './google-service-account';
import { inboxAccess } from './team-access';
import { conversationMeta } from './team-api';
import type {
  ChatConversation,
  ChatDetailResponse,
  ChatEnvironment,
  ChatInboxResponse,
  ChatMessage,
  ChatMessageStatus,
} from './chat-types';

export class ChatError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}
export const chatJson = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
export const safeUid = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 128 &&
  !/[\/\x00-\x1f]/.test(value);
const encode = (value: string) => new TextEncoder().encode(value);
export async function chatHash(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encode(value))), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
export function chatWindowOpen(lastInboundAt: string | null, now = Date.now()) {
  const at = lastInboundAt ? Date.parse(lastInboundAt) : NaN;
  return Number.isFinite(at) && at <= now + 60000 && at > now - 24 * 3600000;
}
export function nextChatStatus(
  previous: ChatMessageStatus,
  next: ChatMessageStatus,
): ChatMessageStatus {
  const rank: Partial<Record<ChatMessageStatus, number>> = {
    submitting: -1,
    accepted: 0,
    sent: 1,
    delivered: 2,
    read: 3,
  };
  if (previous === 'received') return previous;
  if (next === 'failed' || next === 'unknown') return (rank[previous] ?? -1) >= 2 ? previous : next;
  if (rank[next] !== undefined && rank[next]! > (rank[previous] ?? -2)) return next;
  return previous;
}
type FirestoreValue = {
  nullValue?: null;
  stringValue?: string;
  timestampValue?: string;
  integerValue?: string;
  doubleValue?: number;
  booleanValue?: boolean;
  mapValue?: { fields: Record<string, FirestoreValue> };
  arrayValue?: { values?: FirestoreValue[] };
};
function field(value: unknown, key = ''): FirestoreValue {
  if (value === null) return { nullValue: null };
  if (typeof value === 'string')
    return /At$/.test(key) || key === 'at' ? { timestampValue: value } : { stringValue: value };
  if (typeof value === 'number')
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map((v) => field(v)) } };
  if (value && typeof value === 'object')
    return { mapValue: { fields: firestoreFields(value as Record<string, unknown>) } };
  throw new ChatError(503, 'Unable to store this conversation.');
}
export function firestoreFields(value: Record<string, unknown>): Record<string, FirestoreValue> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, field(v, k)]),
  );
}
function decoded(value: FirestoreValue): unknown {
  if ('nullValue' in value) return null;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.timestampValue !== undefined) return value.timestampValue;
  if (value.integerValue !== undefined) return Number(value.integerValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.booleanValue !== undefined) return value.booleanValue;
  if (value.arrayValue) return (value.arrayValue.values || []).map(decoded);
  if (value.mapValue)
    return Object.fromEntries(
      Object.entries(value.mapValue.fields).map(([k, v]) => [k, decoded(v)]),
    );
  return null;
}
export type ChatDocument = { name: string; data: Record<string, any>; updateTime: string };
export class ChatStore {
  readonly base: string;
  readonly root: string;
  constructor(
    readonly env: ChatEnvironment,
    readonly uid: string,
    readonly authorization: string,
    readonly send: typeof fetch,
  ) {
    this.base = `${env.firestoreOrigin || 'https://firestore.googleapis.com'}/v1/projects/${env.projectId}/databases/(default)/documents`;
    this.root = `bpl_customerWorkspaces/${uid}`;
  }
  static async open(
    env: ChatEnvironment,
    uid: string,
    send: typeof fetch,
    userToken?: string,
    privileged = false,
  ) {
    if (!safeUid(uid)) throw new ChatError(401, 'Unable to verify this account.');
    if (privileged && !env.serviceAccountJson)
      throw new ChatError(
        503,
        'Live inbox sending is not activated. Open WhatsApp to continue the conversation.',
        'INBOX_NOT_ACTIVATED',
      );
    const token = env.serviceAccountJson
      ? await getServiceAccessToken(env.serviceAccountJson, send)
      : userToken;
    if (!token)
      throw new ChatError(503, 'The inbox service is not configured.', 'INBOX_NOT_ACTIVATED');
    return new ChatStore(env, uid, `Bearer ${token}`, send);
  }
  async read(path: string, absolute = false): Promise<ChatDocument | null> {
    const response = await this.send(`${this.base}/${absolute ? path : `${this.root}/${path}`}`, {
      headers: { Authorization: this.authorization },
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 404) return null;
    if (!response.ok)
      throw new ChatError(503, 'Unable to load the conversation. Please try again.');
    return this.decode(await response.json());
  }
  decode(document: {
    name: string;
    fields?: Record<string, FirestoreValue>;
    updateTime: string;
  }): ChatDocument {
    return {
      name: document.name,
      updateTime: document.updateTime,
      data: Object.fromEntries(
        Object.entries(document.fields || {}).map(([k, v]) => [k, decoded(v)]),
      ),
    };
  }
  async list(path: string, order: string, limit: number) {
    const response = await this.send(
      `${this.base}/${this.root}/${path}?pageSize=${limit}&orderBy=${encodeURIComponent(order)}`,
      { headers: { Authorization: this.authorization }, signal: AbortSignal.timeout(15000) },
    );
    if (!response.ok) throw new ChatError(503, 'Unable to load the inbox. Please try again.');
    const data = await response.json();
    return {
      docs: (data.documents || []).map((doc: any) => this.decode(doc)) as ChatDocument[],
      truncated: !!data.nextPageToken,
    };
  }
  async messagesBefore(path: string, cursor: { at: string; id: string } | null, limit: number) {
    if (!cursor) return this.list(path, 'createdAt desc', limit);
    const slash = path.lastIndexOf('/'),
      parent = path.slice(0, slash),
      collection = path.slice(slash + 1);
    const response = await this.send(`${this.base}/${this.root}/${parent}:runQuery`, {
      method: 'POST',
      headers: { Authorization: this.authorization, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: collection }],
          orderBy: [
            { field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' },
            { field: { fieldPath: '__name__' }, direction: 'DESCENDING' },
          ],
          startAt: {
            values: [
              { timestampValue: cursor.at },
              {
                referenceValue: `projects/${this.env.projectId}/databases/(default)/documents/${this.root}/${path}/${cursor.id}`,
              },
            ],
            before: false,
          },
          limit,
        },
      }),
    });
    if (!response.ok) throw new ChatError(503, 'Earlier messages could not be loaded.');
    const docs = (await response.json())
      .filter((r: any) => r.document)
      .map((r: any) => this.decode(r.document)) as ChatDocument[];
    return { docs, truncated: docs.length === limit };
  }
  write(
    path: string,
    data: Record<string, unknown>,
    existing: ChatDocument | null | undefined,
    fields?: string[],
  ) {
    return {
      update: {
        name: `projects/${this.env.projectId}/databases/(default)/documents/${this.root}/${path}`,
        fields: firestoreFields(data),
      },
      ...(fields ? { updateMask: { fieldPaths: fields } } : {}),
      ...(existing === undefined
        ? {}
        : { currentDocument: existing ? { updateTime: existing.updateTime } : { exists: false } }),
    };
  }
  remove(path: string) {
    return {
      delete: `projects/${this.env.projectId}/databases/(default)/documents/${this.root}/${path}`,
    };
  }
  async commit(writes: unknown[]) {
    const response = await this.send(`${this.base}:commit`, {
      method: 'POST',
      headers: { Authorization: this.authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ writes }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      if (
        [409, 412].includes(response.status) ||
        ['ALREADY_EXISTS', 'FAILED_PRECONDITION', 'ABORTED'].includes(result.error?.status)
      )
        throw new ChatError(
          409,
          'This conversation changed. Please refresh and try again.',
          'CONFLICT',
        );
      throw new ChatError(503, 'Unable to save the conversation. Please try again.');
    }
  }
}
export async function readChatConnection(store: ChatStore): Promise<ConnectionRecord | null> {
  const document = await store.read(`bpl_whatsappConnections/${store.uid}`, true);
  if (!document) return null;
  if (!store.env.encryptionKey)
    throw new ChatError(503, 'Secure WhatsApp connection storage is unavailable.');
  return decryptConnection(
    document.data as EncryptedConnection,
    store.uid,
    store.env.encryptionKey,
  );
}
export function conversationFrom(record: Record<string, any>, id: string): ChatConversation {
  return {
    id,
    customerId: record.customerId || id,
    phone: String(record.phone || ''),
    customerName: String(record.customerName || record.name || 'WhatsApp customer'),
    lastMessagePreview: String(record.lastMessagePreview || ''),
    lastMessageAt: record.lastMessageAt ? new Date(record.lastMessageAt).toISOString() : null,
    lastInboundAt: record.lastInboundAt ? new Date(record.lastInboundAt).toISOString() : null,
    unreadCount: Number(record.unreadCount || 0),
    lastMessageStatus: record.lastMessageStatus || null,
  };
}
export function messageFrom(record: Record<string, any>, id: string): ChatMessage {
  const attachment =
    attachmentFromRecord(record.attachment) ||
    (record.type === 'image'
      ? { kind: 'image' as const, available: record.imageAvailable === true }
      : undefined);
  return {
    id,
    ...(record.metaId ? { metaId: record.metaId } : {}),
    direction: record.direction,
    type: record.type || 'text',
    ...(attachment ? { attachment } : {}),
    ...(record.type === 'image' && record.imageAvailable === true ? { imageAvailable: true } : {}),
    text: String(record.text || ''),
    status: record.status,
    createdAt: new Date(record.createdAt).toISOString(),
    ...(record.providerAt ? { providerAt: record.providerAt } : {}),
    ...(record.error ? { error: record.error } : {}),
    ...(record.source === 'phone_history' ? { source: 'phone_history' as const } : {}),
  };
}
function callbackUrl(env: ChatEnvironment, uid: string) {
  if (!env.webhookBaseUrl) return null;
  const url = new URL(env.webhookBaseUrl);
  if (url.protocol !== 'https:') return null;
  return `${url.origin}/webhook/${encodeURIComponent(uid)}`;
}
function inboxConfiguration(
  env: ChatEnvironment,
  connection: ConnectionRecord | null,
  uid: string,
  webhookStatus: Record<string, any> | null,
) {
  const webhookUrl = callbackUrl(env, uid);
  const webhookReady =
    env.webhookPublicReady === true &&
    !!webhookUrl &&
    webhookStatus?.phoneNumberId === connection?.phoneNumberId &&
    !!(webhookStatus?.challengeAnsweredAt || webhookStatus?.lastSignedEventAt);
  const reason = !env.serviceAccountJson
    ? 'Live inbox sending is not activated. You can still open the customer in WhatsApp.'
    : webhookStatus?.disconnectedAt
      ? 'Meta disconnected this WhatsApp Business account. Open WhatsApp Integration and reconnect it.'
      : !connection?.verifiedAt
        ? 'Verify your WhatsApp Business connection to activate API conversations.'
        : !webhookUrl
          ? 'The public WhatsApp callback is not configured yet.'
          : env.webhookPublicReady !== true
            ? 'The public callback has not been activated. You can still open WhatsApp directly.'
            : !webhookReady
              ? 'Subscribe the callback URL in your Meta app to activate incoming API messages.'
              : null;
  return {
    configured: !reason,
    senderPhone: connection?.phone || null,
    senderName: connection?.verifiedName || '',
    testSender: metaTestSender(connection?.phone || '', connection?.verifiedName || ''),
    connectionVerifiedAt: connection?.verifiedAt || null,
    reason,
    webhookUrl,
    connectionVerified: !!connection?.verifiedAt,
    connectionVerifiedPreviously: !!connection?.verifiedAt,
    webhookReady,
    webhookPublicReady: env.webhookPublicReady === true,
    lastWebhookAt: webhookStatus?.lastSignedEventAt || null,
  };
}
export async function verifyUser(request: Request, env: ChatEnvironment, send: typeof fetch) {
  const authorization = request.headers.get('authorization') || '';
  const token =
    authorization.length < 16384 ? authorization.match(/^Bearer (\S+)$/)?.[1] : undefined;
  if (!token) throw new ChatError(401, 'Sign in with Google to open your inbox.');
  const response = await send(
    `${env.authOrigin || 'https://identitytoolkit.googleapis.com'}/v1/accounts:lookup?key=${encodeURIComponent(env.apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
      signal: AbortSignal.timeout(15000),
    },
  );
  const user = (await response.json()).users?.[0];
  if (!response.ok || !user || user.disabled || !safeUid(user.localId))
    throw new ChatError(401, 'Your sign-in expired. Please sign in again.');
  if (!user.emailVerified)
    throw new ChatError(403, 'Use a verified Google account to open the inbox.');
  return {
    uid: user.localId as string,
    token,
    email: String(user.email || '').toLowerCase(),
    name: String(user.displayName || user.email || 'Team member').slice(0, 120),
  };
}
export async function readChatBody(
  request: Request,
  maximum: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(request.headers.get('content-length')) > maximum)
    throw new ChatError(413, 'The message payload is too large.');
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new ChatError(413, 'The message payload is too large.');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return all;
}
const sendInput = z
  .object({ text: z.string().trim().min(1).max(4096), requestId: z.string().uuid() })
  .strict();

export async function handleAccountChat(
  request: Request,
  env: ChatEnvironment,
  send: typeof fetch = fetch,
): Promise<Response> {
  let releaseUpload: (() => void) | undefined;
  try {
    if (!['GET', 'POST'].includes(request.method))
      return chatJson({ error: 'Method not allowed' }, 405);
    if (request.method === 'POST' && !allowedRequestOrigin(request, env.appOrigin))
      throw new ChatError(403, 'Request origin is not allowed');
    const identity = await verifyUser(request, env, send);
    const { store, role, canWrite } = await inboxAccess(request, env, send, identity);
    const uid = store.uid;
    if (request.method === 'POST' && !canWrite)
      throw new ChatError(403, 'This team role has read-only access.');
    const binding = env.serviceAccountJson ? await providerDocument(store) : null;
    const personal = binding?.data.mode === 'personal';
    const path = new URL(request.url).pathname.replace(/\/$/, '');
    const mediaMatch = path.match(
      /^\/api\/account\/inbox\/([a-f0-9]{32})\/messages\/(personal-[a-f0-9]{64})\/(attachment|image)$/,
    );
    if (request.method === 'GET' && mediaMatch) {
      if (!personal) throw new ChatError(404, 'Attachment unavailable.');
      const [, chatId, messageId, variant] = mediaMatch;
      const lookUp = async (path: string, slot: string) => {
        const saved = await store.read(path);
        if (!saved) return;
        try {
          return JSON.parse(openPersonal(saved.data, uid, slot, env.encryptionKey));
        } catch {
          // Cross-chat or stale records must never be decrypted for a different conversation.
        }
      };
      let media: PersonalMedia | undefined = await lookUp(
        `personalMessageMedia/${messageId}`,
        `media:${chatId}:${messageId}`,
      );
      if (!media)
        media = oldPersonalImage(
          await lookUp(`personalMessageImages/${messageId}`, `image:${chatId}:${messageId}`),
        );
      const load = (candidate?: PersonalMedia) =>
        candidate && (variant === 'attachment' || candidate.kind === 'image')
          ? personalMediaBytes(candidate, send, request.signal)
          : undefined;
      let result = await load(media);
      if (!result) {
        const history = await readPersonalHistory(store, chatId);
        const historical = history.messages.find((m) => m.id === messageId);
        const archived = historical?.personalMedia || oldPersonalImage(historical?.personalImage);
        if (archived && JSON.stringify(archived) !== JSON.stringify(media)) {
          result = await load(archived);
          if (result) media = archived;
        }
      }
      if (!result) throw new ChatError(404, 'Attachment unavailable.');
      return new Response(new Uint8Array(result.bytes), {
        headers: {
          'Content-Type': result.mime,
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
          'Cross-Origin-Resource-Policy': 'same-origin',
          ...(media?.kind === 'document' ? { 'Content-Disposition': 'attachment' } : {}),
          ...(result.preview ? { 'X-Media-Preview': 'true' } : {}),
        },
      });
    }
    const personalState = personal ? await personalStatus(store) : null;
    const connection = personal ? null : await readChatConnection(store);
    const webhookStatus =
      env.serviceAccountJson && !personal ? await store.read('inboxStatus/webhook') : null;
    const configuration = personal
      ? {
          provider: 'personal' as const,
          configured: personalState?.status === 'connected',
          senderPhone: personalState?.phone || binding?.data.phone || null,
          senderName: 'Linked WhatsApp',
          testSender: false,
          connectionVerifiedAt: binding?.data.connectedAt || null,
          reason:
            personalState?.status === 'connected'
              ? null
              : personalState?.message || 'Reconnect linked WhatsApp.',
          webhookUrl: null,
          connectionVerified: personalState?.status === 'connected',
          connectionVerifiedPreviously: !!binding?.data.locked,
          webhookReady: false,
          webhookPublicReady: false,
          lastWebhookAt: null,
        }
      : {
          provider: 'meta' as const,
          ...inboxConfiguration(env, connection, uid, webhookStatus?.data || null),
        };
    if (path === '/api/account/inbox/sync' && request.method === 'POST') {
      if (!personal)
        throw new ChatError(409, 'Phone chat sync is available for linked WhatsApp accounts.');
      if (role !== 'owner')
        throw new ChatError(403, 'Only the workspace owner can request phone history.');
      return chatJson({ history: await requestPersonalHistory(store) });
    }
    if (path === '/api/account/inbox/contacts' && request.method === 'GET') {
      if (!personal) throw new ChatError(409, 'Phone contacts are available for linked WhatsApp.');
      const listed = await store.list('personalContacts', 'name asc', 1000);
      return chatJson({
        contacts: listed.docs.map((d) => ({
          id: d.name.split('/').pop(),
          name: String(d.data.name || d.data.phone),
          phone: String(d.data.phone || ''),
        })),
        truncated: listed.truncated,
      });
    }
    if (path === '/api/account/inbox/start' && request.method === 'POST') {
      if (!personal)
        throw new ChatError(
          409,
          'Use an approved template or an existing conversation for the Meta Business API.',
        );
      const parsed = z
        .object({
          phone: z.string().trim().min(8).max(32),
          name: z.string().trim().max(120).optional(),
        })
        .strict()
        .safeParse(JSON.parse(new TextDecoder().decode(await readChatBody(request, 4096))));
      if (!parsed.success)
        throw new ChatError(400, 'Enter a WhatsApp phone number with its country code.');
      let phone = '';
      try {
        phone = normalizePhone(parsed.data.phone);
      } catch {
        throw new ChatError(400, 'Enter a valid WhatsApp number with its country code.');
      }
      const id = (await chatHash(phone)).slice(0, 32),
        old = await store.read(`conversations/${id}`);
      if (!old) {
        const [contact, customer] = await Promise.all([
          store.read(`personalContacts/${id}`),
          store.read(`customers/${id}`),
        ]);
        const conversation = {
          ...conversationFrom(
            {
              phone,
              customerId: id,
              customerName:
                customer?.data.name || contact?.data.name || parsed.data.name || `+${phone}`,
            },
            id,
          ),
          ownerId: uid,
          provider: 'personal',
        };
        try {
          await store.commit([
            store.write(`conversations/${id}`, conversation, null),
            store.write(
              'inboxStatus/personalRevision',
              { at: new Date().toISOString() },
              undefined,
            ),
          ]);
        } catch (e) {
          if (!(e instanceof ChatError && e.status === 409)) throw e;
        }
      }
      return chatJson(
        { conversation: conversationFrom((await store.read(`conversations/${id}`))!.data, id) },
        201,
      );
    }
    if (path === '/api/account/inbox' && request.method === 'GET') {
      const revisionDoc = personal ? await store.read('inboxStatus/personalRevision') : null;
      const revision = personal ? revisionDoc?.updateTime || 'empty' : undefined;
      const history = personal ? await personalHistoryStatus(store) : undefined;
      if (personal && new URL(request.url).searchParams.get('revision') === revision)
        return chatJson({
          ...configuration,
          revision,
          history,
          unchanged: true,
          workspaceId: uid,
          role,
          canWrite,
        });
      const listed = await store.list('conversations', 'lastMessageAt desc', 500);
      const metadata = env.serviceAccountJson
        ? await store.list('conversationMeta', 'updatedAt desc', 500)
        : null;
      const result: ChatInboxResponse = {
        ...configuration,
        ...(personal ? { history, revision } : {}),
        workspaceId: uid,
        role,
        canWrite,
        metadata: Object.fromEntries(
          (metadata?.docs || []).map((d) => [d.name.split('/').pop(), conversationMeta(d.data)]),
        ),
        conversations: listed.docs.map((doc) => ({
          ...conversationFrom(doc.data, doc.name.split('/').pop()!),
          ...conversationMeta(
            metadata?.docs.find((m) => m.name.split('/').pop() === doc.name.split('/').pop())?.data,
          ),
        })),
        truncated: listed.truncated,
      };
      return chatJson(result);
    }
    if (path === '/api/account/inbox/setup' && request.method === 'POST')
      return chatJson(configuration);
    const match = path.match(
      /^\/api\/account\/inbox\/([a-f0-9]{32})(?:\/(send|read|send-attachment))?$/,
    );
    if (!match) throw new ChatError(404, 'Inbox route not found');
    const id = match[1];
    const [existing, customer] = await Promise.all([
      store.read(`conversations/${id}`),
      store.read(`customers/${id}`),
    ]);
    if (!existing && !customer) throw new ChatError(404, 'This customer is not in your inbox.');
    const conversation = conversationFrom(
      existing?.data || { ...customer!.data, customerId: id, customerName: customer!.data.name },
      id,
    );
    if (request.method === 'GET' && !match[2]) {
      const revision = existing?.updateTime || 'empty';
      if (
        personal &&
        !new URL(request.url).searchParams.has('before') &&
        new URL(request.url).searchParams.get('revision') === revision
      )
        return chatJson({
          ...configuration,
          workspaceId: uid,
          role,
          canWrite,
          revision,
          unchanged: true,
          windowOpen: true,
        });
      let cursor: { at: string; id: string } | null = null;
      const before = new URL(request.url).searchParams.get('before');
      if (before) {
        if (!personal || before.length > 512) throw new ChatError(400, 'Invalid message cursor.');
        try {
          const parsed = z
            .object({ at: z.string().datetime(), id: z.string().regex(/^[A-Za-z0-9_-]{1,150}$/) })
            .strict()
            .parse(JSON.parse(Buffer.from(before, 'base64url').toString()));
          cursor = parsed;
        } catch {
          throw new ChatError(400, 'Invalid message cursor.');
        }
      }
      const listed = personal
        ? await store.messagesBefore(`conversations/${id}/messages`, cursor, 101)
        : await store.list(`conversations/${id}/messages`, 'createdAt desc', 100);
      const history = personal
        ? await readPersonalHistory(store, id)
        : { messages: [], clipped: false };
      const merged = new Map<string, ChatMessage>(
        history.messages.map(({ personalId: _personalId, personalImage, personalMedia, ...m }) => {
          const legacyPhoto = m.type === 'unsupported' && m.text === '[Image]';
          const metadata =
            attachmentFromRecord(m.attachment) ||
            (m.type === 'image' || legacyPhoto
              ? { kind: 'image' as const, available: false }
              : undefined);
          const attachment = metadata && {
            ...metadata,
            available: !!(personalMedia || personalImage),
          };
          return [
            m.id,
            {
              ...m,
              ...(legacyPhoto ? { type: 'image' as const, text: '' } : {}),
              ...(attachment ? { attachment } : {}),
              ...(m.type === 'image' && attachment?.available ? { imageAvailable: true } : {}),
            },
          ];
        }),
      );
      for (const doc of listed.docs) {
        const m = messageFrom(doc.data, doc.name.split('/').pop()!);
        const old = merged.get(m.id);
        const rich =
          old?.attachment &&
          (!m.attachment || (!m.attachment.available && old.attachment.available))
            ? old
            : m;
        merged.set(m.id, {
          ...m,
          type: rich.type,
          text: rich.text,
          ...(rich.attachment ? { attachment: rich.attachment } : {}),
          ...(old?.imageAvailable || m.imageAvailable ? { imageAvailable: true } : {}),
          status: old ? nextChatStatus(old.status, m.status) : m.status,
        });
      }
      const sorted = [...merged.values()]
        .filter(
          (m) =>
            !cursor || m.createdAt < cursor.at || (m.createdAt === cursor.at && m.id < cursor.id),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      const visible = sorted.slice(0, 100),
        last = visible.at(-1),
        more = sorted.length > 100 || listed.truncated;
      const nextBefore =
        personal && last && more
          ? Buffer.from(JSON.stringify({ at: last.createdAt, id: last.id })).toString('base64url')
          : null;
      const matchingSender = existing?.data.phoneNumberId === connection?.phoneNumberId;
      const windowOpen = personal || (matchingSender && chatWindowOpen(conversation.lastInboundAt));
      const result: ChatDetailResponse = {
        ...configuration,
        workspaceId: uid,
        role,
        canWrite,
        conversation,
        messages: visible.reverse(),
        ...(personal ? { nextBefore, historyClipped: history.clipped, revision } : {}),
        recorded: visible.length > 0,
        windowOpen,
        replyBlock: replyBlockFor({
          configured: configuration.configured,
          windowOpen,
          hasInbound: matchingSender && !!conversation.lastInboundAt,
          reason: configuration.reason,
          senderPhone: configuration.senderPhone,
        }),
        truncated: listed.truncated,
      };
      return chatJson(result);
    }
    if (request.method !== 'POST') return chatJson({ error: 'Method not allowed' }, 405);
    if (match[2] === 'read') {
      if (existing && env.serviceAccountJson)
        await store.commit([
          store.write(`conversations/${id}`, { unreadCount: 0 }, existing, ['unreadCount']),
          ...(personal
            ? [
                store.write(
                  'inboxStatus/personalRevision',
                  { at: new Date().toISOString() },
                  undefined,
                ),
              ]
            : []),
        ]);
      return chatJson({ success: true });
    }
    const sendingAttachment = match[2] === 'send-attachment';
    if (!sendingAttachment && match[2] !== 'send')
      throw new ChatError(404, 'Inbox route not found');
    if (sendingAttachment && !personal)
      throw new ChatError(
        409,
        'Attachments can only be sent from linked WhatsApp in this inbox.',
        'ATTACHMENT_PROVIDER_UNSUPPORTED',
      );
    if (!configuration.configured)
      throw new ChatError(503, configuration.reason!, 'INBOX_NOT_ACTIVATED');
    if (
      !personal &&
      (existing?.data.phoneNumberId !== connection?.phoneNumberId ||
        !chatWindowOpen(conversation.lastInboundAt))
    )
      throw new ChatError(
        409,
        'A customer reply is required to open the 24-hour API reply window. Open WhatsApp or use an approved template outside that window.',
        'WHATSAPP_WINDOW_CLOSED',
      );
    if (sendingAttachment) releaseUpload = reserveAttachmentUpload();
    const upload = sendingAttachment ? await parseAttachmentUpload(request) : undefined;
    const parsed = upload
      ? { success: true as const, data: { text: upload.caption, requestId: upload.requestId } }
      : sendInput.safeParse(
          JSON.parse(new TextDecoder().decode(await readChatBody(request, 16384))),
        );
    if (!parsed.success)
      throw new ChatError(
        400,
        'Enter a message of up to 4,096 characters and a unique request ID.',
      );
    const { text, requestId } = parsed.data;
    const attachment = upload
      ? { kind: upload.kind, mime: upload.mime, name: upload.name, available: false }
      : undefined;
    const messageType = attachment
      ? attachment.kind === 'image'
        ? 'image'
        : 'attachment'
      : 'text';
    const attachmentFingerprint = upload?.fingerprint;
    const requestPath = `sendRequests/${requestId}`;
    const previous = await store.read(requestPath);
    if (previous) {
      if (
        previous.data.customerId !== id ||
        previous.data.text !== text ||
        (previous.data.attachmentFingerprint || undefined) !== attachmentFingerprint
      )
        throw new ChatError(
          409,
          'This request ID belongs to a different message.',
          'REQUEST_ID_REUSED',
        );
      const priorMessage = await store.read(
        `conversations/${id}/messages/${previous.data.messageId}`,
      );
      if (priorMessage && previous.data.state === 'accepted')
        return chatJson({ message: messageFrom(priorMessage.data, previous.data.messageId) });
      throw new ChatError(
        409,
        'This message was already submitted. Review its recorded status before sending again.',
        'MESSAGE_ALREADY_SUBMITTED',
      );
    }
    const createdAt = new Date().toISOString();
    const provisionalId = `request-${requestId}`;
    const provisional: ChatMessage = {
      id: provisionalId,
      direction: 'outbound',
      type: messageType,
      ...(attachment ? { attachment } : {}),
      text,
      status: 'submitting',
      createdAt,
    };
    await store.commit([
      store.write(
        requestPath,
        {
          ownerId: uid,
          customerId: id,
          text,
          ...(attachmentFingerprint ? { attachmentFingerprint } : {}),
          state: 'submitting',
          messageId: provisionalId,
          createdAt,
        },
        null,
      ),
      store.write(
        `conversations/${id}/messages/${provisionalId}`,
        { ...provisional, ownerId: uid },
        null,
      ),
    ]);
    let metaId = '';
    let safeError = '';
    let invalidToken = false;
    let uncertain = false;
    try {
      if (personal) {
        metaId = await sendPersonal(
          store,
          conversation.phone,
          text,
          `BPL${requestId.replaceAll('-', '').toUpperCase()}`,
          upload,
        );
      } else {
        const version = env.graphVersion || 'v23.0';
        if (!/^v\d+\.\d+$/.test(version)) throw new Error();
        const key = await crypto.subtle.importKey(
          'raw',
          encode(connection!.appSecret),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign'],
        );
        const proof = Array.from(
          new Uint8Array(await crypto.subtle.sign('HMAC', key, encode(connection!.accessToken))),
          (byte) => byte.toString(16).padStart(2, '0'),
        ).join('');
        const url = new URL(
          `https://graph.facebook.com/${version}/${connection!.phoneNumberId}/messages`,
        );
        url.searchParams.set('appsecret_proof', proof);
        const response = await send(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${connection!.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: conversation.phone,
            type: 'text',
            text: { preview_url: false, body: text },
          }),
          signal: AbortSignal.timeout(20000),
        });
        const result = await response.json();
        if (!response.ok) {
          invalidToken = [190, 102, 104].includes(Number(result.error?.code));
          uncertain = response.status >= 500;
          safeError = metaReplyError(Number(result.error?.code), uncertain);
        } else if (typeof result.messages?.[0]?.id === 'string') metaId = result.messages[0].id;
        else {
          uncertain = true;
          safeError =
            'Meta did not return a message ID. Acceptance is uncertain; do not automatically resend.';
        }
      }
    } catch {
      uncertain = true;
      safeError = 'The API did not confirm acceptance. Check this message before sending again.';
    }
    if (!metaId) {
      const state = uncertain ? 'unknown' : 'failed';
      const requestDoc = await store.read(requestPath);
      const messageDoc = await store.read(`conversations/${id}/messages/${provisionalId}`);
      await store.commit([
        store.write(requestPath, { state }, requestDoc, ['state']),
        store.write(
          `conversations/${id}/messages/${provisionalId}`,
          { status: state, error: safeError },
          messageDoc,
          ['status', 'error'],
        ),
      ]);
      throw new ChatError(
        invalidToken ? 409 : uncertain ? 503 : 400,
        safeError,
        invalidToken
          ? 'META_ACCESS_TOKEN_INVALID'
          : uncertain
            ? 'SEND_INDETERMINATE'
            : 'SEND_REJECTED',
      );
    }
    const messageId = personal
      ? await personalMessageId(conversation.phone, metaId)
      : `meta-${await chatHash(metaId)}`;
    let accepted: ChatMessage | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const [observed, latestConversation, requestDoc] = await Promise.all([
        store.read(`conversations/${id}/messages/${messageId}`),
        store.read(`conversations/${id}`),
        store.read(requestPath),
      ]);
      accepted = {
        id: messageId,
        direction: 'outbound',
        type: messageType,
        ...(attachment
          ? {
              attachment: observed
                ? messageFrom(observed.data, messageId).attachment || attachment
                : attachment,
            }
          : {}),
        ...(attachment?.kind === 'image' && observed?.data.imageAvailable === true
          ? { imageAvailable: true }
          : {}),
        text,
        status: observed ? nextChatStatus('accepted', observed.data.status) : 'accepted',
        metaId,
        createdAt,
        ...(observed?.data.providerAt ? { providerAt: observed.data.providerAt } : {}),
        ...(observed?.data.status === 'failed' && observed.data.error
          ? { error: observed.data.error }
          : {}),
      };
      const current = latestConversation
        ? conversationFrom(latestConversation.data, id)
        : conversation;
      const isLatest =
        !current.lastMessageAt || Date.parse(current.lastMessageAt) <= Date.parse(createdAt);
      const summary = {
        ownerId: uid,
        ...current,
        ...(personal ? { provider: 'personal' } : { phoneNumberId: connection!.phoneNumberId }),
        ...(isLatest
          ? {
              lastMessagePreview: (
                text ||
                (attachment ? (attachment.kind === 'image' ? 'Photo' : attachment.name) : '')
              ).slice(0, 240),
              lastMessageAt: createdAt,
              lastMessageStatus: accepted.status,
            }
          : {}),
      };
      try {
        await store.commit([
          store.write(
            `conversations/${id}/messages/${messageId}`,
            { ...accepted, ownerId: uid },
            observed,
          ),
          store.write(`conversations/${id}`, summary, latestConversation),
          ...(personal
            ? [
                store.write(
                  'inboxStatus/personalRevision',
                  { at: new Date().toISOString() },
                  undefined,
                ),
              ]
            : []),
          store.write(requestPath, { state: 'accepted', messageId, metaId }, requestDoc, [
            'state',
            'messageId',
            'metaId',
          ]),
          store.remove(`conversations/${id}/messages/${provisionalId}`),
        ]);
        return chatJson({ message: accepted }, 201);
      } catch (e) {
        if (!(e instanceof ChatError && e.code === 'CONFLICT') || attempt === 3)
          throw new ChatError(
            503,
            'WhatsApp accepted the message, but its receipt could not be saved. Check the inbox before sending again.',
            'SEND_INDETERMINATE',
          );
      }
    }
    throw new ChatError(
      503,
      'The message result is uncertain. Please check the inbox.',
      'SEND_INDETERMINATE',
    );
  } catch (error) {
    if (error instanceof ChatError)
      return chatJson(
        { error: error.message, ...(error.code ? { code: error.code } : {}) },
        error.status,
      );
    if (error instanceof SyntaxError)
      return chatJson({ error: 'Enter valid message details.' }, 400);
    return chatJson({ error: 'The inbox could not complete this request. Please try again.' }, 503);
  } finally {
    releaseUpload?.();
  }
}
