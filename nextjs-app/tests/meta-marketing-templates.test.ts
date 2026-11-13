import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { loadMarketingTemplates, MetaTemplateError } from '../lib/meta-marketing-templates';
import type { ConnectionRecord } from '../lib/whatsapp-connection';

const connection: ConnectionRecord = {
  phone: '+916395951791',
  phoneNumberId: '123456789',
  businessAccountId: '987654321',
  appId: '555555555',
  accessToken: 'test-only-meta-template-token',
  appSecret: 'test-only-meta-template-secret',
  verifyToken: '',
  verifiedAt: '2026-01-01T00:00:00Z',
  verifiedName: 'Baunthiyal Path Lab',
};
const body =
  'Hello {{customer_name}}, visit Baunthiyal Path Lab. Book: {{booking_link}}. Your Health, Our Priority. Reply STOP to opt out.';
const approved = (id: string, components: unknown[] = [{ type: 'BODY', text: body }]) => ({
  id,
  name: `offer_${id}`,
  language: 'en',
  category: 'MARKETING',
  status: 'APPROVED',
  components,
});

test('only actual supported approved marketing templates are returned with explicit exclusion reasons', async () => {
  const send = (async () =>
    Response.json({
      data: [
        approved('1', [
          { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['not-returned-example'] } },
          { type: 'BODY', text: body },
          { type: 'FOOTER', text: 'Your local lab' },
          {
            type: 'BUTTONS',
            buttons: [
              { type: 'URL', text: 'Our website', url: 'https://lab.example.test' },
              { type: 'PHONE_NUMBER', text: 'Call', phone_number: '+916395951791' },
              { type: 'QUICK_REPLY', text: 'Interested' },
            ],
          },
        ]),
        approved('2'),
        { ...approved('3'), status: 'PENDING' },
        { ...approved('4'), category: 'UTILITY' },
        approved('5', [
          { type: 'HEADER', format: 'TEXT', text: 'Offer' },
          { type: 'BODY', text: body },
        ]),
        approved('6', [
          { type: 'BODY', text: body },
          {
            type: 'BUTTONS',
            buttons: [{ type: 'URL', text: 'Book', url: 'https://lab.example.test/{{1}}' }],
          },
        ]),
        approved('7', [
          { type: 'BODY', text: body },
          { type: 'CAROUSEL', cards: [] },
        ]),
        approved('8', [
          { type: 'BODY', text: 'Hello {{name}}, Your Health, Our Priority. Reply STOP.' },
        ]),
        approved('9', [
          { type: 'BODY', text: 'Hello {{name}}, Baunthiyal Path Lab. Your Health, Our Priority.' },
        ]),
        approved('10', [
          { type: 'BODY', text: 'Baunthiyal Path Lab. Your Health, Our Priority. Reply STOP.' },
        ]),
        approved('11', [
          { type: 'BODY', text: body },
          {
            type: 'BUTTONS',
            buttons: [{ type: 'FLOW', text: 'Book', flow_id: 'private-flow-id' }],
          },
        ]),
      ],
    })) as typeof fetch;
  const result = await loadMarketingTemplates(connection, 'v23.0', send);
  assert.deepEqual(
    result.templates.map((template) => template.id),
    ['1', '2', '5'],
  );
  assert.equal(result.approvedMarketing, 9);
  assert.equal(result.unsupported, 6);
  assert.equal(result.pendingMarketing, 1);
  assert.equal(result.unavailableTemplates.length, 6);
  assert.ok(
    result.unavailableTemplates.some(
      (t) => t.id === '6' && t.reasons.some((r) => r.includes('dynamic button')),
    ),
  );
  assert.equal(result.templates[0].header, 'IMAGE');
  assert.equal(result.templates[0].buttons?.length, 3);
  assert.ok(result.reasons.some((reason) => reason.includes('Baunthiyal Path Lab')));
  assert.ok(result.reasons.some((reason) => reason.includes('STOP')));
  assert.ok(result.reasons.some((reason) => reason.includes('booking link')));
  assert.ok(result.reasons.some((reason) => reason.includes('dynamic button')));
  assert.ok(!JSON.stringify(result).includes('not-returned-example'));
});

