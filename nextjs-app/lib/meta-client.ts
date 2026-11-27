import type { ConnectionRecord } from './whatsapp-connection';

export class MetaGraphError extends Error {
  constructor(
    public status: number,
    public code: number,
    message: string,
    public uncertain = false,
  ) {
    super(message);
  }
}
export async function metaProof(secret: string, token: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return Array.from(
    new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(token))),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
export function metaFailure(status: number, code: number) {
  if ([190, 102, 104].includes(code))
    return new MetaGraphError(
      409,
      code,
      'Meta access has expired or was revoked. Reconnect WhatsApp in WhatsApp Integration.',
    );
  if (status === 429 || [4, 17, 32, 613, 80007, 130429].includes(code))
    return new MetaGraphError(429, code, 'Meta is limiting requests. Wait before trying again.');
  if (status === 403 || [10, 200].includes(code))
    return new MetaGraphError(
      403,
      code,
      'Meta has not granted the required access. Check WhatsApp permissions and business account access.',
    );
  if (status >= 500 || [1, 2].includes(code))
    return new MetaGraphError(
      503,
      code,
      'Meta is temporarily unavailable. Refresh the status before trying again.',
      true,
    );
  return new MetaGraphError(
    409,
    Number.isSafeInteger(code) ? code : 0,
    'Meta did not accept this request. Check the template details, account access and Meta settings.',
  );
}
export async function metaJson(
  record: ConnectionRecord,
  path: string,
  send: typeof fetch,
  version = 'v23.0',
  data?: Record<string, unknown>,
  query: Record<string, string> = {},
) {
  if (!/^v\d+\.\d+$/.test(version))
    throw new MetaGraphError(503, 0, 'The Meta API version is not configured.');
  const url = new URL(`https://graph.facebook.com/${version}/${path}`);
  url.searchParams.set('appsecret_proof', await metaProof(record.appSecret, record.accessToken));
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  let response: Response;
  try {
    response = await send(url, {
      method: data ? 'POST' : 'GET',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${record.accessToken}`,
        'Content-Type': 'application/json',
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
      signal: AbortSignal.timeout(18000),
    });
  } catch {
    throw new MetaGraphError(
      503,
      0,
      'Meta could not be reached. Refresh the provider status before retrying.',
      !!data,
    );
  }
  const result = await response.json().catch(() => null);
  if (response.ok && (!result || typeof result !== 'object' || Array.isArray(result)))
    throw new MetaGraphError(
      502,
      0,
      'Meta returned incomplete data. Refresh the provider status before retrying.',
      !!data,
    );
  if (!response.ok || !result || result.error)
    throw metaFailure(response.status || 502, Number(result?.error?.code || 0));
  return result;
}
export async function inspectMetaToken(
  record: ConnectionRecord,
  send: typeof fetch,
  version = 'v23.0',
) {
  const url = new URL(`https://graph.facebook.com/${version}/debug_token`);
  url.searchParams.set('input_token', record.accessToken);
  let response: Response;
  try {
    response = await send(url, {
      headers: { Authorization: `Bearer ${record.appId}|${record.appSecret}` },
      redirect: 'error',
      signal: AbortSignal.timeout(18000),
    });
  } catch {
    throw new MetaGraphError(503, 0, 'Meta token status could not be checked.');
  }
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.error)
    throw metaFailure(response.status, Number(result?.error?.code || 0));
  return result?.data || {};
}
