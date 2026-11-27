import {
  historyStatusPath,
  ingestPersonalHistory,
  personalHistoryStatus,
  savePersonalContact,
  historyContactPhone,
} from './personal-history';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import QRCode from 'qrcode';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ChatError, ChatStore } from './account-chat-api';
import { getServiceAccessToken } from './google-service-account';
import { PersonalAuthStore } from './personal-auth';
import { lockProvider, providerDocument, reserveProvider } from './whatsapp-provider';
import { describePersonalAttachment } from './personal-image';
import { personalPhone, recordPersonalMessage, recordPersonalReceipt } from './personal-events';
import type { ChatEnvironment } from './chat-types';
import type { WASocket } from '@whiskeysockets/baileys';
import { whatsappAttachmentContent, type UploadAttachment } from './personal-attachment-send';
export type PersonalStatus = {
  status:
    | 'idle'
    | 'connecting'
    | 'qr'
    | 'pairing'
    | 'connected'
    | 'reconnecting'
    | 'relink_required'
    | 'offline';
  phone: string | null;
  qr: string | null;
  pairingCode: string | null;
  message: string;
};
type Session = {
  store: ChatStore;
  socket?: WASocket;
  state: PersonalStatus;
  stopped: boolean;
  registered: boolean;
  auth: PersonalAuthStore;
  creds: any;
  queue: Promise<void>;
  authQueue: Promise<void>;
  historyQueue: Promise<void>;
  linkedSince: number;
  wasRegistered: boolean;
  renewing?: boolean;
  heartbeat?: NodeJS.Timeout;
  expiry?: NodeJS.Timeout;
  retry?: NodeJS.Timeout;
  failures: number;
  leaseId: string;
  pairingPhone?: string;
  pairingRequested: boolean;
};
type Runtime = {
  sessions: Map<string, Session>;
  starts: Map<string, Promise<Session>>;
  instance: string;
  closing: boolean;
};
const globalRuntime = globalThis as typeof globalThis & { bplPersonalRuntime?: Runtime };
const runtime = (globalRuntime.bplPersonalRuntime ||= {
  sessions: new Map(),
  starts: new Map(),
  instance: randomUUID(),
  closing: false,
});
const statusPath = 'personalStatus/current',
  leasePath = 'personalStatus/lease';
