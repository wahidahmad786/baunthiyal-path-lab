import 'server-only';
import { createHmac } from 'node:crypto';
import { Template, templateParameters } from '../domain';
import { HttpError } from './auth';
import { loadMarketingTemplates, MetaTemplateError } from '../meta-marketing-templates';
import { imageDetails, MAX_STORED_BANNER_BYTES } from '../banner';
export function whatsappConfigured() {
  return [
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_BUSINESS_ACCOUNT_ID',
    'WHATSAPP_APP_SECRET',
    'WHATSAPP_VERIFY_TOKEN',
  ].every((k) => !!process.env[k]);
}
function graphUrl(path: string) {
  const version = process.env.WHATSAPP_GRAPH_VERSION || 'v23.0';
  if (!/^v\d+\.\d+$/.test(version)) throw new Error('Invalid Graph API version');
  return `https://graph.facebook.com/${version}/${path}`;
}
async function graph(path: string, init: RequestInit = {}) {
  if (!whatsappConfigured()) throw new HttpError(503, 'WhatsApp Business API is not configured');
  const url = new URL(graphUrl(path));
  url.searchParams.set(
    'appsecret_proof',
    createHmac('sha256', process.env.WHATSAPP_APP_SECRET!)
      .update(process.env.WHATSAPP_ACCESS_TOKEN!)
      .digest('hex'),
  );
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
    signal: AbortSignal.timeout(20000),
    cache: 'no-store',
  });
  const data = await res.json();
  if (!res.ok) {
    const code = Number(data.error?.code);
    throw new MetaError(
      res.status,
      code,
      res.status === 429 || [4, 80007, 130429, 131048, 131056].includes(code)
        ? 'Meta messaging limit reached. Retry after checking your account limits.'
        : 'Meta rejected the request. Check the approved template and account configuration.',
    );
  }
  return data;
}
export class MetaError extends HttpError {
  constructor(
    status: number,
    public code: number,
    message: string,
  ) {
    super(status, message);
  }
}
export async function approvedTemplates(): Promise<Template[]> {
  try {
    const result = await loadMarketingTemplates(
      {
        phone: process.env.LAB_PHONE || '',
        phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
        businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '',
        appId: '',
        accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
        appSecret: process.env.WHATSAPP_APP_SECRET || '',
        verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
        verifiedAt: null,
        verifiedName: '',
      },
      process.env.WHATSAPP_GRAPH_VERSION || 'v23.0',
    );
    return result.templates;
  } catch (error) {
    if (error instanceof MetaTemplateError)
      throw new MetaError(error.status, error.code, error.message);
    throw error;
  }
}
export function validateTemplate(
  template: Template,
  variables: Record<string, string>,
  bannerPath: string,
) {
  if (template.status !== 'APPROVED' || template.category !== 'MARKETING')
    throw new HttpError(400, 'An approved marketing template is required');
  const messageText = [template.headerText || '', template.body, template.footer || ''].join('\n');
  if (!/reply\s+STOP\b/i.test(messageText))
    throw new HttpError(400, 'The approved template must include a reply STOP opt-out instruction');
  if (
    !/Baunthiyal\s+Path\s+Lab/i.test(messageText) ||
    !/Your Health,\s*Our Priority/i.test(messageText)
  )
    throw new HttpError(
      400,
      'The approved template must include Baunthiyal Path Lab and Your Health, Our Priority',
    );
  for (const key of templateParameters(template.body))
    if (!variables[key]) throw new HttpError(400, `Map template parameter ${key}`);
  if (!templateParameters(template.body).some((key) => variables[key] === 'booking_link'))
    throw new HttpError(400, 'Map a parameter to the campaign booking link to enable attribution');
  if (template.header === 'IMAGE' && !bannerPath)
    throw new HttpError(400, 'This template requires a promotional banner');
}
export async function sendTemplate(
  to: string,
  template: Template,
  values: Record<string, string>,
  imageUrl?: string,
) {
  const keys = templateParameters(template.body);
  const components: object[] = [];
  if (template.header === 'IMAGE') {
    if (!imageUrl) throw new HttpError(400, 'A banner is required');
    const image = /^meta-media:\d{5,100}$/.test(imageUrl)
      ? { id: imageUrl.slice(11) }
      : { link: imageUrl };
    components.push({ type: 'header', parameters: [{ type: 'image', image }] });
  }
  if (keys.length)
    components.push({
      type: 'body',
      parameters: keys.map((k) => ({
        type: 'text',
        text: values[k],
        ...(!/^\d+$/.test(k) ? { parameter_name: k } : {}),
      })),
    });
  const data = await graph(`${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: { name: template.name, language: { code: template.language }, components },
    }),
  });
  const id = data.messages?.[0]?.id;
  if (!id) throw new Error('Meta returned no message ID; delivery is uncertain');
  return id as string;
}

export async function uploadTemplateImage(bytes: Uint8Array, contentType: string): Promise<string> {
  if (bytes.length > MAX_STORED_BANNER_BYTES || imageDetails(bytes)?.type !== contentType)
    throw new HttpError(400, 'The campaign banner is invalid. Upload it again.');
  const body = new FormData();
  body.set('messaging_product', 'whatsapp');
  body.set(
    'file',
    new Blob([new Uint8Array(bytes)], { type: contentType }),
    contentType === 'image/png' ? 'banner.png' : 'banner.jpg',
  );
  const result = await graph(`${process.env.WHATSAPP_PHONE_NUMBER_ID}/media`, {
    method: 'POST',
    body,
  });
  if (typeof result.id !== 'string' || !/^\d{5,100}$/.test(result.id))
    throw new HttpError(502, 'Meta did not return a valid banner media ID.');
  return `meta-media:${result.id}`;
}

export async function inspectPhone() {
  const d = await graph(
    `${process.env.WHATSAPP_PHONE_NUMBER_ID}?fields=id,verified_name,quality_rating`,
  );
  if (d.id !== process.env.WHATSAPP_PHONE_NUMBER_ID)
    throw new HttpError(503, 'WhatsApp phone ID mismatch');
  return { verified: true };
}
