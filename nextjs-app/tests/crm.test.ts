import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  templateDraftSchema,
  newTemplateDraft,
  positionalVariables,
  templateComponents,
  assertTemplateReady,
} from '../lib/template-manager';
import { handleTeam } from '../lib/team-api';
import { handleTemplateManager } from '../lib/template-manager-api';
import { handleConnectionHealth } from '../lib/connection-health-api';
import { metaFailure } from '../lib/meta-client';

test('new CRM endpoints require real identity and trusted origins before storage or provider access', async () => {
  const env = {
    projectId: 'demo-bpl',
    apiKey: 'test-only',
    encryptionKey: 'a'.repeat(64),
    appOrigin: 'https://lab.test',
  };
  let calls = 0;
  const send = (async () => {
    calls++;
    throw new Error('Unexpected external access');
  }) as typeof fetch;
  for (const [path, handle] of [
    ['team', handleTeam],
    ['templates', handleTemplateManager],
    ['connection-health', handleConnectionHealth],
  ] as const) {
    assert.equal(
      (await handle(new Request('https://lab.test/api/account/' + path), env, send)).status,
      401,
    );
    assert.equal(
      (
        await handle(
          new Request('https://lab.test/api/account/' + path, {
            method: 'POST',
            headers: { Origin: 'https://attacker.test' },
            body: '{}',
          }),
          env,
          send,
        )
      ).status,
      403,
    );
  }
  assert.equal(calls, 0);
});
test('template drafts validate names and consent wording without accepting client approval flags', () => {
  const draft = { ...newTemplateDraft(), name: 'bpl_test_offer' };
  assert.equal(templateDraftSchema.safeParse(draft).success, true);
  assert.equal(
    templateDraftSchema.safeParse({ ...draft, providerStatus: 'APPROVED' }).success,
    false,
  );
  assert.throws(
    () => assertTemplateReady({ ...draft, footer: '', body: 'Hello {{1}}' }),
    /Marketing templates/,
  );
  assert.throws(() => assertTemplateReady({ ...draft, examples: [] }), /example value/);
  assert.deepEqual(positionalVariables('{{1}} and {{1}} with {{2}}'), [1, 2]);
  for (const body of ['{{customer_name}}', '{{0}}', '{{1}} {{3}}', '{{01}}']) {
    assert.throws(() => positionalVariables(body));
  }
});
test('Meta image templates use a genuine uploaded handle and numbered variable examples', () => {
  const draft = {
    ...newTemplateDraft(),
    name: 'bpl_image_offer',
    headerType: 'IMAGE' as const,
    bannerPath: 'account-banners/owner/' + 'a'.repeat(32),
  };
  assert.throws(() => templateComponents(draft), /not been uploaded/);
  const components = templateComponents(draft, 'actual-provider-handle');
  assert.deepEqual(components[0], {
    type: 'HEADER',
    format: 'IMAGE',
    example: { header_handle: ['actual-provider-handle'] },
  });
  assert.deepEqual((components[1].example as any).body_text, [draft.examples]);
});
test('Meta failures never forward provider body, request URLs or credential strings', () => {
  assert.match(metaFailure(401, 190).message, /Reconnect/);
  assert.equal(metaFailure(503, 2).uncertain, true);
  assert.equal(metaFailure(400, 100).uncertain, false);
});
