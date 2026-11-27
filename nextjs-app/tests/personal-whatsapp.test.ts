import test from 'node:test';
import assert from 'node:assert/strict';
import { sealPersonal, openPersonal } from '../lib/personal-auth';
import { personalPhone } from '../lib/personal-events';
import { handleWhatsAppProvider } from '../lib/whatsapp-provider-api';
const key = 'a'.repeat(64);
test('linked-device credentials are authenticated, encrypted and bound to the Google account and key slot', () => {
  const sealed = sealPersonal('{"session":"private-signal-key"}', 'alice', 'creds', key);
  assert.ok(!JSON.stringify(sealed).includes('private-signal-key'));
  assert.equal(openPersonal(sealed, 'alice', 'creds', key), '{"session":"private-signal-key"}');
  assert.throws(() => openPersonal(sealed, 'bob', 'creds', key));
  assert.throws(() => openPersonal(sealed, 'alice', 'pre-key:1', key));
  assert.throws(() =>
    openPersonal({ ...sealed, tag: Buffer.alloc(16).toString('base64') }, 'alice', 'creds', key),
  );
  assert.throws(() => sealPersonal('secret', 'alice', 'creds', 'invalid'));
});
test('personal contact routing accepts only actual phone JIDs, never LIDs, groups, statuses or channels', () => {
  assert.equal(personalPhone('919876543210:2@s.whatsapp.net'), '919876543210');
  assert.equal(personalPhone('919876543210@s.whatsapp.net'), '919876543210');
  for (const jid of [
    '123456789012345@lid',
    '123456789@g.us',
    'status@broadcast',
    '123@newsletter',
    'garbage',
    '01234567890@s.whatsapp.net',
  ])
    assert.equal(personalPhone(jid), null);
});
test('linking endpoints reject absent identity and foreign origins before storage or WhatsApp access', async () => {
  const env = {
    projectId: 'demo-bpl',
    apiKey: 'test',
    encryptionKey: key,
    appOrigin: 'https://lab.example.test',
  };
  let calls = 0;
  const send = (async () => {
    calls++;
    throw new Error('Must not access network');
  }) as typeof fetch;
  assert.equal(
    (
      await handleWhatsAppProvider(
        new Request('https://lab.example.test/api/whatsapp/provider'),
        env,
        send,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await handleWhatsAppProvider(
        new Request('https://lab.example.test/api/whatsapp/provider', {
          method: 'POST',
          headers: { Origin: 'https://foreign.test' },
          body: '{}',
        }),
        env,
        send,
      )
    ).status,
    403,
  );
  assert.equal(calls, 0);
});
