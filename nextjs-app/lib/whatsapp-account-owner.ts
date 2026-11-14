import { ChatError, ChatStore, firestoreFields } from './account-chat-api';

// The callback override applies to a whole WABA. Two different portal owners
// must not silently redirect each other's private webhook traffic.
export async function claimWhatsAppAccount(store: ChatStore, wabaId: string) {
  if (!/^[1-9]\d{4,29}$/.test(wabaId)) throw new ChatError(400, 'Invalid WhatsApp account ID.');
  const path = `bpl_whatsappAccountOwners/${wabaId}`;
  const existing = await store.read(path, true);
  if (existing && existing.data.ownerId !== store.uid)
    throw new ChatError(
      409,
      'This WhatsApp Business account is already connected to another portal login. Use its original Google login.',
    );
  await store.commit([
    {
      update: {
        name: `projects/${store.env.projectId}/databases/(default)/documents/${path}`,
        fields: firestoreFields({ ownerId: store.uid, updatedAt: new Date().toISOString() }),
      },
      currentDocument: existing ? { updateTime: existing.updateTime } : { exists: false },
    },
  ]);
}
