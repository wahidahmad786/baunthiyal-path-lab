import type { Template } from './domain';
import type { ConnectionRecord } from './whatsapp-connection';

export type MarketingTemplateResult = {
  templates: Template[];
  approvedMarketing: number;
  unsupported: number;
  reasons: string[];
  unavailableTemplates: { id: string; name: string; language: string; reasons: string[] }[];
  pendingMarketing: number;
  rejectedMarketing: number;
};

/** Only fixed, safe messages may cross the account API boundary. */
export class MetaTemplateError extends Error {
  constructor(
    public status: number,
    public code: number,
    message: string,
  ) {
    super(message);
    this.name = 'MetaTemplateError';
  }
}

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : null;
const reason = {
  invalid: 'Some approved marketing templates have incomplete template details.',
  components:
    'Some approved marketing templates use unsupported components such as carousel or flow.',
  header: 'Only image headers and fixed text headers are supported.',
  buttons: 'Only static URL, phone-number and quick-reply buttons are supported.',
  dynamicButton: 'Templates with dynamic button URLs are not supported by this sender.',
  identity: 'Approved templates must include Baunthiyal Path Lab and Your Health, Our Priority.',
  optOut: 'Approved templates must include a reply STOP instruction for promotional opt-out.',
  attribution:
    'Approved templates need a body variable that can be mapped to the campaign booking link.',
};

function apiError(httpStatus: number, error: unknown): MetaTemplateError {
  const rawCode = object(error)?.code;
  const code = typeof rawCode === 'number' && Number.isSafeInteger(rawCode) ? rawCode : 0;
  if ([190, 102, 104].includes(code))
    return new MetaTemplateError(
      409,
      code,
      `Meta rejected the saved access token (code ${code}). Replace it in WhatsApp Integration, then choose Verify & save.`,
    );
  if (httpStatus === 429 || [4, 17, 32, 613, 80007, 130429, 131048, 131056].includes(code))
    return new MetaTemplateError(
      429,
      code,
      'Meta is limiting template requests. Wait and try again later.',
    );
  if ([10, 200].includes(code) || httpStatus === 403)
    return new MetaTemplateError(
      403,
      code,
      'Meta denied access to marketing templates. Check the token permissions and WhatsApp Business Account access.',
    );
  if (code === 100)
    return new MetaTemplateError(
      400,
      code,
      'Meta could not load this WhatsApp Business Account. Check the saved account ID and token access.',
    );
  if ([1, 2].includes(code) || httpStatus >= 500)
    return new MetaTemplateError(
      503,
      code,
      'Meta is temporarily unavailable. Try loading templates again later.',
    );
  return new MetaTemplateError(
    502,
    code,
    'Meta could not load marketing templates. Check your saved account connection and try again.',
  );
}

