import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  historyContactPhone,
  personalMessageFrom,
  personalReceiptStatus,
} from '../lib/personal-history';
const phone = '919876543219';
test('phone history never turns LID digits into phone numbers or invents delivery receipts', () => {
  assert.equal(historyContactPhone({ id: '12345678901234@lid' }), null);
  assert.equal(
    historyContactPhone({ id: '12345678901234@lid', phoneNumber: `${phone}@s.whatsapp.net` }),
    phone,
  );
  assert.equal(personalReceiptStatus(null, true), 'unknown');
  assert.equal(personalReceiptStatus(undefined, true), 'unknown');
  assert.equal(personalReceiptStatus(4, true), 'read');
  assert.equal(personalReceiptStatus(3, true), 'delivered');
});
test('historical messages retain real ids/times/direction, exclude protocol events and do not retain expired or view-once content', async () => {
  const base = {
    key: { id: 'real-provider-id', remoteJid: `${phone}@s.whatsapp.net`, fromMe: true },
    messageTimestamp: Math.floor(Date.now() / 1000) - 100,
    message: { conversation: 'A phone message' },
  };
  const message = await personalMessageFrom(base as any, phone, (v) => v);
  assert.equal(message?.direction, 'outbound');
  assert.equal(message?.status, 'unknown');
  assert.equal(message?.text, 'A phone message');
  assert.equal(message?.source, 'phone_history');
  assert.notEqual(message?.createdAt, new Date().toISOString());
  assert.equal(
    await personalMessageFrom(
      { ...base, message: { protocolMessage: { type: 5 } } } as any,
      phone,
      (v) => v,
    ),
    null,
  );
  assert.equal(
    await personalMessageFrom({ ...base, ephemeralDuration: 1 } as any, phone, (v) => v),
    null,
  );
  const once = await personalMessageFrom(
    {
      ...base,
      message: {
        viewOnceMessage: {
          message: { imageMessage: { caption: 'Do not retain view-once caption' } },
        },
      },
    } as any,
    phone,
    (v) => v.viewOnceMessage.message,
  );
  assert.ok(once?.text.includes('View-once'));
  assert.ok(!once?.text.includes('Do not retain'));
});
