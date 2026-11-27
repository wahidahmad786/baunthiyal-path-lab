import { z } from 'zod';
import { ChatError, ChatStore, chatJson, readChatBody, verifyUser } from './account-chat-api';
import { allowedRequestOrigin } from './request-origin';
import { providerDocument, reserveProvider } from './whatsapp-provider';
import {
  cancelPersonal,
  personalServiceStore,
  personalStatus,
  startPersonal,
} from './personal-whatsapp';
import type { ChatEnvironment } from './chat-types';
const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('select-meta') }).strict(),
  z.object({ action: z.literal('cancel') }).strict(),
  z
    .object({
      action: z.literal('connect-personal'),
      acceptedUnofficial: z.literal(true),
      phone: z
        .string()
        .regex(/^[1-9]\d{7,14}$/)
        .optional(),
      relink: z.boolean().optional(),
    })
    .strict(),
]);
export async function handleWhatsAppProvider(
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
    if (request.method === 'POST') {
      const parsed = inputSchema.safeParse(
        JSON.parse(new TextDecoder().decode(await readChatBody(request, 4096))),
      );
      if (!parsed.success)
        throw new ChatError(
          400,
          'Choose a connection method and acknowledge the linked-device terms. Include a country code for phone pairing.',
        );
      const input = parsed.data;
      if (input.action === 'select-meta') await reserveProvider(store, 'meta');
      if (input.action === 'connect-personal') {
        const previous = await providerDocument(store);
        if (input.relink && !previous?.data.locked)
          throw new ChatError(409, 'Use a new connection instead of re-linking.');
        if (previous?.data.phone && input.phone && previous.data.phone !== `+${input.phone}`)
          throw new ChatError(
            409,
            'Re-link the same WhatsApp number connected to this Google account.',
          );
        await startPersonal(personalServiceStore(env, user.uid, send), input);
      }
      if (input.action === 'cancel') {
        const previous = await providerDocument(store);
        if (previous?.data.locked)
          throw new ChatError(
            409,
            'This account already has a connected WhatsApp. Its connection method is fixed.',
          );
        if (previous?.data.mode === 'personal') await cancelPersonal(store);
        else if (previous)
          await store.commit([
            { delete: previous.name, currentDocument: { updateTime: previous.updateTime } },
          ]);
      }
    }
    const doc = await providerDocument(store);
    const personal = doc?.data.mode === 'personal' ? await personalStatus(store) : null;
    // Explicit public projection; session credentials/keys and cross-account data are never returned.
    return chatJson({
      mode: doc?.data.mode || null,
      locked: doc?.data.locked === true,
      phone: doc?.data.phone || personal?.phone || null,
      connectedAt: doc?.data.connectedAt || null,
      personal,
    });
  } catch (e) {
    if (e instanceof ChatError) return chatJson({ error: e.message, code: e.code }, e.status);
    if (e instanceof SyntaxError)
      return chatJson({ error: 'Enter valid connection details.' }, 400);
    return chatJson({ error: 'WhatsApp linking could not complete. Please try again.' }, 503);
  }
}
