import 'server-only';
import { Template, templateParameters } from '../domain';
import { HttpError } from './auth';
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
  const res = await fetch(graphUrl(path), {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
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
  let path = `${process.env.WHATSAPP_BUSINESS_ACCOUNT_ID}/message_templates?fields=id,name,language,status,category,components&limit=100`;
  const result: Template[] = [];
  for (let page = 0; page < 10; page++) {
    const data = await graph(path);
    for (const t of data.data || []) {
      if (t.status !== 'APPROVED' || t.category !== 'MARKETING') continue;
      const cs = t.components || [];
      const body = cs.find((c: { type: string }) => c.type === 'BODY')?.text || '';
      const header = cs.find((c: { type: string }) => c.type === 'HEADER');
      const buttons = cs.find((c: { type: string }) => c.type === 'BUTTONS')?.buttons || [];
      if (header && header.format !== 'IMAGE') continue;
      if (buttons.some((b: { url?: string }) => b.url?.includes('{{'))) continue;
      result.push({
        id: t.id,
        name: t.name,
        language: t.language,
        status: t.status,
        category: t.category,
        body,
        ...(header?.format ? { header: header.format } : {}),
        buttons,
      });
    }
    const after = data.paging?.cursors?.after;
    if (!data.paging?.next || !after) break;
    path = `${process.env.WHATSAPP_BUSINESS_ACCOUNT_ID}/message_templates?fields=id,name,language,status,category,components&limit=100&after=${encodeURIComponent(after)}`;
  }
  return result;
}
export function validateTemplate(
  template: Template,
  variables: Record<string, string>,
  bannerPath: string,
) {
  if (template.status !== 'APPROVED' || template.category !== 'MARKETING')
    throw new HttpError(400, 'An approved marketing template is required');
  if (!/reply\s+STOP\b/i.test(template.body))
    throw new HttpError(400, 'The approved template must include a reply STOP opt-out instruction');
  if (
    !/Baunthiyal\s+Path\s+Lab/i.test(template.body) ||
    !/Your Health,\s*Our Priority/i.test(template.body)
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
    components.push({ type: 'header', parameters: [{ type: 'image', image: { link: imageUrl } }] });
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

export async function inspectPhone() {
  const d = await graph(
    `${process.env.WHATSAPP_PHONE_NUMBER_ID}?fields=id,verified_name,quality_rating`,
  );
  if (d.id !== process.env.WHATSAPP_PHONE_NUMBER_ID)
    throw new HttpError(503, 'WhatsApp phone ID mismatch');
  return { verified: true };
}
