import { z } from 'zod';

const metaId = z.string().regex(/^[1-9]\d{4,29}$/);
export const embeddedCompletionSchema = z
  .object({
    sessionId: z.string().regex(/^[a-f0-9]{64}$/),
    code: z.string().min(10).max(4096),
    wabaId: metaId,
    phoneNumberId: metaId.optional(),
    event: z.enum([
      'FINISH',
      'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
      'FINISH_GRANT_ONLY_API_ACCESS',
    ]),
  })
  .strict();
export type EmbeddedAssets = {
  wabaId: string;
  phoneNumberId?: string;
  event: z.infer<typeof embeddedCompletionSchema>['event'];
};
export type EmbeddedStatus = {
  ready: boolean;
  appId: string | null;
  configId: string | null;
  graphVersion: string;
  coexistence: boolean;
  reason: string | null;
};
export function readEmbeddedEvent(
  origin: string,
  value: unknown,
): EmbeddedAssets | 'cancel' | 'error' | null {
  let host: URL;
  try {
    host = new URL(origin);
  } catch {
    return null;
  }
  if (
    host.protocol !== 'https:' ||
    !(host.hostname === 'facebook.com' || host.hostname.endsWith('.facebook.com')) ||
    host.port
  )
    return null;
  let data: any;
  try {
    data = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return null;
  }
  if (!data || data.type !== 'WA_EMBEDDED_SIGNUP') return null;
  if (data.event === 'CANCEL') return 'cancel';
  if (data.event === 'ERROR') return 'error';
  const parsed = embeddedCompletionSchema.omit({ code: true, sessionId: true }).safeParse({
    wabaId: data.data?.waba_id,
    ...(data.data?.phone_number_id ? { phoneNumberId: data.data.phone_number_id } : {}),
    event: data.event,
  });
  return parsed.success ? parsed.data : null;
}
