import { z } from 'zod';
export const offerTypes = [
  'Percentage Discount',
  'Fixed Amount Discount',
  'Full Body Checkup',
  'Festival Offer',
  'Seasonal Offer',
  'Senior Citizen Offer',
  'New Customer Offer',
  'Repeat Customer Offer',
  'Referral Offer',
] as const;
export const audienceTypes = [
  'all',
  'existing',
  'last_visit',
  'test_history',
  'groups',
  'manual',
] as const;
export const offerSchema = z
  .object({
    title: z.string().trim().min(3).max(120),
    description: z.string().trim().min(5).max(1500),
    type: z.enum(offerTypes),
    discountType: z.enum(['percentage', 'fixed']),
    discountValue: z.number().positive(),
    originalPrice: z.number().int().positive().max(100000000),
    startsAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    testIds: z.array(z.string().min(1).max(100)).min(1).max(100),
    eligibility: z.enum(['all', 'senior', 'new', 'repeat', 'referral']).default('all'),
  })
  .superRefine((v, c) => {
    if (Date.parse(v.expiresAt) <= Date.parse(v.startsAt))
      c.addIssue({
        code: 'custom',
        message: 'Expiry must follow the start date',
        path: ['expiresAt'],
      });
    if (v.discountType === 'percentage' && v.discountValue > 100)
      c.addIssue({
        code: 'custom',
        message: 'Percentage cannot exceed 100',
        path: ['discountValue'],
      });
    if (v.discountType === 'fixed' && v.discountValue > v.originalPrice)
      c.addIssue({
        code: 'custom',
        message: 'Discount exceeds original price',
        path: ['discountValue'],
      });
  });
export type OfferInput = z.infer<typeof offerSchema>;
export type Offer = OfferInput & {
  id: string;
  offerPrice: number;
  createdAt: string;
  usedCount: number;
};
export const campaignSchema = z.object({
  name: z.string().trim().min(3).max(120),
  type: z.enum(['Health package', 'Festival', 'Seasonal', 'Retention', 'Referral', 'Custom']),
  offerId: z.string().min(1).max(100),
  templateId: z.string().max(200).default(''),
  variables: z
    .record(
      z.string(),
      z.enum([
        'customer_name',
        'offer_title',
        'original_price',
        'offer_price',
        'expiry_date',
        'lab_phone',
        'booking_link',
        'preferences_link',
      ]),
    )
    .default({}),
  audience: z.object({
    type: z.enum(audienceTypes),
    from: z.string().optional(),
    to: z.string().optional(),
    testIds: z.array(z.string()).default([]),
    groups: z.array(z.string()).default([]),
    customerIds: z.array(z.string()).max(1000).default([]),
  }),
  scheduledAt: z.iso.datetime().nullable().default(null),
  bannerPath: z.string().max(500).default(''),
});
export type CampaignInput = z.infer<typeof campaignSchema>;
export type Campaign = CampaignInput & {
  id: string;
  status: 'draft' | 'scheduled' | 'preparing' | 'running' | 'paused' | 'completed' | 'expired';
  createdAt: string;
  updatedAt: string;
  trackingToken: string;
  audienceSize: number;
  processed: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  unknown: number;
  spend: number;
  responses: number;
  bookings: number;
  confirmed: number;
  revenue: number;
  lastError?: string;
};
export type Customer = {
  id: string;
  name: string;
  phone: string;
  createdAt: string;
  lastVisitAt?: string;
  testIds: string[];
  groups: string[];
  marketing: { status: 'opted_in' | 'opted_out' | 'not_asked'; at: string; source: string };
  age?: number;
  visits?: number;
  referralCode?: string;
};
export type Template = {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  body: string;
  header?: string;
  headerText?: string;
  footer?: string;
  buttons?: { type: string; text: string; url?: string }[];
};
export type Booking = {
  id: string;
  campaignId: string;
  offerId: string;
  name: string;
  phone: string;
  createdAt: string;
  status: 'requested' | 'confirmed' | 'cancelled';
  jobId?: string;
};
export function finalPrice(original: number, kind: 'percentage' | 'fixed', value: number) {
  return Math.max(
    0,
    original - (kind === 'percentage' ? Math.round((original * value) / 100) : Math.round(value)),
  );
}
export function normalizePhone(raw: string) {
  const phone = raw.replace(/[\s()+-]/g, '');
  const p = phone.length === 10 ? '91' + phone : phone;
  if (!/^[1-9]\d{7,14}$/.test(p)) throw new Error('Enter a valid phone number with country code');
  return p;
}
export function eligible(customer: Customer, audience: CampaignInput['audience']) {
  if (customer.marketing?.status !== 'opted_in') return false;
  switch (audience.type) {
    case 'existing':
      return (customer.visits || 0) > 0;
    case 'last_visit':
      return (
        !!customer.lastVisitAt &&
        (!audience.from || customer.lastVisitAt >= audience.from) &&
        (!audience.to || customer.lastVisitAt <= audience.to + 'T23:59:59.999Z')
      );
    case 'test_history':
      return audience.testIds.some((id) => customer.testIds?.includes(id));
    case 'groups':
      return audience.groups.some((g) => customer.groups?.includes(g));
    case 'manual':
      return audience.customerIds.includes(customer.id);
    default:
      return true;
  }
}
export function offerEligible(offer: Offer, customer: Customer) {
  switch (offer.eligibility) {
    case 'senior':
      return (customer.age || 0) >= 60;
    case 'new':
      return (customer.visits || 0) === 0;
    case 'repeat':
      return (customer.visits || 0) > 0;
    case 'referral':
      return !!customer.referralCode;
    default:
      return true;
  }
}
export function templateParameters(body: string) {
  return [...new Set([...body.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)].map((m) => m[1]))];
}
export function renderTemplate(body: string, params: Record<string, string>) {
  return body.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, key) => params[key] ?? `{{${key}}}`);
}
export const deliveryRank: Record<string, number> = {
  queued: 0,
  sending: 1,
  accepted: 2,
  sent: 3,
  failed: 3,
  delivered: 4,
  read: 5,
};
export function shouldUpdateDelivery(current: string, incoming: string) {
  return incoming === 'failed'
    ? ['sending', 'accepted', 'sent'].includes(current)
    : (deliveryRank[incoming] ?? -1) > (deliveryRank[current] ?? -1);
}
export function calculateROI(revenue: number, spend: number) {
  return spend > 0 ? Math.round(((revenue - spend) / spend) * 100) : null;
}
