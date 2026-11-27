import { createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { WAMessage } from '@whiskeysockets/baileys';

const maxPhotoBytes = 8 * 1024 * 1024;
const maxThumbnailBytes = 4096;
type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
type PhotoSource = { url: string; key: string; hash: string; size: number };
export type PersonalImage = { source?: PhotoSource; thumbnail?: string };

function approvedMediaUrl(raw: string): URL | undefined {
  if (raw.length > 3072) return;
  try {
    const url = new URL(raw);
    if (
      url.protocol === 'https:' &&
      /^(?:mmg|media)(?:-[a-z0-9-]+)?\.whatsapp\.net$/i.test(url.hostname) &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.hash &&
      /^\/(?:v|d\/f)\//.test(url.pathname)
    )
      return url;
  } catch {
    // Unsupported provider location.
  }
}
function mimeFromBytes(bytes: Buffer): ImageMime | undefined {
  if (bytes.length < 12) return;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
    return 'image/webp';
  if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'image/gif';
}
const exactBinary = (value: unknown, size: number) =>
  value instanceof Uint8Array && value.byteLength === size
    ? Buffer.from(value).toString('base64')
    : undefined;
function normalImage(message: WAMessage) {
  const raw = message.message;
  if (
    !raw ||
    raw.ephemeralMessage ||
    raw.viewOnceMessage ||
    raw.viewOnceMessageV2 ||
    raw.viewOnceMessageV2Extension ||
    Number((message as { ephemeralDuration?: number }).ephemeralDuration) > 0
  )
    return;
  const content = raw.deviceSentMessage?.message || raw;
  const image = content.imageMessage;
  if (
    image &&
    !content.ephemeralMessage &&
    !content.viewOnceMessage &&
    !content.viewOnceMessageV2 &&
    !content.viewOnceMessageV2Extension &&
    !image.viewOnce &&
    !image.contextInfo?.expiration
  )
    return image;
}
export function isPersonalPhoto(message: WAMessage) {
  return !!normalImage(message);
}
export function capturePersonalImage(message: WAMessage): PersonalImage | undefined {
  const image = normalImage(message);
  if (!image) return;
  const key = exactBinary(image.mediaKey, 32),
    hash = exactBinary(image.fileSha256, 32);
  const size = Number(image.fileLength);
  const original = typeof image.url === 'string' ? approvedMediaUrl(image.url) : undefined;
  const path = image.directPath;
  const url =
    typeof path === 'string' && path.startsWith('/v/')
      ? approvedMediaUrl(`https://${original?.hostname || 'mmg.whatsapp.net'}${path}`)
      : original;
  const thumb = image.jpegThumbnail;
  const thumbnail =
    thumb && thumb.length <= maxThumbnailBytes && mimeFromBytes(Buffer.from(thumb)) === 'image/jpeg'
      ? Buffer.from(thumb).toString('base64')
      : undefined;
  const source =
    key && hash && url && Number.isSafeInteger(size) && size > 0 && size <= maxPhotoBytes
      ? { url: url.href, key, hash, size }
      : undefined;
  return source || thumbnail ? { source, thumbnail } : undefined;
}
type ImageResult = { bytes: Buffer; mime: ImageMime };
let activeDownloads = 0;

async function fetchProtectedImage(
  source: PhotoSource,
  send: typeof fetch,
  requestSignal?: AbortSignal,
): Promise<ImageResult | undefined> {
  const url = approvedMediaUrl(source.url);
  const key = Buffer.from(source.key || '', 'base64');
  const hash = Buffer.from(source.hash || '', 'base64');
  const size = source.size;
  if (!url || key.byteLength !== 32 || hash.byteLength !== 32) return;
  if (!Number.isSafeInteger(size) || size <= 0 || size > maxPhotoBytes) return;
  if (activeDownloads >= 6) return;
  activeDownloads++;
  const timeout = AbortSignal.timeout(12000);
  const signal = requestSignal ? AbortSignal.any([timeout, requestSignal]) : timeout;
  try {
    const exactEncryptedLength = (Math.floor(size / 16) + 1) * 16 + 10;
    const response = await send(url, {
      redirect: 'error',
      signal,
      cache: 'no-store',
      headers: { Origin: 'https://web.whatsapp.com' },
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return;
    }
    const reader = response.body.getReader();
    const encrypted = Buffer.allocUnsafe(exactEncryptedLength);
    let offset = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (offset + value.byteLength > encrypted.byteLength) return;
        encrypted.set(value, offset);
        offset += value.byteLength;
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (offset !== encrypted.byteLength) return;
    const { getMediaKeys } = await import('@whiskeysockets/baileys');
    const { iv, cipherKey, macKey } = await getMediaKeys(key, 'image');
    if (!macKey) return;
    const ciphertext = encrypted.subarray(0, -10);
    const mac = createHmac('sha256', macKey).update(iv).update(ciphertext).digest().subarray(0, 10);
    if (!timingSafeEqual(mac, encrypted.subarray(-10))) return;
    const aes = createDecipheriv('aes-256-cbc', cipherKey, iv);
    const bytes = Buffer.concat([aes.update(ciphertext), aes.final()]);
    if (
      bytes.byteLength !== size ||
      !timingSafeEqual(createHash('sha256').update(bytes).digest(), hash)
    )
      return;
    const mime = mimeFromBytes(bytes);
    if (mime) return { bytes, mime };
  } catch {
    // Provider media can expire or be unavailable. Do not expose private URLs or keys.
  } finally {
    activeDownloads--;
  }
}
export async function personalImageBytes(
  image: PersonalImage,
  send: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ImageResult | undefined> {
  if (!image || signal?.aborted) return;
  if (image.source) {
    const original = await fetchProtectedImage(image.source, send, signal);
    if (original) return original;
  }
  if (!image.thumbnail || image.thumbnail.length > Math.ceil(maxThumbnailBytes / 3) * 4) return;
  const bytes = Buffer.from(image.thumbnail, 'base64');
  if (bytes.length <= maxThumbnailBytes && mimeFromBytes(bytes) === 'image/jpeg')
    return { bytes, mime: 'image/jpeg' };
}
