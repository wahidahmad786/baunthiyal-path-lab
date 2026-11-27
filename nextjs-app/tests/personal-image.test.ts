import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, createHmac } from 'node:crypto';
import type { WAMessage } from '@whiskeysockets/baileys';
import {
  capturePersonalImage,
  describePersonalAttachment,
  personalImageBytes,
  personalMediaBytes,
} from '../lib/personal-image';
import { handleAccountChat } from '../lib/account-chat-api';
import { personalMessageFrom } from '../lib/personal-history';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const key = Buffer.alloc(32, 5);
const imageMessage = {
  mediaKey: key,
  fileSha256: createHash('sha256').update(png).digest(),
  fileLength: png.length,
  directPath: '/v/t62/test-image?test=1',
  url: 'https://mmg.whatsapp.net/v/t62/test-image?test=1',
  caption: 'Synthetic photo',
};
function message(content: WAMessage['message']): WAMessage {
  return {
    key: { id: 'photo-test', fromMe: false, remoteJid: '12025550123@s.whatsapp.net' },
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: content,
  } as WAMessage;
}
async function encrypted(
  bytes = png,
  mediaType: 'image' | 'video' | 'audio' | 'document' | 'sticker' = 'image',
) {
  const { getMediaKeys } = await import('@whiskeysockets/baileys');
  const { iv, cipherKey, macKey } = await getMediaKeys(key, mediaType);
  const cipher = createCipheriv('aes-256-cbc', cipherKey, iv);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([
    ciphertext,
    createHmac('sha256', macKey!).update(iv).update(ciphertext).digest().subarray(0, 10),
  ]);
}
test('linked photo uses approved CDN, forbids redirects and verifies full encrypted bytes', async () => {
  const captured = capturePersonalImage(message({ imageMessage }));
  assert.ok(captured);
  const ciphertext = await encrypted();
  const send: typeof fetch = async (url, init) => {
    assert.equal(String(url), 'https://mmg.whatsapp.net/v/t62/test-image?test=1');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    return new Response(new Uint8Array(ciphertext));
  };
  const result = await personalImageBytes(captured, send);
  assert.equal(result?.mime, 'image/png');
  assert.deepEqual(result?.bytes, png);
  ciphertext[0] ^= 0xff;
  assert.equal(await personalImageBytes(captured, send), undefined);
});
test('private and oversized photos and forged provider locations do not gain a full image URL', async () => {
  assert.equal(
    capturePersonalImage(message({ imageMessage: { ...imageMessage, viewOnce: true } })),
    undefined,
  );
  assert.equal(
    capturePersonalImage(message({ ephemeralMessage: { message: { imageMessage } } })),
    undefined,
  );
  assert.equal(
    capturePersonalImage(
      message({ imageMessage: { ...imageMessage, fileLength: 17 * 1024 * 1024 } }),
    ),
    undefined,
  );
  assert.equal(
    capturePersonalImage(
      message({
        imageMessage: { ...imageMessage, directPath: null, url: 'https://evil.test/v/ab' },
      }),
    ),
    undefined,
  );
  const historical = await personalMessageFrom(message({ imageMessage }), '12025550123', (v) => v);
  assert.equal(historical?.type, 'image');
  assert.equal(historical?.text, 'Synthetic photo');
  assert.ok(historical?.personalMedia);
});
test('photo bytes require the same verified authorization as the inbox', async () => {
  const env = { apiKey: 'test', projectId: 'demo', encryptionKey: 'a'.repeat(64) };
  const noNetwork: typeof fetch = async () =>
    assert.fail('unauthorized requests may not fetch media or Firestore');
  const result = await handleAccountChat(
    new Request(
      `https://example.test/api/account/inbox/${'a'.repeat(32)}/messages/personal-${'b'.repeat(64)}/image`,
    ),
    env,
    noNetwork,
  );
  assert.equal(result.status, 401);
  assert.equal(result.headers.get('cache-control'), 'no-store');
});

