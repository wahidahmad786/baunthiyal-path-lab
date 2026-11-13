/** Fixed messages only: provider error text can contain credentials or customer data. */
export function metaReplyError(code: number, uncertain = false): string {
  if ([190, 102, 104].includes(code))
    return `Meta rejected the saved access token (code ${code}). Update it in WhatsApp Integration and verify it.`;
  if (uncertain)
    return 'Meta did not confirm whether this message was accepted. Check its recorded status before sending again.';
  const messages: Record<number, string> = {
    131030:
      'This recipient is not allowed for the Meta test number. Add and verify the recipient in Meta API Setup, or complete onboarding for your real business number.',
    131047:
      'The customer’s 24-hour reply window is closed. Ask for a new customer message or use an approved template.',
    131026:
      'WhatsApp could not deliver to this recipient. Check the number and its WhatsApp availability.',
    131021: 'The sending and receiving WhatsApp numbers must be different.',
    131031: 'Meta has restricted this WhatsApp account. Review its status in WhatsApp Manager.',
    131042:
      'Meta requires account or payment eligibility checks. Review the WhatsApp account settings.',
    133010:
      'This sending number is not registered for the WhatsApp Cloud API. Complete its Meta onboarding.',
    10: 'The token is missing permission to send from this WhatsApp account. Check its messaging permissions.',
    200: 'Meta denied messaging access. Check the token’s WhatsApp account permissions.',
  };
  if (messages[code]) return `Meta code ${code}: ${messages[code]}`;
  if ([4, 17, 130429, 131048, 131056].includes(code))
    return `Meta code ${code}: A messaging limit was reached. Check account limits and wait before retrying.`;
  return `Meta rejected this message${Number.isSafeInteger(code) && code > 0 && code < 1000000000 ? ` (code ${code})` : ''}. Review the WhatsApp account and recipient details.`;
}