const now = () => new Date().toISOString();
const logger = pino({ level: 'silent' }); // Never log pairing secrets, Signal keys or message bodies.
export function personalServiceStore(
  env: ChatEnvironment,
  uid: string,
  send: typeof fetch = fetch,
) {
  if (!env.serviceAccountJson || !/^[a-f0-9]{64}$/i.test(env.encryptionKey))
    throw new ChatError(503, 'Secure linked WhatsApp storage is unavailable.');
  const authenticated: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set(
      'Authorization',
      `Bearer ${await getServiceAccessToken(env.serviceAccountJson!, send)}`,
    );
    return send(input, { ...init, headers });
  };
  return new ChatStore(env, uid, '', authenticated);
}
function enqueue(session: Session, fn: () => Promise<void>) {
  session.queue = session.queue.then(fn).catch(async () => {
    session.state = {
      ...session.state,
      status: 'offline',
      qr: null,
      pairingCode: null,
      message: 'The linked session could not be saved. Reconnect before sending.',
    };
    stop(session);
  });
}
function enqueueAuth(session: Session, fn: () => Promise<void>) {
  session.authQueue = session.authQueue.then(fn).catch(() => {
    session.state = {
      ...session.state,
      status: 'offline',
      qr: null,
      pairingCode: null,
      message: 'Secure session storage is unavailable. Reconnect before sending.',
    };
    stop(session);
  });
}
function enqueueHistory(session: Session, fn: () => Promise<void>) {
  session.historyQueue = session.historyQueue
    .then(async () => {
      if (!session.stopped) await fn();
    })
    .catch(async () => {
      if (session.stopped) return;
      try {
        await assertLease(session);
        await session.store.commit([
          session.store.write(
            historyStatusPath,
            {
              phase: 'error',
              message:
                'Some phone history could not be saved. Your live chat connection remains available; retry Sync chats.',
              updatedAt: now(),
            },
            undefined,
            ['phase', 'message', 'updatedAt'],
          ),
        ]);
      } catch {
        /* The current socket will report any separate connection/storage failure. */
      }
    });
}
async function assertLease(session: Session) {
  const lease = await session.store.read(leasePath);
  if (lease?.data.holder !== session.leaseId || Date.parse(lease.data.expiresAt) <= Date.now())
    throw new ChatError(
      409,
      'The WhatsApp session is active on another server. Try again shortly.',
    );
  return lease;
}
async function persistStatus(session: Session) {
  await assertLease(session);
  await session.store.commit([
    session.store.write(
      statusPath,
      {
        status: session.state.status,
        phone: session.state.phone,
        message: session.state.message,
        updatedAt: now(),
      },
      undefined,
    ),
  ]);
}
function stop(session: Session) {
  session.stopped = true;
  clearInterval(session.heartbeat);
  clearTimeout(session.expiry);
  clearTimeout(session.retry);
  session.socket?.end(undefined);
  session.socket = undefined;
  if (runtime.sessions.get(session.store.uid) === session)
    runtime.sessions.delete(session.store.uid);
}
async function closeSession(session: Session) {
  stop(session);
  try {
    const lease = await session.store.read(leasePath);
    if (lease?.data.holder === session.leaseId)
      await session.store.commit([
        session.store.write(leasePath, { ...lease.data, expiresAt: now() }, lease),
      ]);
  } catch {
    /* Expiring lease recovers after an abrupt process exit. */
  }
}
async function connectSocket(session: Session) {
  const b = await import('@whiskeysockets/baileys');
  if (session.stopped || runtime.closing) return;
  const auth = session.auth;
  const socket = b.default({
    auth: {
      creds: session.creds,
      keys: {
        get: async (type, ids) => {
          await session.authQueue;
          const values: Record<string, any> = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await auth.read(`key:${type}:${id}`);
              if (value && type === 'app-state-sync-key')
                value = b.proto.Message.AppStateSyncKeyData.fromObject(value);
              if (value) values[id] = value;
            }),
          );
          return values;
        },
        set: async (data) => {
          const values: Record<string, unknown> = {};
          for (const [type, keys] of Object.entries(data))
            for (const [id, value] of Object.entries(keys || {}))
              values[`key:${type}:${id}`] = value;
          enqueueAuth(session, async () => {
            await assertLease(session);
            await auth.write(values);
          });
          await session.authQueue;
          if (session.stopped) throw new Error('Session storage unavailable');
        },
      },
    },
    logger,
    browser: b.Browsers.ubuntu('Desktop'),
    ...(process.env.HTTPS_PROXY ? { agent: new HttpsProxyAgent(process.env.HTTPS_PROXY) } : {}),
    markOnlineOnConnect: false,
    syncFullHistory: true,
    shouldSyncHistoryMessage: (notification) =>
      !notification.fileLength || Number(notification.fileLength) <= 8 * 1024 * 1024,
    getMessage: async () => undefined,
    connectTimeoutMs: 30000,
    defaultQueryTimeoutMs: 20000,
  });
  session.socket = socket;
  socket.ev.on('creds.update', (update) => {
    Object.assign(session.creds, update);
    enqueueAuth(session, async () => {
      await assertLease(session);
      await auth.write({ creds: session.creds });
    });
  });
  socket.ev.on('connection.update', (update) => {
    enqueue(session, async () => {
      if (session.stopped || session.socket !== socket) return;
      if (update.qr) {
        session.state.qr = await QRCode.toDataURL(update.qr, {
          width: 360,
          margin: 4,
        });
        session.state.status = 'qr';
        session.state.message = 'On your phone open WhatsApp → Linked devices → Link a device.';
        if (session.pairingPhone && !session.pairingRequested && !session.creds.registered) {
          session.pairingRequested = true;
          session.state.pairingCode = await socket.requestPairingCode(session.pairingPhone);
          session.state.status = 'pairing';
          session.state.qr = null;
          session.state.message =
            'Open Linked devices → Link with phone number and enter this code on your phone.';
        }
      }
      if (update.connection === 'open') {
        const phone = personalPhone(session.creds.me?.id) || personalPhone(socket.user?.id);
        if (!phone) throw new Error('Unable to verify linked phone');
        const binding = await providerDocument(session.store);
        if (binding?.data.locked && binding.data.phone && binding.data.phone !== `+${phone}`) {
          await socket.logout();
          throw new Error('Different number cannot replace this account');
        }
        await lockProvider(session.store, 'personal', `+${phone}`);
        session.registered = true;
        session.failures = 0;
        clearTimeout(session.expiry);
        session.state = {
          status: 'connected',
          phone: `+${phone}`,
          qr: null,
          pairingCode: null,
          message: 'Your WhatsApp is connected. This Google account keeps this connection method.',
        };
      }
      if (update.connection === 'close') {
        const code = (update.lastDisconnect?.error as any)?.output?.statusCode;
        session.state.qr = null;
        session.state.pairingCode = null;
        const terminal = [401, 403, 411, 440, 500].includes(code);
        if (terminal || ++session.failures > 6) {
          session.state.status = terminal ? 'relink_required' : 'offline';
          session.state.message = terminal
            ? 'WhatsApp ended this linked session. Re-link the same number to continue.'
            : 'WhatsApp is unavailable. Use Reconnect to try again.';
          await persistStatus(session);
          await closeSession(session);
          return;
        }
        session.state.status = 'reconnecting';
        session.state.message = 'Reconnecting your saved WhatsApp session…';
        session.retry = setTimeout(
          () => {
            void session.queue
              .then(() => connectSocket(session))
              .catch(() => closeSession(session));
          },
          code === 515 ? 500 : Math.min(30000, 1500 * 2 ** session.failures),
        );
        session.retry.unref();
      }
      await persistStatus(session);
      if (update.connection === 'open' && session.wasRegistered) {
        const saved = await session.store.read(historyStatusPath);
        if (
          !saved?.data.lastSyncedAt &&
          (!saved?.data.requestedAt || Date.parse(saved.data.requestedAt) < Date.now() - 600000)
        )
          void requestPersonalHistory(session.store).catch(() => {});
      }
    });
  });
  async function phoneFor(key: { remoteJid?: string | null; remoteJidAlt?: string | null }) {
    const direct = personalPhone(key.remoteJid) || personalPhone(key.remoteJidAlt);
    if (direct) return direct;
    if (key.remoteJid?.endsWith('@lid'))
      return personalPhone(await socket.signalRepository.lidMapping.getPNForLID(key.remoteJid));
    return null;
  }
  socket.ev.on('messaging-history.set', (batch) =>
    enqueueHistory(session, async () => {
      await assertLease(session);
      await session.store.commit([
        session.store.write(
          historyStatusPath,
          {
            phase: 'syncing',
            message: 'Receiving available chats from your phone…',
            progress:
              typeof batch.progress === 'number'
                ? Math.max(0, Math.min(100, batch.progress))
                : null,
            updatedAt: now(),
          },
          undefined,
          ['phase', 'message', 'progress', 'updatedAt'],
        ),
      ]);
      const counts = await ingestPersonalHistory(
        session.store,
        batch,
        phoneFor,
        b.normalizeMessageContent,
        async (counts) => {
          if (session.stopped) throw new Error('Session closed');
          await assertLease(session);
          await session.store.commit([
            session.store.write(historyStatusPath, { ...counts, updatedAt: now() }, undefined, [
              'chats',
              'messages',
              'updatedAt',
            ]),
          ]);
        },
      );
      await session.store.commit([
        session.store.write(
          historyStatusPath,
          {
            phase: batch.progress === 100 ? 'ready' : 'syncing',
            message:
              batch.progress === 100
                ? 'Available phone chat history received.'
                : 'Phone chat history is arriving. You can open received chats now.',
            progress:
              typeof batch.progress === 'number'
                ? Math.max(0, Math.min(100, batch.progress))
                : null,
            ...counts,
            lastSyncedAt: now(),
            updatedAt: now(),
          },
          undefined,
          ['phase', 'message', 'progress', 'chats', 'messages', 'lastSyncedAt', 'updatedAt'],
        ),
      ]);
    }),
  );
  socket.ev.on('messaging-history.status', (event) => {
    if (event.status !== 'complete' || !event.explicit || event.syncType === 0) return;
    enqueueHistory(session, async () => {
      await assertLease(session);
      const previous = await session.store.read(historyStatusPath);
      if (!previous?.data.lastSyncedAt) return;
      await session.store.commit([
        session.store.write(
          historyStatusPath,
          {
            phase: 'ready',
            progress: 100,
            message: 'Available phone chat history received.',
            updatedAt: now(),
          },
          undefined,
          ['phase', 'progress', 'message', 'updatedAt'],
        ),
      ]);
    });
  });
  const updateContacts = (
    contacts: {
      id?: string;
      phoneNumber?: string;
      name?: string;
      notify?: string;
      verifiedName?: string;
    }[],
  ) =>
    enqueueHistory(session, async () => {
      await assertLease(session);
      for (const contact of contacts.slice(0, 2000)) {
        const phone =
          historyContactPhone(contact) ||
          (await phoneFor({ remoteJid: contact.id, remoteJidAlt: contact.phoneNumber }));
        const name = contact.name || contact.notify || contact.verifiedName;
        if (phone && name) await savePersonalContact(session.store, phone, name);
      }
    });
  socket.ev.on('contacts.upsert', updateContacts);
  socket.ev.on('contacts.update', updateContacts);
  socket.ev.on('messages.upsert', (event) => {
    enqueue(session, async () => {
      await assertLease(session);
      for (const message of event.messages) {
        const ownPhone = personalPhone(session.creds.me?.id);
        const fromOwnPhone =
          message.key.fromMe === true || (!!ownPhone && (await phoneFor(message.key)) === ownPhone);
        const response = fromOwnPhone
          ? message.message?.protocolMessage?.peerDataOperationRequestResponseMessage
          : undefined;
        for (const result of response?.peerDataOperationResult || []) {
          const info = result.fullHistorySyncOnDemandRequestResponse;
          if (!info || !info.requestMetadata?.requestId) continue;
          const pending = await session.store.read(historyStatusPath);
          if (pending?.data.requestId !== info.requestMetadata.requestId) continue;
          if (info.responseCode !== 0)
            await session.store.commit([
              session.store.write(
                historyStatusPath,
                {
                  phase: 'needs_relink',
                  message:
                    'Your phone could not share history through this request. Re-link this device to import available chats.',
                  updatedAt: now(),
                },
                undefined,
                ['phase', 'message', 'updatedAt'],
              ),
            ]);
        }
        const phone = await phoneFor(message.key);
        if (!phone || !message.key.id || !message.message) continue;
        const content = b.normalizeMessageContent(message.message);
        if (
          !content ||
          content.protocolMessage ||
          content.reactionMessage ||
          content.senderKeyDistributionMessage
        )
          continue;
        const captured = describePersonalAttachment(message);
        const text = captured
          ? captured.caption
          : content.imageMessage ||
              content.videoMessage ||
              content.ptvMessage ||
              content.audioMessage ||
              content.documentMessage ||
              content.stickerMessage
            ? '[Private attachment — open in WhatsApp]'
            : content.conversation || content.extendedTextMessage?.text || '[WhatsApp attachment]';
        const seconds = Number(message.messageTimestamp || 0),
          at =
            seconds > 0 && seconds * 1000 <= Date.now() + 60000
              ? new Date(seconds * 1000).toISOString()
              : now();
        if (event.type === 'append' && seconds * 1000 < session.linkedSince - 1000) continue;
        await recordPersonalMessage(session.store, {
          phone,
          providerId: message.key.id,
          text,
          outbound: !!message.key.fromMe,
          name: message.pushName || undefined,
          at,
          status: message.key.fromMe ? 'sent' : 'received',
          attachment: captured?.attachment,
          media: captured?.media,
          allowOptOut: seconds * 1000 >= session.linkedSince - 1000,
        });
      }
    });
  });
  socket.ev.on('messages.update', (updates) =>
    enqueue(session, async () => {
      await assertLease(session);
      for (const { key, update } of updates) {
        const phone = await phoneFor(key);
        if (!key.fromMe || !phone || !key.id || update.status == null) continue;
        const status =
          update.status >= 4
            ? 'read'
            : update.status === 3
              ? 'delivered'
              : update.status === 2
                ? 'sent'
                : update.status === 0
                  ? 'failed'
                  : null;
        if (status) await recordPersonalReceipt(session.store, phone, key.id, status);
      }
    }),
  );
  socket.ev.on('message-receipt.update', (updates) =>
    enqueue(session, async () => {
      await assertLease(session);
      for (const { key, receipt } of updates) {
        const phone = await phoneFor(key);
        if (!phone || !key.id) continue;
        if (receipt.readTimestamp || receipt.playedTimestamp)
          await recordPersonalReceipt(session.store, phone, key.id, 'read');
        else if (receipt.receiptTimestamp)
          await recordPersonalReceipt(session.store, phone, key.id, 'delivered');
      }
    }),
  );
}
export async function startPersonal(
  store: ChatStore,
  options: { phone?: string; relink?: boolean } = {},
) {
  if (runtime.closing) throw new ChatError(503, 'Server is restarting. Try again shortly.');
  const current = runtime.sessions.get(store.uid);
  if (current && options.relink) {
    current.state = {
      status: 'connecting',
      phone: current.state.phone,
      qr: null,
      pairingCode: null,
      message: 'Re-linking this device for available phone history…',
    };
    current.stopped = true;
    clearInterval(current.heartbeat);
    clearTimeout(current.expiry);
    clearTimeout(current.retry);
    try {
      await current.socket?.logout();
    } catch {
      /* Closed connections can still be re-linked by their owner. */
    }
    await closeSession(current);
    await current.authQueue;
  } else if (current) return current;
  const pending = runtime.starts.get(store.uid);
  if (pending) return pending;
  const starting = (async () => {
    if (runtime.sessions.size >= Number(process.env.PERSONAL_WHATSAPP_MAX_SESSIONS || 3))
      throw new ChatError(
        503,
        'This server has reached its linked WhatsApp capacity. Try again later.',
      );
    const binding = await reserveProvider(store, 'personal');
    const lease = await store.read(leasePath);
    if (lease && Date.parse(lease.data.expiresAt) > Date.now())
      throw new ChatError(
        409,
        'Your saved WhatsApp session is reconnecting on another server. Try again in one minute.',
      );
    const leaseId = `${runtime.instance}:${randomUUID()}`;
    await store.commit([
      store.write(
        leasePath,
        { holder: leaseId, expiresAt: new Date(Date.now() + 60000).toISOString() },
        lease,
      ),
    ]);
    const b = await import('@whiskeysockets/baileys');
    const authConfig = await store.read('personalStatus/auth');
    const generation = options.relink || !authConfig ? randomUUID() : authConfig.data.generation;
    if (options.relink || !authConfig)
      await store.commit([store.write('personalStatus/auth', { generation }, authConfig)]);
    const auth = new PersonalAuthStore(
      store,
      (v) => JSON.stringify(v, b.BufferJSON.replacer),
      (v) => JSON.parse(v, b.BufferJSON.reviver),
      generation,
    );
    const saved = await auth.read('creds');
    const creds = options.relink ? b.initAuthCreds() : saved || b.initAuthCreds();
    const session: Session = {
      store,
      auth,
      creds,
      registered: !!creds.registered,
      wasRegistered: !!creds.registered,
      stopped: false,
      queue: Promise.resolve(),
      authQueue: Promise.resolve(),
      historyQueue: Promise.resolve(),
      linkedSince: Date.parse(binding.data.connectedAt || now()),
      failures: 0,
      leaseId,
      pairingPhone: options.phone,
      pairingRequested: false,
      state: {
        status: 'connecting',
        phone: null,
        qr: null,
        pairingCode: null,
        message: 'Connecting to WhatsApp…',
      },
    };
    if (runtime.sessions.size >= Number(process.env.PERSONAL_WHATSAPP_MAX_SESSIONS || 3))
      throw new ChatError(503, 'Linked WhatsApp capacity has been reached. Try again later.');
    runtime.sessions.set(store.uid, session);
    try {
      await auth.write({ creds });
      if (options.relink)
        await store.commit([
          store.write(
            historyStatusPath,
            {
              phase: 'waiting',
              message: 'Approve the new linked device and keep your phone online while chats sync.',
              progress: null,
              chats: 0,
              messages: 0,
              updatedAt: now(),
            },
            undefined,
          ),
        ]);
      session.heartbeat = setInterval(() => {
        if (session.renewing || session.stopped) return;
        session.renewing = true;
        void (async () => {
          const previous = await assertLease(session);
          await store.commit([
            store.write(
              leasePath,
              { holder: leaseId, expiresAt: new Date(Date.now() + 60000).toISOString() },
              previous,
            ),
          ]);
        })()
          .catch(() => stop(session))
          .finally(() => {
            session.renewing = false;
          });
      }, 20000);
      session.heartbeat.unref();
      if (!creds.registered) {
        session.expiry = setTimeout(() => {
          void closeSession(session);
        }, 180000);
        session.expiry.unref();
      }
      await connectSocket(session);
      return session;
    } catch (e) {
      await closeSession(session);
      throw e;
    }
  })();
  runtime.starts.set(store.uid, starting);
  try {
    return await starting;
  } finally {
    runtime.starts.delete(store.uid);
  }
}
export async function personalStatus(store: ChatStore, restore = true): Promise<PersonalStatus> {
  const active = runtime.sessions.get(store.uid);
  if (active) return { ...active.state };
  const binding = await providerDocument(store),
    previous = await store.read(statusPath);
  if (
    restore &&
    binding?.data.mode === 'personal' &&
    binding.data.locked &&
    previous?.data.status !== 'relink_required'
  ) {
    try {
      return {
        ...(await startPersonal(personalServiceStore(store.env, store.uid, store.send))).state,
      };
    } catch (e) {
      if (!(e instanceof ChatError && [409, 503].includes(e.status))) throw e;
    }
  }
  return {
    status: previous?.data.status === 'relink_required' ? 'relink_required' : 'offline',
    phone: binding?.data.phone || null,
    qr: null,
    pairingCode: null,
    message:
      previous?.data.status === 'relink_required'
        ? previous.data.message
        : 'Your saved linked session is offline. Choose Reconnect to resume.',
  };
}
export async function cancelPersonal(store: ChatStore) {
  const binding = await providerDocument(store),
    session = runtime.sessions.get(store.uid);
  if (binding?.data.locked || session?.creds.registered)
    throw new ChatError(
      409,
      'This connection is already linked. Continue with the same connection method.',
    );
  const lease = await store.read(leasePath);
  if (!session && lease && Date.parse(lease.data.expiresAt) > Date.now())
    throw new ChatError(409, 'Linking is running on another server. Wait a minute and try again.');
  if (session) {
    await closeSession(session);
    await session.queue;
    await session.authQueue;
  }
  const latest = await providerDocument(store);
  if (latest?.data.locked || session?.creds.registered)
    throw new ChatError(409, 'This connection is already linked.');
  if (!latest) return;
  // CAS protects a simultaneous successful QR scan or Meta connection.
  await store.commit([
    {
      delete: latest.name,
      currentDocument: { updateTime: latest.updateTime },
    },
    store.remove(statusPath),
  ]);
}
export async function sendPersonal(
  store: ChatStore,
  phone: string,
  text: string,
  providerId: string,
  upload?: UploadAttachment,
) {
  const session = runtime.sessions.get(store.uid);
  if (!session?.socket || session.stopped || session.state.status !== 'connected')
    throw new ChatError(
      409,
      'Your linked WhatsApp is offline. Open WhatsApp Integration and reconnect.',
    );
  await assertLease(session);
  const result = await session.socket.sendMessage(
    `${phone}@s.whatsapp.net`,
    upload ? whatsappAttachmentContent(upload) : { text },
    { messageId: providerId },
  );
  if (!result?.key.id)
    throw new ChatError(
      503,
      'WhatsApp did not confirm this message. Check its status before trying again.',
      'SEND_INDETERMINATE',
    );
  const persisted = upload ? describePersonalAttachment(result) : undefined;
  await recordPersonalMessage(store, {
    phone,
    providerId: result.key.id,
    text,
    outbound: true,
    at: now(),
    status: 'accepted',
    ...(upload
      ? {
          attachment: persisted?.attachment || {
            kind: upload.kind,
            mime: upload.mime,
            name: upload.name,
            available: false,
          },
          media: persisted?.media,
        }
      : {}),
  });
  return result.key.id;
}
export async function restorePersonalSessions(env: ChatEnvironment) {
  if (!env.serviceAccountJson || !env.encryptionKey || runtime.closing) return;
  const store = personalServiceStore(env, 'system-restore');
  let pageToken = '';
  for (let page = 0; page < 10; page++) {
    const url = new URL(`${store.base}/bpl_personalConnections`);
    url.searchParams.set('pageSize', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await store.send(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return;
    const result = await response.json();
    for (const document of result.documents || []) {
      const doc = store.decode(document);
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(doc.data.ownerId || '')) continue;
      const owner = personalServiceStore(env, doc.data.ownerId);
      const binding = await owner.read('whatsappProvider/current');
      if (binding?.data.mode !== 'personal' || !binding.data.locked) continue;
      const status = await owner.read(statusPath);
      if (status?.data.status === 'relink_required') continue;
      try {
        await startPersonal(owner);
      } catch {
        /* Expiring ownership/capacity: retry next pass. */
      }
    }
    pageToken = result.nextPageToken || '';
    if (!pageToken) return;
  }
}
if (!(globalThis as any).bplPersonalShutdownInstalled) {
  (globalThis as any).bplPersonalShutdownInstalled = true;
  const shutdown = () => {
    runtime.closing = true;
    for (const session of runtime.sessions.values()) void closeSession(session);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

export async function requestPersonalHistory(store: ChatStore) {
  const session = runtime.sessions.get(store.uid);
  if (!session?.socket || session.stopped || session.state.status !== 'connected')
    throw new ChatError(409, 'Connect your linked WhatsApp before syncing chats.');
  await assertLease(session);
  const previous = await store.read(historyStatusPath);
  if (previous?.data.requestedAt && Date.parse(previous.data.requestedAt) > Date.now() - 60000)
    throw new ChatError(
      429,
      'A chat sync was requested recently. Keep your phone online and wait a minute.',
    );
  const requestId = randomUUID();
  await store.commit([
    store.write(
      historyStatusPath,
      {
        phase: 'requested',
        requestId,
        requestedAt: now(),
        updatedAt: now(),
        progress: null,
        chats: previous?.data.chats || 0,
        messages: previous?.data.messages || 0,
        message: 'Chat history requested from your phone. Keep WhatsApp open and connected.',
      },
      previous,
    ),
  ]);
  const b = await import('@whiskeysockets/baileys');
  try {
    await session.socket.sendPeerDataOperationMessage({
      peerDataOperationRequestType:
        b.proto.Message.PeerDataOperationRequestType.FULL_HISTORY_SYNC_ON_DEMAND,
      fullHistorySyncOnDemandRequest: {
        requestMetadata: { requestId },
        historySyncConfig: {
          fullSyncDaysLimit: 90,
          fullSyncSizeMbLimit: 64,
          recentSyncDaysLimit: 30,
          storageQuotaMb: 64,
        },
      },
    });
  } catch {
    await store.commit([
      store.write(
        historyStatusPath,
        {
          phase: 'error',
          message:
            'WhatsApp did not confirm the history request. Retry when your linked device is online.',
          updatedAt: now(),
        },
        undefined,
        ['phase', 'message', 'updatedAt'],
      ),
    ]);
    throw new ChatError(503, 'The phone history request was not confirmed. Please retry.');
  }
  return personalHistoryStatus(store);
}

/** Fetch a thumbnail address from this owner's existing link, respecting WhatsApp visibility. */
export async function personalProfilePictureUrl(uid: string, phone: string) {
  const session = runtime.sessions.get(uid);
  if (!session?.socket || session.stopped || session.state.status !== 'connected')
    throw new ChatError(503, 'Linked WhatsApp is reconnecting');
  await assertLease(session);
  try {
    return await session.socket.profilePictureUrl(`${phone}@s.whatsapp.net`, 'preview', 5000);
  } catch (error) {
    const status = (error as { output?: { statusCode?: number } })?.output?.statusCode;
    if (status === 401 || status === 403 || status === 404) return undefined;
    throw error;
  }
}
