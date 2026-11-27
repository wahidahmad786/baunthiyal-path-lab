'use client';

import { useEffect, useRef, useState } from 'react';
import {
  AudioLines,
  Download,
  FileText,
  ImageIcon,
  Paperclip,
  Sticker,
  Video,
  X,
} from 'lucide-react';
import { labClientAuth } from '@/lib/client-auth';
import type { ChatMessage } from '@/lib/chat-types';
import styles from './whatsapp-inbox.module.css';

export type InboxAttachment = {
  kind: 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker';
  mime?: string;
  name?: string;
  available: boolean;
};

const maxUploadBytes = 16 * 1024 * 1024;
const maxReceivedBytes = 24 * 1024 * 1024;
export const maxAttachmentCaption = 1024;

const acceptedFiles = {
  '.jpg': 'image',
  '.jpeg': 'image',
  '.png': 'image',
  '.webp': 'image',
  '.mp4': 'video',
  '.mp3': 'audio',
  '.ogg': 'audio',
  '.opus': 'audio',
  '.m4a': 'audio',
  '.aac': 'audio',
  '.wav': 'audio',
  '.pdf': 'document',
  '.txt': 'document',
  '.csv': 'document',
  '.doc': 'document',
  '.docx': 'document',
  '.xls': 'document',
  '.xlsx': 'document',
  '.ppt': 'document',
  '.pptx': 'document',
} as const;

export const acceptedAttachmentFiles = Object.keys(acceptedFiles).join(',');
type SendableKind = (typeof acceptedFiles)[keyof typeof acceptedFiles];

const supportedTypes: Record<string, SendableKind> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'video/mp4': 'video',
  'audio/mpeg': 'audio',
  'audio/mp3': 'audio',
  'audio/ogg': 'audio',
  'audio/opus': 'audio',
  'audio/mp4': 'audio',
  'audio/x-m4a': 'audio',
  'audio/aac': 'audio',
  'audio/wav': 'audio',
  'audio/x-wav': 'audio',
  'audio/wave': 'audio',
  'application/pdf': 'document',
  'text/plain': 'document',
  'text/csv': 'document',
  'application/csv': 'document',
  'application/msword': 'document',
  'application/vnd.ms-excel': 'document',
  'application/vnd.ms-powerpoint': 'document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'document',
};

export type AttachmentFile = { file: File; kind: SendableKind };
export function validateAttachmentFile(file: File): AttachmentFile {
  if (!file.size) throw new Error('This file is empty. Choose another file.');
  if (file.size > maxUploadBytes) throw new Error('Choose a file up to 16 MB.');
  const mime = file.type.split(';', 1)[0].toLowerCase();
  const suffix = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  const kind = Object.hasOwn(acceptedFiles, suffix)
    ? acceptedFiles[suffix as keyof typeof acceptedFiles]
    : undefined;
  const mimeKind = supportedTypes[mime];
  if (!kind || (mime && mime !== 'application/octet-stream' && mimeKind !== kind))
    throw new Error('Choose a supported photo, MP4 video, audio file, PDF, text or Office file.');
  return { file, kind };
}

const labels = {
  image: { name: 'Photo', Icon: ImageIcon, ext: 'jpg' },
  video: { name: 'Video', Icon: Video, ext: 'mp4' },
  audio: { name: 'Audio', Icon: AudioLines, ext: 'mp3' },
  voice: { name: 'Voice note', Icon: AudioLines, ext: 'ogg' },
  document: { name: 'Document', Icon: FileText, ext: 'bin' },
  sticker: { name: 'Sticker', Icon: Sticker, ext: 'webp' },
};
const MIME_IMAGE = /^image\/(jpeg|png|webp|gif|avif)$/;
const MIME_VIDEO = /^video\/(mp4|webm|quicktime|3gpp|x-m4v)$/;
const MIME_AUDIO =
  /^audio\/(ogg|opus|mpeg|mp3|mp4|x-m4a|aac|wav|x-wav|wave|vnd\.wave|webm|amr|3gpp)$/;

function mediaMime(kind: InboxAttachment['kind'], mime: string) {
  const type = mime.split(';', 1)[0].trim().toLowerCase();
  if (kind === 'image' || kind === 'sticker') return MIME_IMAGE.test(type) ? type : '';
  if (kind === 'audio' || kind === 'voice') return MIME_AUDIO.test(type) ? type : '';
  if (kind === 'video') return MIME_VIDEO.test(type) ? type : '';
  return 'application/octet-stream';
}

