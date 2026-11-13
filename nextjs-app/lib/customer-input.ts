import { z } from 'zod';
import { normalizePhone } from './domain';

export const customerInputSchema = z
  .object({
    name: z.string().trim().min(2, 'Enter the customer’s full name').max(120),
    phone: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .transform((value, context) => {
        try {
          return normalizePhone(value);
        } catch {
          context.addIssue({
            code: 'custom',
            message: 'Enter a valid WhatsApp number with country code',
          });
          return z.NEVER;
        }
      }),
    age: z.number().int().min(0).max(130).optional(),
    groups: z
      .array(z.string().trim().min(1).max(80))
      .max(10)
      .default([])
      .transform((values) => [...new Set(values)]),
    marketingConsent: z.boolean(),
    consentSource: z
      .string()
      .trim()
      .min(3, 'Record how the customer’s preference was obtained')
      .max(200),
  })
  .strict();

export type CustomerInput = z.infer<typeof customerInputSchema>;

export const customerConsentSchema = z
  .object({
    status: z.enum(['opted_in', 'opted_out']),
    source: z.string().trim().min(3, 'Record how the customer’s preference was obtained').max(200),
    confirmed: z.literal(true, { error: 'Confirm the customer’s preference before saving' }),
  })
  .strict();
