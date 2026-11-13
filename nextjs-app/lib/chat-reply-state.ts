import type { ChatReplyBlock } from './chat-types';

export function metaTestSender(phone: string, name = ''): boolean {
  return /^1555\d{7}$/.test(phone.replace(/\D/g, '')) || /\btest\s+(number|phone)\b/i.test(name);
}
export function replyBlockFor(input: {
  configured: boolean;
  windowOpen: boolean;
  hasInbound: boolean;
  reason?: string | null;
  senderPhone?: string | null;
}): ChatReplyBlock | null {
  if (!input.configured)
    return {
      code: 'CONNECTION_REQUIRED',
      title: 'API connection needs attention',
      message: input.reason || 'Verify your WhatsApp connection before replying through the API.',
    };
  if (input.windowOpen) return null;
  if (!input.hasInbound)
    return {
      code: 'CUSTOMER_MESSAGE_REQUIRED',
      title: 'Waiting for the customer’s first API message',
      message: `This customer has not messaged the connected API number${input.senderPhone ? ` (${input.senderPhone})` : ''} yet. Ask them to send a new message or reply to that number. Then you can reply here for 24 hours. Starting a chat through the API requires an approved template.`,
    };
  return {
    code: 'REPLY_WINDOW_EXPIRED',
    title: 'The 24-hour API reply window has closed',
    message:
      'Ask the customer for a new message to the connected API number to reopen replies. Outside this window, the API requires an approved template. You can also continue manually in the WhatsApp app.',
  };
}