function downloadName(attachment: InboxAttachment) {
  const cleaned = attachment.name
    ?.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069<>:"/\\|?*]/g, '_')
    .trim()
    .slice(0, 140);
  if (attachment.kind === 'document' && cleaned && !/^\.+$/.test(cleaned)) return cleaned;
  const label = labels[attachment.kind];
  const mime = attachment.mime?.split(';')[0].toLowerCase();
  const knownExt: Record<string, string> = {
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'video/3gpp': '3gp',
    'audio/ogg': 'ogg',
    'audio/opus': 'opus',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/aac': 'aac',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/webm': 'webm',
  };
  const name = cleaned?.replace(/\.[a-z0-9]{1,10}$/i, '') || label.name;
  return name + '.' + ((mime && knownExt[mime]) || label.ext);
}

export function messageAttachment(message: ChatMessage): InboxAttachment | undefined {
  // Keep legacy image history compatible until it is re-synced with attachment metadata.
  const metadata = (message as ChatMessage & { attachment?: InboxAttachment }).attachment;
  if (metadata && Object.hasOwn(labels, metadata.kind)) return metadata;
  if (message.type === 'image') return { kind: 'image', available: !!message.imageAvailable };
}

export async function uploadInboxAttachment(
  path: string,
  file: File,
  caption: string,
  requestId: string,
) {
  const user = labClientAuth().currentUser;
  if (!user) throw new Error('Please sign in again before sending this file.');
  const body = new FormData();
  body.set('file', file);
  body.set('caption', caption);
  body.set('requestId', requestId);
  const response = await fetch(path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + (await user.getIdToken()) },
    body,
    cache: 'no-store',
    mode: 'same-origin',
    redirect: 'error',
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.message?.id || !result.message.status)
    throw new Error(result?.error || 'This file could not be confirmed as sent.');
  return result as { message: ChatMessage };
}

const requests: (() => void)[] = [];
let active = 0;
function advanceRequests() {
  while (active < 3 && requests.length) {
    active++;
    requests.shift()?.();
  }
}
function enqueueRequest(signal: AbortSignal, load: () => Promise<void>) {
  const queued = () => {
    void Promise.resolve()
      .then(() => {
        if (!signal.aborted) return load();
      })
      .finally(() => {
        active--;
        advanceRequests();
      });
  };
  requests.push(queued);
  advanceRequests();
  signal.addEventListener(
    'abort',
    () => {
      const index = requests.indexOf(queued);
      if (index >= 0) requests.splice(index, 1);
    },
    { once: true },
  );
}

function usePrivateMedia(path: string | undefined, kind: InboxAttachment['kind']) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [result, setResult] = useState<{ path: string; url?: string; preview?: boolean } | null>(
    null,
  );
  useEffect(() => {
    const element = anchor.current;
    if (!path || !element) return;
    const request = new AbortController();
    let observer: IntersectionObserver | undefined;
    let url: string | undefined;
    const load = async () => {
      try {
        const user = labClientAuth().currentUser;
        if (!user) throw new Error('Sign in required');
        const response = await fetch(path, {
          headers: { Authorization: 'Bearer ' + (await user.getIdToken()) },
          cache: 'no-store',
          mode: 'same-origin',
          redirect: 'error',
          signal: request.signal,
        });
        const mime = mediaMime(kind, response.headers.get('Content-Type') || '');
        if (
          !response.ok ||
          !mime ||
          Number(response.headers.get('Content-Length')) > maxReceivedBytes
        )
          throw new Error('Attachment unavailable');
        const blob = await response.blob();
        if (request.signal.aborted) return;
        if (blob.size <= 0 || blob.size > maxReceivedBytes)
          throw new Error('Attachment unavailable');
        url = URL.createObjectURL(blob.type === mime ? blob : blob.slice(0, blob.size, mime));
        setResult({ path, url, preview: response.headers.get('X-Media-Preview') === 'true' });
      } catch {
        if (!request.signal.aborted) setResult({ path });
      }
    };
    let scheduled = false;
    const start = () => {
      if (scheduled || request.signal.aborted) return;
      scheduled = true;
      observer?.disconnect();
      enqueueRequest(request.signal, load);
    };
    if (typeof IntersectionObserver === 'undefined') start();
    else {
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) start();
        },
        { rootMargin: '32px' },
      );
      observer.observe(element);
    }
    return () => {
      observer?.disconnect();
      request.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [path, kind]);
  return {
    anchor,
    url: result?.path === path ? result?.url : undefined,
    pending: !!path && result?.path !== path,
    preview: result?.path === path && !!result?.preview,
  };
}

