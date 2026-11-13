type CachedToken = { token: string; expiresAt: number };
const cache = new Map<string, CachedToken>();
const pending = new Map<string, Promise<string>>();
const encoder = new TextEncoder();
const tokenUrl = 'https://oauth2.googleapis.com/token';
function base64url(value: Uint8Array) {
  return btoa(String.fromCharCode(...value))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}
function encode(value: unknown) {
  return base64url(encoder.encode(JSON.stringify(value)));
}
export function clearServiceTokenCacheForTests() {
  cache.clear();
  pending.clear();
}

export async function getServiceAccessToken(
  serviceAccountJson: string,
  send: typeof fetch = fetch,
): Promise<string> {
  let account: {
    client_email?: unknown;
    private_key?: unknown;
    project_id?: unknown;
    type?: unknown;
  };
  try {
    account = JSON.parse(serviceAccountJson);
  } catch {
    throw new Error('The inbox service identity is not configured correctly.');
  }
  if (
    account.type !== 'service_account' ||
    typeof account.client_email !== 'string' ||
    !/^[^\s@]+@[^\s@]+\.gserviceaccount\.com$/.test(account.client_email) ||
    typeof account.private_key !== 'string' ||
    !account.private_key.includes('BEGIN PRIVATE KEY') ||
    account.private_key.length > 12000
  )
    throw new Error('The inbox service identity is not configured correctly.');
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(account.private_key));
  const cacheKey = account.client_email + ':' + base64url(new Uint8Array(digest));
  const existing = cache.get(cacheKey);
  if (existing && existing.expiresAt > Date.now() + 60000) return existing.token;
  const inFlight = pending.get(cacheKey);
  if (inFlight) return inFlight;
  const issue = (async () => {
    try {
      const raw = account.private_key as string;
      const der = Uint8Array.from(
        atob(raw.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '')),
        (c) => c.charCodeAt(0),
      );
      const key = await crypto.subtle.importKey(
        'pkcs8',
        der,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const now = Math.floor(Date.now() / 1000);
      const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: account.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud: tokenUrl, iat: now, exp: now + 3600 })}`;
      const signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        key,
        encoder.encode(unsigned),
      );
      const response = await send(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: `${unsigned}.${base64url(new Uint8Array(signature))}`,
        }),
        signal: AbortSignal.timeout(15000),
      });
      const result = await response.json();
      if (
        !response.ok ||
        typeof result.access_token !== 'string' ||
        !result.access_token ||
        !Number.isFinite(Number(result.expires_in)) ||
        Number(result.expires_in) <= 0
      )
        throw new Error();
      cache.set(cacheKey, {
        token: result.access_token,
        expiresAt: Date.now() + Math.min(Number(result.expires_in), 3600) * 1000,
      });
      return result.access_token as string;
    } catch {
      throw new Error(
        'Unable to authenticate the inbox service. Please contact the lab administrator.',
      );
    }
  })();
  pending.set(cacheKey, issue);
  try {
    return await issue;
  } finally {
    pending.delete(cacheKey);
  }
}
