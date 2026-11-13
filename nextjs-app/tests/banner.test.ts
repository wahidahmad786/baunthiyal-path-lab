import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bannerReference, imageDetails } from '../lib/banner';
import { handleAccountBanners } from '../lib/account-banners-api';
const png = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  ),
);
test('banner validation rejects active content, oversized dimensions and cross-workspace references', () => {
  assert.deepEqual(imageDetails(png), { type: 'image/png', width: 1, height: 1 });
  assert.equal(imageDetails(new TextEncoder().encode('<svg onload="alert(1)"></svg>')), null);
  const oversized = png.slice();
  new DataView(oversized.buffer).setUint32(16, 40000);
  assert.equal(imageDetails(oversized), null);
  assert.deepEqual(bannerReference('account-banners/owner-a/' + 'a'.repeat(32)), {
    uid: 'owner-a',
    id: 'a'.repeat(32),
  });
  for (const path of [
    'account-banners/../' + 'a'.repeat(32),
    'https://external.example/image.png',
    'account-banners/owner/a',
  ])
    assert.equal(bannerReference(path), null);
});
test('banner access rejects missing identity and foreign origins before storage', async () => {
  let calls = 0;
  const send = (async () => {
    calls++;
    throw new Error('Unexpected network request');
  }) as typeof fetch;
  const env = { projectId: 'demo-bpl', apiKey: 'emulator', serviceAccountJson: '' };
  assert.equal(
    (
      await handleAccountBanners(
        new Request('https://lab.test/api/account/banners/' + 'a'.repeat(32)),
        env,
        send,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await handleAccountBanners(
        new Request('https://lab.test/api/account/banners', {
          method: 'POST',
          headers: { origin: 'https://foreign.test' },
        }),
        env,
        send,
      )
    ).status,
    403,
  );
  assert.equal(calls, 0);
});
