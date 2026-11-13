import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metaTestSender, replyBlockFor } from '../lib/chat-reply-state';
import { metaReplyError } from '../lib/meta-reply-error';

test('test senders are shown distinctly from the real lab number', () => {
  assert.equal(metaTestSender('+1 555-186-9875', 'Test Number'), true);
  assert.equal(metaTestSender('+916395951791', 'Baunthiyal Path Lab'), false);
});
test('actual Meta rejection codes explain test recipients, reply windows and token failures without raw provider text', () => {
  assert.match(metaReplyError(131030), /verify the recipient in Meta API Setup/);
  assert.match(metaReplyError(131047), /24-hour reply window/);
  assert.match(metaReplyError(190), /access token \(code 190\)/);
  assert.match(metaReplyError(500, true), /Check its recorded status/);
  assert.ok(!metaReplyError(NaN).includes('NaN'));
});
test('verified API credentials do not imply a customer reply window', () => {
  const blocked = replyBlockFor({
    configured: true,
    windowOpen: false,
    hasInbound: false,
    senderPhone: '+15551869875',
  });
  assert.equal(blocked?.code, 'CUSTOMER_MESSAGE_REQUIRED');
  assert.match(blocked!.message, /\+15551869875/);
  assert.match(blocked!.message, /approved template/);
  assert.equal(
    replyBlockFor({ configured: true, windowOpen: false, hasInbound: true })?.code,
    'REPLY_WINDOW_EXPIRED',
  );
  assert.equal(replyBlockFor({ configured: true, windowOpen: true, hasInbound: true }), null);
  assert.equal(
    replyBlockFor({
      configured: false,
      windowOpen: true,
      hasInbound: true,
      reason: 'Credentials need verification',
    })?.code,
    'CONNECTION_REQUIRED',
  );
});
