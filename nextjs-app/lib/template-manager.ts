import { z } from 'zod';
export const templateDraftSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(3)
      .max(100)
      .regex(
        /^[a-z][a-z0-9_]+$/,
        'Use lowercase letters, numbers and underscores for the template name.',
      ),
    language: z.enum(['en', 'en_US', 'en_GB', 'hi']),
    category: z.enum(['MARKETING', 'UTILITY']),
    headerType: z.enum(['NONE', 'TEXT', 'IMAGE']),
    headerText: z.string().trim().max(60),
    body: z.string().trim().min(1).max(1024),
    footer: z.string().trim().max(60),
    examples: z.array(z.string().trim().max(160)).max(10),
    bannerPath: z.string().max(300),
  })
  .strict();
export type TemplateDraftInput = z.infer<typeof templateDraftSchema>;
export type TemplateDraft = TemplateDraftInput & {
  id: string;
  revision: number;
  state: 'DRAFT' | 'SUBMITTING' | 'SUBMITTED' | 'SUBMISSION_UNKNOWN';
  metaId?: string;
  providerStatus?: string;
  lastError?: string;
  updatedAt: string;
};
export type ManagedTemplate = {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  body: string;
  headerType: string;
  headerText: string;
  footer: string;
  checkedAt: string;
  rejectedReason: string | null;
  businessAccountId: string;
};
export function positionalVariables(text: string) {
  const variables = [
    ...new Set([...text.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]))),
  ].sort((a, b) => a - b);
  const rest = text.replace(/\{\{\d+\}\}/g, '');
  if (
    rest.includes('{{') ||
    rest.includes('}}') ||
    /\{\{0\d*\}\}/.test(text) ||
    variables.length > 10 ||
    variables.some((v, i) => !Number.isSafeInteger(v) || v !== i + 1)
  )
    throw new Error('Use consecutive numbered variables: {{1}}, {{2}}, and so on.');
  return variables;
}
export function assertTemplateReady(input: TemplateDraftInput) {
  const variables = positionalVariables(input.body);
  if (variables.some((_, i) => !input.examples[i]))
    throw new Error('Add an example value for every body variable.');
  if (input.headerType === 'TEXT' && (!input.headerText || /[{}]/.test(input.headerText)))
    throw new Error('Use a fixed text header without variables.');
  if (input.headerType === 'IMAGE' && !input.bannerPath)
    throw new Error('Upload an image for the template header.');
  if (input.category === 'MARKETING') {
    const text = [input.headerType === 'TEXT' ? input.headerText : '', input.body, input.footer]
      .join(' ')
      .toLowerCase();
    if (
      !text.includes('baunthiyal path lab') ||
      !text.includes('your health, our priority') ||
      !/reply\s+stop/.test(text)
    )
      throw new Error(
        'Marketing templates must include Baunthiyal Path Lab, Your Health, Our Priority, and a Reply STOP opt-out instruction.',
      );
  }
  return variables;
}
export function templateComponents(input: TemplateDraftInput, imageHandle?: string) {
  const variables = assertTemplateReady(input);
  const components: Record<string, unknown>[] = [];
  if (input.headerType === 'TEXT')
    components.push({ type: 'HEADER', format: 'TEXT', text: input.headerText });
  if (input.headerType === 'IMAGE') {
    if (!imageHandle) throw new Error('The image sample has not been uploaded to Meta.');
    components.push({ type: 'HEADER', format: 'IMAGE', example: { header_handle: [imageHandle] } });
  }
  components.push({
    type: 'BODY',
    text: input.body,
    ...(variables.length
      ? { example: { body_text: [variables.map((_, i) => input.examples[i])] } }
      : {}),
  });
  if (input.footer) components.push({ type: 'FOOTER', text: input.footer });
  return components;
}
export const newTemplateDraft = (): TemplateDraftInput => ({
  name: '',
  language: 'en_US',
  category: 'MARKETING',
  headerType: 'NONE',
  headerText: '',
  body: 'Hello {{1}},\nGreetings from Baunthiyal Path Lab.\nExplore our latest health checkup offer.\nBook here: {{2}}',
  footer: 'Your Health, Our Priority · Reply STOP to opt out.',
  examples: ['Customer', 'https://example.com/book/offer'],
  bannerPath: '',
});
