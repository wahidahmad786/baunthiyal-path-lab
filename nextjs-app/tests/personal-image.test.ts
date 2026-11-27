import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, createHmac } from 'node:crypto';
import type { WAMessage } from '@whiskeysockets/baileys';
import { capturePersonalImage, personalImageBytes } from '../lib/personal-image';
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
async function encrypted() {
  const { getMediaKeys } = await import('@whiskeysockets/baileys');
  const { iv, cipherKey, macKey } = await getMediaKeys(key, 'image');
  const cipher = createCipheriv('aes-256-cbc', cipherKey, iv);
  const ciphertext = Buffer.concat([cipher.update(png), cipher.final()]);
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
      message({ imageMessage: { ...imageMessage, fileLength: 9 * 1024 * 1024 } }),
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
  assert.ok(historical?.personalImage);
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
