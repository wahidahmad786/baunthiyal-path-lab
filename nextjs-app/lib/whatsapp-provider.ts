import { ChatError, ChatStore, readChatConnection } from './account-chat-api';
export type WhatsAppProvider = 'meta' | 'personal';
export const providerPath = 'whatsappProvider/current';
export async function providerDocument(store: ChatStore) {
  let doc = await store.read(providerPath);
  if (!doc) {
    const old = await readChatConnection(store);
    if (old?.verifiedAt) {
      try {
        await store.commit([
          store.write(
            providerPath,
            {
              ownerId: store.uid,
              mode: 'meta',
              locked: true,
              phone: old.phone,
              connectedAt: old.verifiedAt,
              updatedAt: new Date().toISOString(),
            },
            null,
          ),
        ]);
      } catch (e) {
        if (!(e instanceof ChatError && e.status === 409)) throw e;
      }
      doc = await store.read(providerPath);
    }
  }
  return doc;
}
/** Reserves the choice atomically before starting either external onboarding flow. */
export async function reserveProvider(store: ChatStore, mode: WhatsAppProvider) {
  const old = await providerDocument(store);
  if (old && old.data.mode !== mode)
    throw new ChatError(
      409,
      `This Google account already uses ${old.data.mode === 'meta' ? 'Meta Business API' : 'linked personal WhatsApp'}. Continue with that connection.`,
      'WHATSAPP_PROVIDER_LOCKED',
    );
  if (!old)
    await store.commit([
      store.write(
        providerPath,
        {
          ownerId: store.uid,
          mode,
          locked: false,
          phone: null,
          connectedAt: null,
          updatedAt: new Date().toISOString(),
        },
        null,
      ),
    ]);
  return (await store.read(providerPath))!;
}
export async function lockProvider(store: ChatStore, mode: WhatsAppProvider, phone: string) {
  const old = await reserveProvider(store, mode);
  const registryWrites = [];
  if (mode === 'personal') {
    const registry = store.write(
      'unused/current',
      { ownerId: store.uid, connectedAt: old.data.connectedAt || new Date().toISOString() },
      undefined,
    );
    registry.update.name = `projects/${store.env.projectId}/databases/(default)/documents/bpl_personalConnections/${store.uid}`;
    registryWrites.push(registry);
  }
  await store.commit([
    ...registryWrites,
    store.write(
      providerPath,
      {
        ...old.data,
        locked: true,
        phone,
        connectedAt: old.data.connectedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      old,
    ),
  ]);
}
export async function requireMetaProvider(store: ChatStore, reserve = false) {
  const existing = await providerDocument(store);
  if (existing?.data.mode === 'personal')
    throw new ChatError(
      409,
      'This account uses linked WhatsApp. Meta templates and Meta API setup are unavailable for this connection.',
      'WHATSAPP_PROVIDER_LOCKED',
    );
  if (reserve) return reserveProvider(store, 'meta');
  return existing;
}
