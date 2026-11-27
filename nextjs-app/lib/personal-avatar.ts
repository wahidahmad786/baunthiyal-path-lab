import { ChatError, verifyUser } from './account-chat-api';
import type { ChatEnvironment } from './chat-types';
import { personalProfilePictureUrl, personalServiceStore } from './personal-whatsapp';
import { providerDocument } from './whatsapp-provider';

const maxAvatarBytes = 512 * 1024;
const headers = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export function providerAvatarUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      !url.port &&
      !url.username &&
      !url.password &&
      (url.hostname.endsWith('.whatsapp.net') || url.hostname.endsWith('.fbcdn.net'))
      ? url
      : null;
  } catch {
    return null;
  }
}
export function avatarContentType(bytes: Uint8Array) {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)) return 'image/png';
  const signature = new TextDecoder().decode(bytes.subarray(0, 12));
  return signature.startsWith('RIFF') && signature.endsWith('WEBP') ? 'image/webp' : null;
}

type Avatar = { bytes: Uint8Array<ArrayBuffer>; type: string };
const pending = new Map<string, Promise<Avatar | null>>();
const cache = new Map<string, { value: Avatar | null; expires: number }>();
async function loadAvatar(uid: string, phone: string, send: typeof fetch) {
  const key = `${uid}:${phone}`;
  const saved = cache.get(key);
  if (saved && saved.expires > Date.now()) return saved.value;
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  if (pending.size >= 12) throw new ChatError(503, 'Avatar temporarily unavailable');
  const request = (async () => {
    const source = await personalProfilePictureUrl(uid, phone);
    const url = source && providerAvatarUrl(source);
    let avatar: Avatar | null = null;
    if (url) {
      const upstream = await send(url, {
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      });
      if (!upstream.ok || Number(upstream.headers.get('content-length')) > maxAvatarBytes) {
        await upstream.body?.cancel();
        return null;
      }
      const reader = upstream.body?.getReader();
      if (!reader) return null;
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxAvatarBytes) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const type = avatarContentType(bytes);
      if (type) avatar = { bytes, type };
    }
    if (cache.size >= 96) cache.delete(cache.keys().next().value!);
    cache.set(key, { value: avatar, expires: Date.now() + (avatar ? 120_000 : 30_000) });
    return avatar;
  })().finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}

export async function handlePersonalAvatar(
  request: Request,
  id: string,
  env: ChatEnvironment,
  send: typeof fetch = fetch,
) {
  const empty = (status: number) => new Response(null, { status, headers });
  try {
    const { uid } = await verifyUser(request, env, send);
    const workspace = request.headers.get('x-workspace-id');
    if (workspace && workspace !== uid) return empty(403);
    if (!/^[a-f0-9]{32}$/.test(id)) return empty(404);
    const store = personalServiceStore(env, uid, send);
    const binding = await providerDocument(store);
    if (binding?.data.mode !== 'personal' || binding.data.locked !== true) return empty(404);
    const chat = await store.read(`conversations/${id}`);
    const phone = String(chat?.data.phone || '').replace(/^\+/, '');
    if (!/^[1-9]\d{7,14}$/.test(phone)) return empty(404);
    const avatar = await loadAvatar(uid, phone, send);
    return avatar
      ? new Response(avatar.bytes, { headers: { ...headers, 'Content-Type': avatar.type } })
      : empty(404);
  } catch (error) {
    return empty(error instanceof ChatError ? error.status : 404);
  }
}
