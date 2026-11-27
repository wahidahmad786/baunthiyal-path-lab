import { createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { WAMessage } from '@whiskeysockets/baileys';
import type { ChatAttachment } from './chat-types';

const MiB = 1024 * 1024;
const maxThumbnailBytes = 16 * 1024;
const transferBudget = 40 * MiB;
const sizeLimit = {
  image: 16 * MiB,
  video: 24 * MiB,
  audio: 16 * MiB,
  voice: 16 * MiB,
  document: 24 * MiB,
  sticker: 4 * MiB,
} as const;
type Kind = ChatAttachment['kind'];
type Source = {
  urls: string[];
  key: string;
  hash?: string;
  size?: number;
  mediaType: 'image' | 'video' | 'audio' | 'document' | 'sticker';
};
export type PersonalMedia = { kind: Kind; source?: Source; thumbnail?: string; name?: string };
export type PersonalImage = {
  source?: { url: string; key: string; hash: string; size: number };
  thumbnail?: string;
};
type MediaProto = {
  url?: string | null;
  directPath?: string | null;
  mediaKey?: Uint8Array | null;
  fileSha256?: Uint8Array | null;
  fileLength?: unknown;
  jpegThumbnail?: Uint8Array | null;
  mimetype?: string | null;
  fileName?: string | null;
  caption?: string | null;
  contextInfo?: { expiration?: number | null } | null;
  viewOnce?: boolean | null;
};
type Captured = { attachment: ChatAttachment; media?: PersonalMedia; caption: string };

function approvedMediaUrl(raw: string): URL | undefined {
  if (raw.length > 3072) return;
  try {
    const url = new URL(raw);
    if (
      url.protocol === 'https:' &&
      /^(?:mmg|media)(?:-[a-z0-9-]+)?(?:\.cdn)?\.whatsapp\.net$/i.test(url.hostname) &&
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
function mediaUrls(proto: MediaProto): string[] {
  const supplied = typeof proto.url === 'string' ? approvedMediaUrl(proto.url) : undefined;
  const signedPath =
    typeof proto.directPath === 'string' && /^\/(?:v|d\/f)\//.test(proto.directPath)
      ? approvedMediaUrl(`https://${supplied?.hostname || 'mmg.whatsapp.net'}${proto.directPath}`)
      : undefined;
  return [...new Set([supplied?.href, signedPath?.href].filter((url): url is string => !!url))];
}
function mimeFromBytes(bytes: Buffer, kind: Kind): string | undefined {
  if (kind === 'document') return bytes.length ? 'application/octet-stream' : undefined;
  const isAudio = kind === 'audio' || kind === 'voice';
  if (bytes.length < 12) return;
  if (kind === 'image' || kind === 'sticker') {
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
    if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
      return 'image/webp';
    if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'image/gif';
    return;
  }
  if (bytes.toString('ascii', 4, 8) === 'ftyp') return isAudio ? 'audio/mp4' : 'video/mp4';
  if (kind === 'video' && bytes.readUInt32BE(0) === 0x1a45dfa3) return 'video/webm';
  if (!isAudio) return;
  if (bytes.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (bytes.toString('ascii', 0, 6) === '#!AMR\n') return 'audio/amr';
  if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return 'audio/aac';
  if (bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))
    return 'audio/mpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE')
    return 'audio/wav';
  if (bytes.toString('ascii', 0, 4) === 'fLaC') return 'audio/flac';
  if (bytes.readUInt32BE(0) === 0x1a45dfa3) return 'audio/webm';
}
const exactBinary = (value: unknown, size: number) =>
  value instanceof Uint8Array && value.byteLength === size
    ? Buffer.from(value).toString('base64')
    : undefined;
function privateWrapper(msg?: WAMessage['message']) {
  return (
    msg?.ephemeralMessage ||
    msg?.viewOnceMessage ||
    msg?.viewOnceMessageV2 ||
    msg?.viewOnceMessageV2Extension
  );
}
function mediaProto(message?: WAMessage): { kind: Kind; value: MediaProto } | undefined {
  const raw = message?.message;
  if (
    !raw ||
    privateWrapper(raw) ||
    Number((message as { ephemeralDuration?: number })?.ephemeralDuration) > 0
  )
    return;
  const content = raw.deviceSentMessage?.message || raw;
  if (privateWrapper(content)) return;
  const inner = content.documentWithCaptionMessage?.message || content;
  if (privateWrapper(inner)) return;
  const selected = inner.imageMessage
    ? { kind: 'image' as const, value: inner.imageMessage }
    : inner.videoMessage
      ? { kind: 'video' as const, value: inner.videoMessage }
      : inner.ptvMessage
        ? { kind: 'video' as const, value: inner.ptvMessage }
        : inner.audioMessage
          ? {
              kind: inner.audioMessage.ptt ? ('voice' as const) : ('audio' as const),
              value: inner.audioMessage,
            }
          : inner.documentMessage
            ? { kind: 'document' as const, value: inner.documentMessage }
            : inner.stickerMessage
              ? { kind: 'sticker' as const, value: inner.stickerMessage }
              : undefined;
  if (
    selected &&
    !(selected.value as MediaProto).viewOnce &&
    !selected.value.contextInfo?.expiration
  )
    return selected;
}
export const attachmentLabel = (kind: Kind) =>
  ({
    image: 'Photo',
    video: 'Video',
    audio: 'Audio',
    voice: 'Voice message',
    document: 'Document',
    sticker: 'Sticker',
  })[kind];
function safeFilename(name: string | null | undefined): string | undefined {
  if (typeof name !== 'string') return;
  return (
    name
      .replace(/[\\/\x00-\x1f\x7f]/g, '_')
      .trim()
      .slice(0, 180) || undefined
  );
}
export function attachmentFromRecord(record: unknown): ChatAttachment | undefined {
  if (!record || typeof record !== 'object') return;
  const value = record as Partial<ChatAttachment>;
  if (!value.kind || !Object.hasOwn(sizeLimit, value.kind)) return;
  const name = value.kind === 'document' ? safeFilename(value.name) : undefined;
  const mime =
    typeof value.mime === 'string' &&
    /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(value.mime) &&
    value.mime.length <= 100
      ? value.mime.toLowerCase()
      : undefined;
  return {
    kind: value.kind,
    available: value.available === true,
    ...(mime ? { mime } : {}),
    ...(name ? { name } : {}),
  };
}
export function describePersonalAttachment(message?: WAMessage): Captured | undefined {
  const selected = mediaProto(message);
  if (!selected) return;
  const { kind, value } = selected;
  const key = exactBinary(value.mediaKey, 32);
  const hash = exactBinary(value.fileSha256, 32);
  const length = Number(value.fileLength);
  const size = Number.isSafeInteger(length) && length > 0 ? length : undefined;
  const urls = mediaUrls(value);
  const thumb = value.jpegThumbnail;
  const thumbnail =
    (kind === 'image' || kind === 'sticker') &&
    thumb &&
    thumb.length <= maxThumbnailBytes &&
    mimeFromBytes(Buffer.from(thumb), 'image') === 'image/jpeg'
      ? Buffer.from(thumb).toString('base64')
      : undefined;
  const source: Source | undefined =
    key && urls.length && (!size || size <= sizeLimit[kind])
      ? {
          urls,
          key,
          ...(hash ? { hash } : {}),
          ...(size ? { size } : {}),
          mediaType: kind === 'voice' ? 'audio' : kind,
        }
      : undefined;
  const name = kind === 'document' ? safeFilename(value.fileName) : undefined;
  const attachment = attachmentFromRecord({
    kind,
    mime: value.mimetype?.split(';')[0],
    name,
    available: !!(source || thumbnail),
  })!;
  return {
    attachment,
    ...(source || thumbnail ? { media: { kind, source, thumbnail, name } } : {}),
    caption: typeof value.caption === 'string' ? value.caption.slice(0, 4096) : '',
  };
}
// Legacy image records remain readable until WhatsApp resends their history.
export function oldPersonalImage(image?: PersonalImage): PersonalMedia | undefined {
  if (!image || (!image.source && !image.thumbnail)) return;
  return {
    kind: 'image',
    source: image.source
      ? { ...image.source, urls: [image.source.url], mediaType: 'image' }
      : undefined,
    thumbnail: image.thumbnail,
  };
}
// Preserve the earlier enriched descriptor when a subsequent phone sync omits its media keys.
export function mergePersonalMedia(
  previous: PersonalMedia | undefined,
  next: PersonalMedia | undefined,
) {
  if (!next || !previous || next.kind !== previous.kind) return next || previous;
  return {
    ...previous,
    ...next,
    source: next.source || previous.source,
    thumbnail: next.thumbnail || previous.thumbnail,
  };
}

type MediaResult = { bytes: Buffer; mime: string; preview?: boolean };
let activeDownloads = 0,
  activeBytes = 0;
async function fetchProtectedMedia(
  kind: Kind,
  source: Source,
  send: typeof fetch,
  requestSignal?: AbortSignal,
): Promise<MediaResult | undefined> {
  if (!Array.isArray(source.urls) || !Object.hasOwn(sizeLimit, kind)) return;
  const key = Buffer.from(source.key || '', 'base64');
  const hash = Buffer.from(source.hash || '', 'base64');
  if (
    key.byteLength !== 32 ||
    (source.hash && hash.byteLength !== 32) ||
    source.mediaType !== (kind === 'voice' ? 'audio' : kind)
  )
    return;
  if (
    source.size !== undefined &&
    (!Number.isSafeInteger(source.size) || source.size <= 0 || source.size > sizeLimit[kind])
  )
    return;
  const limit = Math.min(
    source.size ? source.size + (hash.length ? 64 * 1024 : 0) : sizeLimit[kind],
    sizeLimit[kind],
  );
  const budget = limit + 26;
  if (activeDownloads >= 6 || activeBytes + budget > transferBudget) return;
  activeDownloads++;
  activeBytes += budget;
  const timeout = AbortSignal.timeout(12000);
  const signal = requestSignal ? AbortSignal.any([timeout, requestSignal]) : timeout;
  try {
    for (const value of source.urls.slice(0, 2)) {
      const url = typeof value === 'string' ? approvedMediaUrl(value) : undefined;
      if (!url || signal.aborted) continue;
      try {
        const response = await send(url, {
          redirect: 'error',
          signal,
          cache: 'no-store',
          headers: { Origin: 'https://web.whatsapp.com' },
        });
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          continue;
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let read = 0;
        let tooLarge = false;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            read += value.byteLength;
            if (read > budget) {
              tooLarge = true;
              break;
            }
            chunks.push(value);
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        if (tooLarge || read <= 10 || (read - 10) % 16 !== 0) continue;
        const encrypted = Buffer.concat(chunks, read);
        const { getMediaKeys } = await import('@whiskeysockets/baileys');
        const { iv, cipherKey, macKey } = await getMediaKeys(key, source.mediaType);
        if (!macKey) continue;
        const ciphertext = encrypted.subarray(0, -10);
        const mac = createHmac('sha256', macKey)
          .update(iv)
          .update(ciphertext)
          .digest()
          .subarray(0, 10);
        if (!timingSafeEqual(mac, encrypted.subarray(-10))) continue;
        const aes = createDecipheriv('aes-256-cbc', cipherKey, iv);
        const bytes = Buffer.concat([aes.update(ciphertext), aes.final()]);
        if (
          bytes.length > limit ||
          (hash.length
            ? !timingSafeEqual(createHash('sha256').update(bytes).digest(), hash)
            : !!source.size && bytes.length !== source.size)
        )
          continue;
        const mime = mimeFromBytes(bytes, kind);
        if (mime) return { bytes, mime };
      } catch {
        // Retry the separately provided direct path if a valid provider URL expired.
      }
    }
  } finally {
    activeDownloads--;
    activeBytes -= budget;
  }
}
export async function personalMediaBytes(
  media: PersonalMedia,
  send: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  if (!media || signal?.aborted) return;
  if (media.source) {
    const original = await fetchProtectedMedia(media.kind, media.source, send, signal);
    if (original) return original;
  }
  if (
    !['image', 'sticker'].includes(media.kind) ||
    !media.thumbnail ||
    media.thumbnail.length > Math.ceil(maxThumbnailBytes / 3) * 4
  )
    return;
  const bytes = Buffer.from(media.thumbnail, 'base64');
  if (bytes.length <= maxThumbnailBytes && mimeFromBytes(bytes, 'image') === 'image/jpeg')
    return { bytes, mime: 'image/jpeg', preview: true };
}
export function isPersonalPhoto(message: WAMessage) {
  return mediaProto(message)?.kind === 'image';
}
export function capturePersonalImage(message: WAMessage): PersonalImage | undefined {
  const media = describePersonalAttachment(message)?.media;
  if (media?.kind !== 'image') return;
  const source =
    media.source && media.source.hash && media.source.size
      ? {
          url: media.source.urls[0],
          key: media.source.key,
          hash: media.source.hash,
          size: media.source.size,
        }
      : undefined;
  return source || media.thumbnail ? { source, thumbnail: media.thumbnail } : undefined;
}
export async function personalImageBytes(
  image: PersonalImage,
  send: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  const media = oldPersonalImage(image);
  if (media) return personalMediaBytes(media, send, signal);
}