function classify(value: ObjectValue): { template: Template | null; reasons: string[] } {
  const problems = new Set<string>();
  if (
    typeof value.id !== 'string' ||
    !value.id ||
    value.id.length > 200 ||
    typeof value.name !== 'string' ||
    !value.name ||
    value.name.length > 512 ||
    typeof value.language !== 'string' ||
    !value.language ||
    value.language.length > 32 ||
    !Array.isArray(value.components)
  )
    return { template: null, reasons: [reason.invalid] };
  const components = value.components.map(object);
  if (
    components.some(
      (component) =>
        !component || !['HEADER', 'BODY', 'FOOTER', 'BUTTONS'].includes(String(component.type)),
    )
  )
    problems.add(reason.components);
  const bodies = components.filter((component) => component?.type === 'BODY');
  const headers = components.filter((component) => component?.type === 'HEADER');
  const footers = components.filter((component) => component?.type === 'FOOTER');
  const buttonComponents = components.filter((component) => component?.type === 'BUTTONS');
  if (
    bodies.length !== 1 ||
    headers.length > 1 ||
    footers.length > 1 ||
    buttonComponents.length > 1
  )
    problems.add(reason.components);
  const body = bodies[0]?.text;
  if (typeof body !== 'string' || !body.trim() || body.length > 32768)
    return { template: null, reasons: [...problems, reason.invalid] };
  const headerText = headers[0]?.format === 'TEXT' ? headers[0]?.text : undefined;
  if (
    headers.length &&
    headers[0]?.format !== 'IMAGE' &&
    !(typeof headerText === 'string' && headerText.trim() && !/\{\{/.test(headerText))
  )
    problems.add(reason.header);
  if (footers.some((footer) => typeof footer?.text !== 'string' || /\{\{/.test(footer.text)))
    problems.add(reason.components);
  const footer = typeof footers[0]?.text === 'string' ? footers[0].text : '';
  const messageText = [headerText || '', body, footer].join('\n');
  if (
    !/Baunthiyal\s+Path\s+Lab/i.test(messageText) ||
    !/Your Health,\s*Our Priority/i.test(messageText)
  )
    problems.add(reason.identity);
  if (!/reply\s+STOP\b/i.test(messageText)) problems.add(reason.optOut);
  if (!/\{\{[a-zA-Z0-9_]+\}\}/.test(body)) problems.add(reason.attribution);

  const buttons: Array<NonNullable<Template['buttons']>[number] & { phone_number?: string }> = [];
  const rawButtons = buttonComponents[0]?.buttons;
  if (buttonComponents.length && (!Array.isArray(rawButtons) || rawButtons.length > 10))
    problems.add(reason.buttons);
  if (Array.isArray(rawButtons)) {
    for (const entry of rawButtons.slice(0, 11)) {
      const button = object(entry);
      if (
        !button ||
        !['URL', 'PHONE_NUMBER', 'QUICK_REPLY'].includes(String(button.type)) ||
        typeof button.text !== 'string' ||
        !button.text.trim() ||
        button.text.length > 80
      ) {
        problems.add(reason.buttons);
        continue;
      }
      if (button.type === 'URL') {
        if (typeof button.url !== 'string' || !button.url || button.url.length > 2048) {
          problems.add(reason.buttons);
          continue;
        }
        if (/\{\{/.test(button.url)) {
          problems.add(reason.dynamicButton);
          continue;
        }
        try {
          if (!['http:', 'https:'].includes(new URL(button.url).protocol)) {
            problems.add(reason.buttons);
            continue;
          }
        } catch {
          problems.add(reason.buttons);
          continue;
        }
        buttons.push({ type: 'URL', text: button.text, url: button.url });
      } else if (button.type === 'PHONE_NUMBER') {
        if (
          typeof button.phone_number !== 'string' ||
          !/^\+?[1-9]\d{7,14}$/.test(button.phone_number)
        ) {
          problems.add(reason.buttons);
          continue;
        }
        buttons.push({
          type: 'PHONE_NUMBER',
          text: button.text,
          phone_number: button.phone_number,
        });
      } else buttons.push({ type: 'QUICK_REPLY', text: button.text });
    }
  }
  if (problems.size) return { template: null, reasons: [...problems] };
  return {
    template: {
      id: value.id,
      name: value.name,
      language: value.language,
      status: 'APPROVED',
      category: 'MARKETING',
      body,
      ...(headers.length ? { header: String(headers[0]?.format) } : {}),
      ...(typeof headerText === 'string' ? { headerText } : {}),
      ...(footer ? { footer } : {}),
      buttons,
    },
    reasons: [],
  };
}

/** Reads actual Meta templates; approval, delivery and missing templates are never simulated. */
export async function loadMarketingTemplates(
  connection: ConnectionRecord,
  version = 'v23.0',
  send: typeof fetch = fetch,
): Promise<MarketingTemplateResult> {
  if (!/^v\d+\.\d+$/.test(version))
    throw new MetaTemplateError(400, 0, 'Choose a supported Meta Graph API version.');
  if (
    !/^\d{5,30}$/.test(connection.businessAccountId) ||
    !connection.accessToken ||
    !connection.appSecret
  )
    throw new MetaTemplateError(
      400,
      0,
      'Save and verify your WhatsApp account connection before loading templates.',
    );
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(connection.appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const proof = Array.from(
    new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(connection.accessToken))),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
  const result: MarketingTemplateResult = {
    templates: [],
    approvedMarketing: 0,
    unsupported: 0,
    reasons: [],
    unavailableTemplates: [],
    pendingMarketing: 0,
    rejectedMarketing: 0,
  };
  const reasons = new Set<string>();
  const seenTemplates = new Set<string>();
  const cursors = new Set<string>();
  let cursor = '';
  for (let page = 0; page < 10; page++) {
    const url = new URL(
      `https://graph.facebook.com/${version}/${connection.businessAccountId}/message_templates`,
    );
    url.searchParams.set('fields', 'id,name,language,status,category,components');
    url.searchParams.set('limit', '100');
    url.searchParams.set('appsecret_proof', proof);
    if (cursor) url.searchParams.set('after', cursor);
    let response: Response;
    try {
      response = await send(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${connection.accessToken}` },
        signal: AbortSignal.timeout(20000),
        cache: 'no-store',
      });
    } catch {
      throw new MetaTemplateError(
        503,
        0,
        'Unable to reach Meta. Try loading templates again later.',
      );
    }
    let data: ObjectValue | null;
    try {
      data = object(await response.json());
    } catch {
      throw new MetaTemplateError(
        502,
        0,
        'Meta returned an unreadable template response. Try again later.',
      );
    }
    if (!response.ok) throw apiError(response.status, data?.error);
    if (!data || !Array.isArray(data.data) || data.data.length > 1000)
      throw new MetaTemplateError(
        502,
        0,
        'Meta returned an incomplete template response. Try again later.',
      );
    for (const raw of data.data) {
      const template = object(raw);
      if (!template || template.category !== 'MARKETING') continue;
      if (typeof template.id === 'string') {
        if (seenTemplates.has(template.id)) continue;
        seenTemplates.add(template.id);
      }
      if (template.status !== 'APPROVED') {
        if (template.status === 'PENDING') result.pendingMarketing++;
        if (template.status === 'REJECTED') result.rejectedMarketing++;
        continue;
      }
      result.approvedMarketing++;
      const checked = classify(template);
      if (checked.template) result.templates.push(checked.template);
      else {
        result.unsupported++;
        for (const problem of checked.reasons) reasons.add(problem);
        if (
          typeof template.id === 'string' &&
          typeof template.name === 'string' &&
          typeof template.language === 'string'
        )
          result.unavailableTemplates.push({
            id: template.id.slice(0, 200),
            name: template.name.slice(0, 512),
            language: template.language.slice(0, 32),
            reasons: checked.reasons,
          });
      }
    }
    const paging = object(data.paging);
    if (!paging?.next) break;
    const nextCursor = object(paging.cursors)?.after;
    if (typeof nextCursor !== 'string' || !nextCursor || nextCursor.length > 2048) {
      reasons.add(
        'Meta did not provide a valid continuation cursor. Some templates may be missing.',
      );
      break;
    }
    if (cursors.has(nextCursor)) {
      reasons.add('Meta template pagination did not advance. Some templates may be missing.');
      break;
    }
    if (page === 9) {
      reasons.add(
        'Meta returned more than 10 pages of templates. Additional templates have not been loaded.',
      );
      break;
    }
    cursors.add(nextCursor);
    cursor = nextCursor;
  }
  result.reasons = [...reasons];
  return result;
}
