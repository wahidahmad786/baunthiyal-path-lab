import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasLabAdminAccess } from '../lib/access';
test('lab access requires its scoped claim even when another app grants generic admin access', () => {
  assert.equal(hasLabAdminAccess({ bplAdmin: true }), true);
  assert.equal(hasLabAdminAccess({ admin: true }), false);
  assert.equal(hasLabAdminAccess({ role: 'admin' }), false);
  assert.equal(hasLabAdminAccess({ bplAdmin: 'true' }), false);
  assert.equal(hasLabAdminAccess({}), false);
});
