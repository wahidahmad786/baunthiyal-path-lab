import assert from 'node:assert/strict';
import test from 'node:test';
import { avatarContentType, handlePersonalAvatar, providerAvatarUrl } from '../lib/personal-avatar';
import type { ChatEnvironment } from '../lib/chat-types';

const env = { apiKey: 'test-api-key' } as ChatEnvironment;
const id = 'a'.repeat(32);
const path = `https://portal.example.test/api/whatsapp/chats/${id}/avatar`;

test('avatar endpoint requires auth before any external lookup', async () => {
  const neverFetch = async () => {
    throw new Error('No lookups without authorization');
  };
  const response = await handlePersonalAvatar(new Request(path), id, env, neverFetch);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('avatar endpoint rejects an alternate workspace before looking up conversations', async () => {
  const authOnly: typeof fetch = async (url) => {
    assert.equal(new URL(String(url)).hostname, 'identitytoolkit.googleapis.com');
    return Response.json({ users: [{ localId: 'owner_test', emailVerified: true }] });
  };
  const response = await handlePersonalAvatar(
    new Request(path, {
      headers: { Authorization: 'Bearer test-firebase-token', 'X-Workspace-Id': 'other' },
    }),
    id,
    env,
    authOnly,
  );
  assert.equal(response.status, 403);
});

test('avatar proxy only accepts authorized provider origins and raster image signatures', () => {
  assert.equal(
    providerAvatarUrl('https://pps.whatsapp.net/v/sample')?.hostname,
    'pps.whatsapp.net',
  );
  for (const value of [
    'http://pps.whatsapp.net/sample',
    'https://pps.whatsapp.net.attacker.test/sample',
    'https://evil@pps.whatsapp.net/sample',
    'https://pps.whatsapp.net:81/sample',
    'https://127.0.0.1/avatar',
  ])
    assert.equal(providerAvatarUrl(value), null);
  assert.equal(avatarContentType(new TextEncoder().encode('<svg>not allowed</svg>')), null);
  assert.equal(
    avatarContentType(new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    'image/jpeg',
  );
});
