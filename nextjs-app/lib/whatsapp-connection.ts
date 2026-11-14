import { z } from 'zod';
import { MetaTemplateError } from './meta-marketing-templates';

const id = z
  .string()
  .trim()
  .regex(/^\d{5,30}$/, 'Enter the numeric Meta ID');
export const connectionSchema = z
  .object({
    phone: z
      .string()
      .trim()
      .regex(/^\+?[1-9]\d{9,14}$/, 'Include the country code, for example +916395951791'),
    phoneNumberId: id,
    businessAccountId: id,
    appId: id,
    accessToken: z.string().trim().max(4096).default(''),
    appSecret: z.string().trim().max(256).default(''),
    verifyToken: z.string().trim().max(256).default(''),
    verify: z.boolean().default(false),
  })
  .strict();
export type ConnectionInput = z.infer<typeof connectionSchema>;
export type ConnectionRecord = Omit<ConnectionInput, 'verify'> & {
  verifiedAt: string | null;
  verifiedName: string;
  connectionMethod?: 'embedded_signup' | 'manual';
  tokenExpiresAt?: string | null;
  dataAccessExpiresAt?: string | null;
  coexistence?: boolean;
  registrationPin?: string;
};
export type ConnectionSummary = Omit<
  ConnectionRecord,
  'accessToken' | 'appSecret' | 'verifyToken' | 'registrationPin'
> & {
  accessTokenSaved: boolean;
  appSecretSaved: boolean;
  verifyTokenSaved: boolean;
};
export function connectionSummary(record: ConnectionRecord): ConnectionSummary {
  const { accessToken, appSecret, verifyToken, registrationPin: _pin, ...publicFields } = record;
  return {
    ...publicFields,
    accessTokenSaved: !!accessToken,
    appSecretSaved: !!appSecret,
    verifyTokenSaved: !!verifyToken,
  };
}
const bytes = (text: string) => new TextEncoder().encode(text);
function base64(data: Uint8Array) {
  return btoa(String.fromCharCode(...data));
}
function unbase64(text: string) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
export type EncryptedConnection = { version: 1; iv: string; ciphertext: string };
async function encryptionKey(secret: string) {
  if (!/^[a-f0-9]{64}$/i.test(secret))
    throw new Error(
      'Secure connection storage is unavailable. Please contact the lab administrator.',
    );
  return crypto.subtle.importKey(
    'raw',
    Uint8Array.from(secret.match(/../g)!, (b) => parseInt(b, 16)),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  );
}
export async function encryptConnection(
  value: ConnectionRecord,
  uid: string,
  secret: string,
): Promise<EncryptedConnection> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: bytes(`bpl-whatsapp:${uid}:1`) },
    await encryptionKey(secret),
    bytes(JSON.stringify(value)),
  );
  return { version: 1, iv: base64(iv), ciphertext: base64(new Uint8Array(encrypted)) };
}
export async function decryptConnection(
  envelope: EncryptedConnection,
  uid: string,
  secret: string,
): Promise<ConnectionRecord> {
  if (envelope.version !== 1) throw new Error('Unsupported connection format');
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unbase64(envelope.iv), additionalData: bytes(`bpl-whatsapp:${uid}:1`) },
    await encryptionKey(secret),
    unbase64(envelope.ciphertext),
  );
  const record = JSON.parse(new TextDecoder().decode(decrypted));
  const {
    verifiedAt,
    verifiedName,
    connectionMethod,
    tokenExpiresAt,
    dataAccessExpiresAt,
    coexistence,
    registrationPin,
    ...credentials
  } = record;
  const { verify: _verify, ...input } = connectionSchema.parse(credentials);
  return {
    ...input,
    verifiedAt: verifiedAt || null,
    verifiedName: verifiedName || '',
    ...(connectionMethod
      ? {
          connectionMethod,
          tokenExpiresAt: tokenExpiresAt || null,
          dataAccessExpiresAt: dataAccessExpiresAt || null,
          coexistence: coexistence === true,
          ...(registrationPin ? { registrationPin } : {}),
        }
      : {}),
  };
}
export async function verifyMetaConnection(
  record: ConnectionRecord,
  version = 'v23.0',
  send: typeof fetch = fetch,
) {
  if (!/^v\d+\.\d+$/.test(version)) throw new Error('Unsupported Meta API version');
  const key = await crypto.subtle.importKey(
    'raw',
    bytes(record.appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const proof = Array.from(
    new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes(record.accessToken))),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
  let cursor = '';
  for (let page = 0; page < 10; page++) {
    const url = new URL(
      `https://graph.facebook.com/${version}/${record.businessAccountId}/phone_numbers`,
    );
    url.searchParams.set('fields', 'id,display_phone_number,verified_name');
    url.searchParams.set('limit', '100');
    url.searchParams.set('appsecret_proof', proof);
    if (cursor) url.searchParams.set('after', cursor);
    const response = await send(url, {
      headers: { Authorization: `Bearer ${record.accessToken}` },
      signal: AbortSignal.timeout(20000),
    });
    const result = await response.json();
    const tokenErrorCode = Number(result.error?.code);
    if (!response.ok && [190, 102, 104].includes(tokenErrorCode))
      throw new MetaTemplateError(
        409,
        tokenErrorCode,
        `Meta rejected the saved access token (code ${tokenErrorCode}). Replace it in WhatsApp Integration, then choose Verify & save.`,
      );
    if (!response.ok)
      throw new Error(
        'Meta could not verify these details. Check your access token, app secret and WhatsApp Business Account ID.',
      );
    const phone = (result.data || []).find((p: { id: string }) => p.id === record.phoneNumberId);
    if (phone) {
      if (String(phone.display_phone_number).replace(/\D/g, '') !== record.phone.replace(/\D/g, ''))
        throw new Error('This phone number does not match the selected Meta Phone Number ID.');
      // Verify the supplied app ID using the same user token, without exposing credentials in a URL.
      const appUrl = new URL(`https://graph.facebook.com/${version}/app`);
      appUrl.searchParams.set('fields', 'id');
      appUrl.searchParams.set('appsecret_proof', proof);
      const appResponse = await send(appUrl, {
        headers: { Authorization: `Bearer ${record.accessToken}` },
        signal: AbortSignal.timeout(20000),
      });
      const app = await appResponse.json();
      const appTokenErrorCode = Number(app.error?.code);
      if (!appResponse.ok && [190, 102, 104].includes(appTokenErrorCode))
        throw new MetaTemplateError(
          409,
          appTokenErrorCode,
          `Meta rejected the saved access token (code ${appTokenErrorCode}). Replace it in WhatsApp Integration, then choose Verify & save.`,
        );
      if (!appResponse.ok || app.id !== record.appId)
        throw new Error('The access token does not match this Meta App ID.');
      return {
        verifiedAt: new Date().toISOString(),
        verifiedName: String(phone.verified_name || ''),
      };
    }
    cursor = result.paging?.cursors?.after || '';
    if (!result.paging?.next || !cursor) break;
  }
  throw new Error('The Phone Number ID is not listed under this WhatsApp Business Account ID.');
}
