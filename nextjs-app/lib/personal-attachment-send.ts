import { createHash } from 'node:crypto';
import type { AnyMessageContent } from '@whiskeysockets/baileys';
import { ChatError, readChatBody } from './account-chat-api';
import { z } from 'zod';

export const maxAttachmentBytes = 16 * 1024 * 1024;
const maxUploadBodyBytes = maxAttachmentBytes + 128 * 1024;
const maxCaptionLength = 1024;
const uuid = z.string().uuid();

type Kind = 'image' | 'video' | 'audio' | 'document';
type FileSpec = { kind: Kind; mime: string; signature: string };
const specs: Record<string, FileSpec> = Object.fromEntries(
  (
    [
      ['jpg jpeg', 'image', 'image/jpeg', 'jpeg'],
      ['png', 'image', 'image/png', 'png'],
      ['webp', 'image', 'image/webp', 'webp'],
      ['mp4 m4v', 'video', 'video/mp4', 'mp4'],
      ['mp3', 'audio', 'audio/mpeg', 'mp3'],
      ['ogg opus', 'audio', 'audio/ogg', 'ogg'],
      ['m4a', 'audio', 'audio/mp4', 'mp4'],
      ['aac', 'audio', 'audio/aac', 'aac'],
      ['wav', 'document', 'audio/wav', 'wav'],
      ['pdf', 'document', 'application/pdf', 'pdf'],
      ['txt', 'document', 'text/plain', 'text'],
      ['csv', 'document', 'text/csv', 'text'],
      ['doc', 'document', 'application/msword', 'ole'],
      ['xls', 'document', 'application/vnd.ms-excel', 'ole'],
      ['ppt', 'document', 'application/vnd.ms-powerpoint', 'ole'],
      [
        'docx',
        'document',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'zip',
      ],
      [
        'xlsx',
        'document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'zip',
      ],
      [
        'pptx',
        'document',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'zip',
      ],
    ] as const
  ).flatMap(([exts, kind, mime, signature]) =>
    exts.split(' ').map((ext) => [ext, { kind, mime, signature }]),
  ),
);

function matches(bytes: Buffer, signature: string) {
  const at = (offset: number, value: string) =>
    bytes.toString('ascii', offset, offset + value.length) === value;
  const hex = (value: string) =>
    bytes.subarray(0, value.length / 2).equals(Buffer.from(value, 'hex'));
  if (signature === 'jpeg') return hex('ffd8ff');
  if (signature === 'png') return hex('89504e470d0a1a0a');
  if (signature === 'webp') return at(0, 'RIFF') && at(8, 'WEBP');
  if (signature === 'mp4') return bytes.length >= 16 && at(4, 'ftyp');
  if (signature === 'mp3')
    return at(0, 'ID3') || (bytes.length > 3 && bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0);
  if (signature === 'ogg') return at(0, 'OggS');
  if (signature === 'aac')
    return bytes.length > 6 && bytes[0] === 255 && (bytes[1] & 0xf6) === 0xf0;
  if (signature === 'wav') return at(0, 'RIFF') && at(8, 'WAVE');
  if (signature === 'pdf') return at(0, '%PDF-');
  if (signature === 'ole') return hex('d0cf11e0a1b11ae1');
  if (signature === 'zip') return hex('504b0304');
  if (signature === 'text') {
    try {
      return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      );
    } catch {
      return false;
    }
  }
  return false;
}

export type UploadAttachment = {
  bytes: Buffer;
  kind: Kind;
  mime: string;
  name: string;
  caption: string;
  requestId: string;
  fingerprint: string;
};

export async function parseAttachmentUpload(request: Request): Promise<UploadAttachment> {
  const contentType = request.headers.get('content-type') || '';
  if (contentType.length > 512 || !/^multipart\/form-data\s*;/i.test(contentType))
    throw new ChatError(415, 'Choose one file to upload.');
  const body = await readChatBody(request, maxUploadBodyBytes);
  let data: FormData;
  try {
    data = await new Response(body, { headers: { 'Content-Type': contentType } }).formData();
  } catch {
    throw new ChatError(400, 'The attachment upload could not be read.');
  }
  if (
    [...data.keys()].some((key) => !['file', 'caption', 'requestId'].includes(key)) ||
    data.getAll('file').length !== 1 ||
    data.getAll('caption').length > 1 ||
    data.getAll('requestId').length !== 1
  )
    throw new ChatError(400, 'Send one attachment at a time.');
  const file = data.get('file');
  const caption = data.get('caption') ?? '';
  const requestId = uuid.safeParse(data.get('requestId'));
  if (
    !(file instanceof File) ||
    typeof caption !== 'string' ||
    caption.length > maxCaptionLength ||
    !requestId.success
  )
    throw new ChatError(
      400,
      'Choose a file, a valid request ID, and a caption of up to 1,024 characters.',
    );
  if (!file.size || file.size > maxAttachmentBytes)
    throw new ChatError(413, 'Choose a non-empty file up to 16 MB.');
  const name = file.name
    .replace(/^.*[\\/]/, '')
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim();
  if (!name || name.length > 180)
    throw new ChatError(400, 'Use a file name of up to 180 characters.');
  const ext = name.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  const spec = ext && Object.hasOwn(specs, ext) ? specs[ext] : undefined;
  const bytes = Buffer.from(await file.arrayBuffer());
  if (!spec || !matches(bytes, spec.signature))
    throw new ChatError(
      415,
      'This file type is not supported or the file content does not match its extension.',
    );
  if (spec.kind === 'audio' && caption.trim())
    throw new ChatError(400, 'Send audio without a caption. You can send the text separately.');
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([spec.kind, spec.mime, name, caption]))
    .update(bytes)
    .digest('hex');
  return {
    bytes,
    kind: spec.kind,
    mime: spec.mime,
    name,
    caption: caption.trim(),
    requestId: requestId.data,
    fingerprint,
  };
}

export function whatsappAttachmentContent(upload: UploadAttachment): AnyMessageContent {
  const { bytes, mime: mimetype, caption, name } = upload;
  if (upload.kind === 'image') return { image: bytes, mimetype, caption };
  if (upload.kind === 'video') return { video: bytes, mimetype, caption };
  if (upload.kind === 'audio') return { audio: bytes, mimetype };
  return { document: bytes, mimetype, fileName: name, caption };
}

let activeUploads = 0;
export function reserveAttachmentUpload() {
  if (activeUploads >= 2)
    throw new ChatError(429, 'The inbox is handling other uploads. Try again in a moment.');
  activeUploads++;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      activeUploads--;
    }
  };
}