test('approved fixed headers and footer branding/opt-out are respected without changing approved wording', async () => {
  const result = await loadMarketingTemplates(connection, 'v23.0', (async () =>
    Response.json({
      data: [
        approved('footer', [
          { type: 'HEADER', format: 'TEXT', text: 'Baunthiyal Path Lab' },
          { type: 'BODY', text: 'Hello {{customer_name}}, book {{booking_link}}.' },
          { type: 'FOOTER', text: 'Your Health, Our Priority. Reply STOP to opt out.' },
        ]),
        approved('variable-header', [
          { type: 'HEADER', format: 'TEXT', text: 'Offer {{1}}' },
          { type: 'BODY', text: body },
        ]),
        { ...approved('rejected'), status: 'REJECTED' },
      ],
    })) as typeof fetch);
  assert.equal(result.templates.length, 1);
  assert.equal(result.templates[0].header, 'TEXT');
  assert.equal(result.templates[0].headerText, 'Baunthiyal Path Lab');
  assert.match(result.templates[0].footer!, /Reply STOP/);
  assert.equal(result.rejectedMarketing, 1);
  assert.equal(result.unsupported, 1);
});

test('pagination rebuilds only official Graph URLs and sends credentials only in the authorization header', async () => {
  const urls: URL[] = [];
  const proof = createHmac('sha256', connection.appSecret)
    .update(connection.accessToken)
    .digest('hex');
  const send = (async (input, init) => {
    const url = new URL(String(input));
    urls.push(url);
    assert.equal(url.origin, 'https://graph.facebook.com');
    assert.equal(url.pathname, '/v23.0/987654321/message_templates');
    assert.equal(url.searchParams.get('appsecret_proof'), proof);
    assert.ok(!url.href.includes(connection.accessToken));
    assert.ok(!url.href.includes(connection.appSecret));
    assert.equal(init?.method, 'GET');
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      `Bearer ${connection.accessToken}`,
    );
    return Response.json(
      urls.length === 1
        ? {
            data: [approved('1')],
            paging: {
              next: 'https://attacker.example/steal?token=untrusted',
              cursors: { after: 'cursor /+&?' },
            },
          }
        : { data: [approved('1'), approved('2')] },
    );
  }) as typeof fetch;
  const result = await loadMarketingTemplates(connection, 'v23.0', send);
  assert.equal(urls.length, 2);
  assert.equal(urls[1].searchParams.get('after'), 'cursor /+&?');
  assert.equal(result.approvedMarketing, 2);
  assert.equal(result.templates.length, 2);
});

test('safe errors map Meta codes without exposing provider messages or credentials', async () => {
  for (const [code, status] of [
    [190, 409],
    [102, 409],
    [104, 409],
    [200, 403],
    [4, 429],
    [100, 400],
    [2, 503],
    [999, 502],
  ]) {
    const send = (async () =>
      Response.json(
        { error: { code, message: `${connection.accessToken} ${connection.appSecret}` } },
        { status: 400 },
      )) as typeof fetch;
    await assert.rejects(
      () => loadMarketingTemplates(connection, 'v23.0', send),
      (error) =>
        error instanceof MetaTemplateError &&
        error.status === status &&
        error.code === code &&
        (code !== 190 ||
          error.message ===
            'Meta rejected the saved access token (code 190). Replace it in WhatsApp Integration, then choose Verify & save.') &&
        !error.message.includes(connection.accessToken) &&
        !error.message.includes(connection.appSecret),
    );
  }
  const network = (async () => {
    throw new Error(connection.accessToken);
  }) as typeof fetch;
  await assert.rejects(
    () => loadMarketingTemplates(connection, 'v23.0', network),
    (error) =>
      error instanceof MetaTemplateError &&
      error.status === 503 &&
      !error.message.includes(connection.accessToken),
  );
});

test('template discovery is bounded and reports incomplete pagination rather than fabricating results', async () => {
  let pages = 0;
  const send = (async () => {
    pages++;
    return Response.json({
      data: [approved(String(pages))],
      paging: { next: 'https://graph.facebook.com/next', cursors: { after: `cursor-${pages}` } },
    });
  }) as typeof fetch;
  const result = await loadMarketingTemplates(connection, 'v23.0', send);
  assert.equal(pages, 10);
  assert.equal(result.templates.length, 10);
  assert.ok(result.reasons.some((reason) => reason.includes('more than 10 pages')));
  const noCall = (async () => {
    throw new Error('Must not call an invalid URL');
  }) as typeof fetch;
  await assert.rejects(
    () => loadMarketingTemplates(connection, 'v23.0/../../evil', noCall),
    MetaTemplateError,
  );
});
