import { getServiceAccessToken } from './google-service-account';
import { imageDetails, MAX_STORED_BANNER_BYTES } from './banner';

export type BannerEnvironment = {
  projectId: string;
  apiKey: string;
  serviceAccountJson: string;
  authOrigin?: string;
  firestoreOrigin?: string;
};
class BannerError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
function toBase64(bytes: Uint8Array) {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(text);
}
export async function handleAccountBanners(
  request: Request,
  env: BannerEnvironment,
  send: typeof fetch = fetch,
): Promise<Response> {
  try {
    const path = new URL(request.url).pathname.replace(/\/$/, '');
    const match = /^\/api\/account\/banners(?:\/([a-f0-9]{32}))?$/.exec(path);
    if (!match) return json({ error: 'Banner not found.' }, 404);
    const id = match[1];
    if (
      (request.method === 'GET' && !id) ||
      (request.method === 'POST' && id) ||
      !['GET', 'POST'].includes(request.method)
    )
      return json({ error: 'Method not allowed.' }, 405);
    if (request.method === 'POST' && request.headers.get('origin') !== new URL(request.url).origin)
      throw new BannerError(403, 'Request origin is not allowed.');
    const authorization = request.headers.get('authorization') || '';
    const token = authorization.length < 16384 ? authorization.match(/^Bearer (\S+)$/)?.[1] : null;
    if (!token) throw new BannerError(401, 'Sign in to upload or view campaign banners.');
    if (!env.projectId || !env.apiKey || !env.serviceAccountJson)
      throw new BannerError(
        503,
        'Banner storage is not configured. Contact the lab administrator.',
      );
    const checked = await send(
      `${env.authOrigin || 'https://identitytoolkit.googleapis.com'}/v1/accounts:lookup?key=${encodeURIComponent(env.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: token }),
        signal: AbortSignal.timeout(15000),
      },
    );
    const identity = (await checked.json()).users?.[0];
    if (!checked.ok || !identity || identity.disabled)
      throw new BannerError(401, 'Your sign-in expired. Sign in again.');
    if (!identity.emailVerified || !/^[A-Za-z0-9_-]{1,128}$/.test(identity.localId))
      throw new BannerError(403, 'Use a verified Google account to manage banners.');
    const uid = identity.localId;
    let bytes: Uint8Array | undefined,
      details: ReturnType<typeof imageDetails> = null;
    let filename = 'Campaign banner';
    if (request.method === 'POST') {
      if (Number(request.headers.get('content-length')) > MAX_STORED_BANNER_BYTES)
        throw new BannerError(413, 'The optimized image must be at most 600 KB.');
      if (!['image/png', 'image/jpeg'].includes(request.headers.get('content-type') || ''))
        throw new BannerError(400, 'Only PNG and JPEG images are accepted.');
      const reader = request.body?.getReader();
      if (!reader) throw new BannerError(400, 'Choose an image first.');
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_STORED_BANNER_BYTES) {
          await reader.cancel();
          throw new BannerError(413, 'The optimized image must be at most 600 KB.');
        }
        chunks.push(part.value);
      }
      bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      details = imageDetails(bytes);
      if (!details || details.type !== request.headers.get('content-type'))
        throw new BannerError(
          400,
          'Choose a valid PNG or JPEG banner no larger than 1600 pixels on either side.',
        );
      try {
        filename =
          decodeURIComponent(request.headers.get('x-banner-name') || 'Campaign banner')
            .replace(/[\u0000-\u001f\u007f]/g, '')
            .trim()
            .slice(0, 120) || 'Campaign banner';
      } catch {
        throw new BannerError(400, 'The image filename is invalid.');
      }
    }
    const serviceToken = await getServiceAccessToken(env.serviceAccountJson, send);
    const headers = { Authorization: `Bearer ${serviceToken}`, 'Content-Type': 'application/json' };
    const documents = `${env.firestoreOrigin || 'https://firestore.googleapis.com'}/v1/projects/${env.projectId}/databases/(default)/documents`;
    const digest = bytes
      ? Array.from(
          new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))),
          (b) => b.toString(16).padStart(2, '0'),
        )
          .join('')
          .slice(0, 32)
      : id!;
    const relative = `bpl_customerWorkspaces/${uid}/banners/${digest}`;
    const response = await send(`${documents}/${relative}`, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (request.method === 'GET') {
      if (response.status === 404)
        throw new BannerError(404, 'Banner not found in your workspace.');
      if (!response.ok) throw new BannerError(503, 'Unable to load this banner. Try again.');
      const fields = (await response.json()).fields;
      if (fields.ownerId?.stringValue !== uid)
        throw new BannerError(404, 'Banner not found in your workspace.');
      const content = Uint8Array.from(atob(fields.content.bytesValue), (c) => c.charCodeAt(0));
      return new Response(content, {
        headers: {
          'Content-Type': fields.contentType.stringValue,
          'Content-Length': String(content.byteLength),
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'",
        },
      });
    }
    if (!response.ok && response.status !== 404)
      throw new BannerError(503, 'Unable to check banner storage. Try again.');
    if (!response.ok) {
      const fields = {
        ownerId: { stringValue: uid },
        id: { stringValue: digest },
        name: { stringValue: filename },
        contentType: { stringValue: details!.type },
        size: { integerValue: String(bytes!.length) },
        width: { integerValue: String(details!.width) },
        height: { integerValue: String(details!.height) },
        content: { bytesValue: toBase64(bytes!) },
        createdAt: { timestampValue: new Date().toISOString() },
      };
      const saved = await send(`${documents}:commit`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          writes: [
            {
              update: {
                name: `projects/${env.projectId}/databases/(default)/documents/${relative}`,
                fields,
              },
              currentDocument: { exists: false },
            },
          ],
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (!saved.ok && saved.status !== 409)
        throw new BannerError(503, 'The banner could not be saved. Try again.');
    }
    return json(
      {
        id: digest,
        path: `account-banners/${uid}/${digest}`,
        name: filename,
        size: bytes!.length,
        type: details!.type,
      },
      response.ok ? 200 : 201,
    );
  } catch (error) {
    if (error instanceof BannerError) return json({ error: error.message }, error.status);
    return json(
      {
        error:
          'Banner storage is temporarily unavailable. Try again or contact the lab administrator.',
      },
      503,
    );
  }
}