test('an expired signed image URL falls back to the other approved provider location', async () => {
  const captured = describePersonalAttachment(
    message({
      imageMessage: {
        ...imageMessage,
        url: 'https://mmg.whatsapp.net/v/original',
        directPath: '/v/alternative',
        fileLength: png.length - 2,
      },
    }),
  );
  assert.ok(captured?.media);
  assert.equal(captured.attachment.available, true);
  const calls: string[] = [];
  const send: typeof fetch = async (url) => {
    calls.push(String(url));
    return calls.length === 1
      ? new Response(null, { status: 410 })
      : new Response(new Uint8Array(await encrypted()));
  };
  assert.deepEqual((await personalMediaBytes(captured.media, send))?.bytes, png);
  assert.deepEqual(calls, [
    'https://mmg.whatsapp.net/v/original',
    'https://mmg.whatsapp.net/v/alternative',
  ]);
});
test('larger embedded JPEG remains available without network; otherwise unknown-length media still requires its MAC', async () => {
  const thumbnail = Buffer.alloc(5000);
  thumbnail.set([0xff, 0xd8, 0xff]);
  const captured = describePersonalAttachment(
    message({
      imageMessage: {
        caption: 'Preview',
        jpegThumbnail: thumbnail,
      },
    }),
  );
  assert.ok(captured?.media);
  const noNetwork: typeof fetch = async () => assert.fail('thumbnail must not access CDN');
  assert.equal((await personalMediaBytes(captured.media, noNetwork))?.preview, true);

  const unbounded = describePersonalAttachment(
    message({
      imageMessage: {
        ...imageMessage,
        fileLength: undefined,
        fileSha256: undefined,
      },
    }),
  );
  assert.ok(unbounded?.media);
  const ciphertext = await encrypted();
  const send: typeof fetch = async () => new Response(new Uint8Array(ciphertext));
  assert.equal((await personalMediaBytes(unbounded.media, send))?.mime, 'image/png');
  ciphertext[ciphertext.length - 1] ^= 1;
  assert.equal(await personalMediaBytes(unbounded.media, send), undefined);
});
test('video, voice, audio, sticker and document expose the correct type and safe response MIME', async () => {
  const mp4 = Buffer.from('00000018667479706d70343200000000', 'hex');
  const ogg = Buffer.from('4f6767530000000000000000000000', 'hex');
  const wav = Buffer.from('524946460000000057415645000000', 'hex');
  const webp = Buffer.from('524946460000000057454250000000', 'hex');
  const document = Buffer.from('<html>synthetic document example</html>');
  const samples = [
    ['videoMessage', 'video', 'video', 'video/mp4', 'video/mp4', mp4],
    ['audioMessage', 'voice', 'audio', 'audio/ogg', 'audio/ogg', ogg],
    ['audioMessage', 'audio', 'audio', 'audio/wav', 'audio/wav', wav],
    ['stickerMessage', 'sticker', 'sticker', 'image/webp', 'image/webp', webp],
    ['documentMessage', 'document', 'document', 'text/html', 'application/octet-stream', document],
  ] as const;
  for (const [field, kind, mediaType, originalMime, responseMime, bytes] of samples) {
    const capture = describePersonalAttachment(
      message({
        [field]: {
          ...imageMessage,
          mimetype: originalMime,
          fileLength: bytes.length,
          fileSha256: createHash('sha256').update(bytes).digest(),
          ...(kind === 'voice' ? { ptt: true } : {}),
          ...(kind === 'document' ? { fileName: '../sample.txt' } : {}),
        },
      }),
    );
    assert.ok(capture?.media);
    assert.equal(capture.attachment.kind, kind);
    if (kind === 'document') assert.equal(capture.attachment.name, '.._sample.txt');
    const wire = await encrypted(bytes, mediaType);
    const send: typeof fetch = async () => new Response(new Uint8Array(wire));
    assert.equal((await personalMediaBytes(capture.media, send))?.mime, responseMime);
  }
  assert.equal(
    describePersonalAttachment(
      message({
        videoMessage: { ...imageMessage, viewOnce: true },
      }),
    ),
    undefined,
  );
});