export function InboxAttachmentView({
  attachment,
  path,
}: {
  attachment: InboxAttachment;
  path?: string;
}) {
  const { kind } = attachment;
  const { Icon, name } = labels[kind];
  const inline = kind === 'image' || kind === 'sticker';
  const [requested, setRequested] = useState(false);
  const [broken, setBroken] = useState('');
  const media = usePrivateMedia(inline || requested ? path : undefined, kind);
  const ready = media.url && media.url !== broken ? media.url : undefined;
  const failed = !media.pending && !!path && (inline || requested) && !media.url;
  const fileName = downloadName(attachment);
  const status = media.pending ? `Loading ${name.toLowerCase()}…` : `${name} unavailable`;
  const onPlaybackError = () => setBroken(media.url || '');
  return (
    <span className={styles.attachment} ref={media.anchor}>
      {inline && ready && (
        <a
          href={ready}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${name.toLowerCase()}`}
        >
          <img
            className={kind === 'sticker' ? styles.sticker : undefined}
            src={ready}
            alt={`WhatsApp ${name.toLowerCase()}`}
            decoding="async"
            onError={onPlaybackError}
          />
        </a>
      )}
      {inline && ready && media.preview && <small className={styles.previewLabel}>Preview</small>}
      {kind === 'video' && ready && (
        <video
          src={ready}
          controls
          playsInline
          preload="metadata"
          aria-label="WhatsApp video"
          onError={onPlaybackError}
        />
      )}
      {(kind === 'audio' || kind === 'voice') && ready && (
        <audio
          src={ready}
          controls
          preload="metadata"
          aria-label={`WhatsApp ${name.toLowerCase()}`}
          onError={onPlaybackError}
        />
      )}
      {(!path || media.pending || failed || !!broken) && !ready ? (
        <span className={styles.attachmentStatus}>
          <Icon size={17} aria-hidden="true" />
          {broken && !inline ? `${name} can’t play in this browser` : status}
        </span>
      ) : null}
      {!inline && path && !requested && (
        <button
          className={styles.attachmentAction}
          type="button"
          onClick={() => setRequested(true)}
        >
          <Icon size={18} aria-hidden="true" />
          <span>{kind === 'document' ? fileName : `Load ${name.toLowerCase()}`}</span>
        </button>
      )}
      {!inline && media.url && (
        <a className={styles.attachmentAction} href={media.url} download={fileName}>
          <Download size={16} aria-hidden="true" />
          <span>{kind === 'document' ? fileName : `Save ${name.toLowerCase()}`}</span>
        </a>
      )}
    </span>
  );
}

export function AttachmentDraftPreview({
  draft,
  disabled,
  onRemove,
}: {
  draft: AttachmentFile;
  disabled: boolean;
  onRemove: () => void;
}) {
  const { file, kind } = draft;
  const [preview, setPreview] = useState<{ file: File; url: string } | null>(null);
  useEffect(() => {
    if (kind !== 'image' || !MIME_IMAGE.test(file.type)) return;
    const url = URL.createObjectURL(file);
    setPreview({ file, url });
    return () => URL.revokeObjectURL(url);
  }, [file, kind]);
  return (
    <div className={styles.attachmentDraft}>
      {preview?.file === file ? (
        <img src={preview.url} alt="" />
      ) : (
        <Paperclip size={21} aria-hidden="true" />
      )}
      <div>
        <strong>{file.name}</strong>
        <small>
          {file.size < 1024 * 1024
            ? `${Math.max(1, Math.round(file.size / 1024))} KB`
            : `${(file.size / (1024 * 1024)).toFixed(1)} MB`}
        </small>
      </div>
      <button
        type="button"
        className={styles.iconAction}
        onClick={onRemove}
        disabled={disabled}
        aria-label="Remove attachment"
        title="Remove attachment"
      >
        <X size={20} />
      </button>
    </div>
  );
}
