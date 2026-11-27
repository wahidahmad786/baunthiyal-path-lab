import assert from 'node:assert/strict';
import test from 'node:test';
import { handleAccountChat } from '../lib/account-chat-api';
import {
  maxAttachmentBytes,
  parseAttachmentUpload,
  reserveAttachmentUpload,
  whatsappAttachmentContent,
} from '../lib/personal-attachment-send';
import type { ChatEnvironment } from '../lib/chat-types';

const requestId = '1c314084-8512-4b2c-9517-0f2602b6f7ad';
const origin = 'https://portal.example.test';
const endpoint = origin + '/api/account/inbox/' + 'a'.repeat(32) + '/send-attachment';
const env = { appOrigin: origin } as ChatEnvironment;
const fixturePng = new Uint8Array(Buffer.from('89504e470d0a1a0a0000', 'hex'));

function upload(name: string, bytes: string | Uint8Array<ArrayBuffer>, caption = '') {
  const data = new FormData();
  data.append('file', new File([bytes], name), name);
  data.append('caption', caption);
  data.append('requestId', requestId);
  return new Request(endpoint, { method: 'POST', headers: { Origin: origin }, body: data });
}
test('attachment uploads canonicalize and separate photos, videos, audio and documents', async () => {
  const png = await parseAttachmentUpload(upload('sample.png', fixturePng, ' A photo '));
  assert.equal(png.mime, 'image/png');
  assert.equal(png.kind, 'image');
  assert.equal(png.caption, 'A photo');
  const photo = whatsappAttachmentContent(png);
  assert.ok('image' in photo && photo.caption === 'A photo');
  const video = whatsappAttachmentContent(
    await parseAttachmentUpload(upload('sample.mp4', '\u0000\u0000\u0000\u0018ftypmp420000')),
  );
  assert.ok('video' in video);
  const audio = whatsappAttachmentContent(
    await parseAttachmentUpload(upload('sample.ogg', 'OggS')),
  );
  assert.ok('audio' in audio && !('caption' in audio));
  const doc = whatsappAttachmentContent(
    await parseAttachmentUpload(upload('sample.pdf', '%PDF-1.7', 'PDF sample')),
  );
  assert.ok('document' in doc && doc.fileName === 'sample.pdf');
});
test('attachment requests reject mismatches, active markup, audio captions and oversized bodies', async () => {
  await assert.rejects(parseAttachmentUpload(upload('payload.png', '<svg/>')), { status: 415 });
  await assert.rejects(parseAttachmentUpload(upload('payload.html', '<html>')), { status: 415 });
  await assert.rejects(parseAttachmentUpload(upload('sample.ogg', 'OggS', 'caption')), {
    status: 400,
  });
  const request = new Request(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'multipart/form-data; boundary=test-only',
      'content-length': String(maxAttachmentBytes * 2),
    },
  });
  await assert.rejects(parseAttachmentUpload(request), { status: 413 });
});
test('attachment retries fingerprint both file bytes and displayed details', async () => {
  const one = await parseAttachmentUpload(upload('name.txt', 'First', 'test'));
  const repeat = await parseAttachmentUpload(upload('name.txt', 'First', 'test'));
  const otherBytes = await parseAttachmentUpload(upload('name.txt', 'Second', 'test'));
  const otherName = await parseAttachmentUpload(upload('other.txt', 'First', 'test'));
  assert.equal(repeat.fingerprint, one.fingerprint);
  assert.notEqual(otherBytes.fingerprint, one.fingerprint);
  assert.notEqual(otherName.fingerprint, one.fingerprint);
});
test('attachment uploads require existing user and origin checks before provider activity', async () => {
  const neverFetch = async () => {
    throw new Error('Unauthorized requests must not reach a provider');
  };
  const noUser = await handleAccountChat(upload('sample.txt', 'test'), env, neverFetch);
  assert.equal(noUser.status, 401);
  const wrongOrigin = new Request(endpoint, {
    method: 'POST',
    headers: { Origin: 'https://elsewhere.example', Authorization: 'Bearer test-only' },
  });
  assert.equal((await handleAccountChat(wrongOrigin, env, neverFetch)).status, 403);
});
test('a bounded upload slot is released exactly once', () => {
  const releaseOne = reserveAttachmentUpload();
  const releaseTwo = reserveAttachmentUpload();
  try {
    assert.throws(reserveAttachmentUpload, { status: 429 });
    releaseOne();
    releaseOne();
    const replace = reserveAttachmentUpload();
    try {
      assert.throws(reserveAttachmentUpload, { status: 429 });
    } finally {
      replace();
    }
  } finally {
    releaseOne();
    releaseTwo();
  }
});

test('linked socket receives an explicit fixture attachment and records the resulting media', async () => {
  const { sendPersonal } = await import('../lib/personal-whatsapp');
  const { personalMessageId } = await import('../lib/personal-events');
  const { chatHash } = await import('../lib/account-chat-api');
  const uid = 'unit-outbox';
  const phone = '919876543211';
  const attachment = await parseAttachmentUpload(upload('test.png', fixturePng, 'fixture caption'));
  const providerId = 'BPLTESTATTACHMENT0';
  const chat = (await chatHash(phone)).slice(0, 32);
  const msg = await personalMessageId(phone, providerId);
  const docs = new Map<string, any>([
    [
      'personalStatus/lease',
      { holder: 'lease-test', expiresAt: new Date(Date.now() + 60000).toISOString() },
    ],
  ]);
  let sendCount = 0;
  const runtime = (
    globalThis as unknown as { bplPersonalRuntime: { sessions: Map<string, unknown> } }
  ).bplPersonalRuntime;
  const fakeStore = {
    uid,
    env: { encryptionKey: 'a'.repeat(64) },
    read: async (path: string) => (docs.has(path) ? { data: docs.get(path) } : null),
    write: (path: string, data: object) => ({ path, data }),
    commit: async (writes: { path: string; data: object }[]) => {
      for (const { path, data } of writes) docs.set(path, data);
    },
  } as unknown as import('../lib/account-chat-api').ChatStore;
  runtime.sessions.set(uid, {
    store: fakeStore,
    leaseId: 'lease-test',
    state: { status: 'connected' },
    socket: {
      async sendMessage(jid: string, content: object, options: { messageId: string }) {
        sendCount++;
        assert.equal(jid, phone + '@s.whatsapp.net');
        assert.equal(options.messageId, providerId);
        assert.deepEqual(content, {
          image: attachment.bytes,
          mimetype: 'image/png',
          caption: 'fixture caption',
        });
        return {
          key: { id: providerId },
          message: {
            imageMessage: {
              mimetype: 'image/png',
              caption: 'fixture caption',
              jpegThumbnail: Buffer.from('ffd8ff00000000000000000000', 'hex'),
            },
          },
        };
      },
    },
  });
  try {
    assert.equal(
      await sendPersonal(fakeStore, phone, attachment.caption, providerId, attachment),
      providerId,
    );
    assert.equal(sendCount, 1);
    assert.equal(docs.get(`conversations/${chat}/messages/${msg}`).attachment.available, true);
    assert.equal(docs.get(`conversations/${chat}/messages/${msg}`).text, 'fixture caption');
    assert.ok(docs.get(`personalMessageMedia/${msg}`).ciphertext);
  } finally {
    runtime.sessions.delete(uid);
  }
});
