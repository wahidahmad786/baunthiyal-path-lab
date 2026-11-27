import { eligible, offerEligible, type Customer, type Offer } from './domain';

export function activeLinkedOffer(offer: Offer, now: number) {
  return Date.parse(offer.startsAt) <= now && now < Date.parse(offer.expiresAt);
}

export function linkedCampaignAudience(customers: Customer[], offer: Offer, now: number) {
  if (!activeLinkedOffer(offer, now)) return [];
  const seen = new Set<string>();
  return customers.filter((customer) => {
    if (
      !/^[1-9]\d{7,14}$/.test(customer.phone) ||
      seen.has(customer.phone) ||
      !eligible(customer, { type: 'all', testIds: [], groups: [], customerIds: [] }) ||
      !offerEligible(offer, customer)
    )
      return false;
    seen.add(customer.phone);
    return true;
  });
}

export function linkedCampaignChat(phone: string, message: string) {
  if (!/^[1-9]\d{7,14}$/.test(phone)) throw new Error('Invalid WhatsApp number.');
  const text = message.trim();
  if (!text || text.length > 1200) throw new Error('Enter a message of up to 1,200 characters.');
  const url = new URL('https://wa.me/' + phone);
  url.searchParams.set('text', text + '\n\nReply STOP to opt out.');
  return url.href;
}
