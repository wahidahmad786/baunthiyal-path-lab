import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startVisiblePolling } from '../lib/visible-polling';

class TestPage extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';
  show(visible: boolean) {
    this.visibilityState = visible ? 'visible' : 'hidden';
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

test('skips hidden tabs, refreshes on return, and tears down cleanly', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = new TestPage();
  let calls = 0;
  const stop = startVisiblePolling(
    async () => {
      calls++;
    },
    100,
    page,
  );
  page.show(false);
  t.mock.timers.tick(500);
  assert.equal(calls, 0);
  page.show(true);
  assert.equal(calls, 1);
  await Promise.resolve();
  t.mock.timers.tick(100);
  assert.equal(calls, 2);
  stop();
  await Promise.resolve();
  page.show(true);
  t.mock.timers.tick(500);
  assert.equal(calls, 2);
});

test('does not overlap slow refreshes and recovers from a failed request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = new TestPage();
  let calls = 0;
  let fail = () => {};
  const stop = startVisiblePolling(
    () => {
      calls++;
      if (calls !== 1) return Promise.resolve();
      return new Promise((_, reject) => {
        fail = () => reject(new Error('temporary'));
      });
    },
    100,
    page,
  );
  t.mock.timers.tick(100);
  assert.equal(calls, 1);
  page.show(false);
  page.show(true);
  t.mock.timers.tick(1000);
  assert.equal(calls, 1);
  fail();
  await Promise.resolve();
  t.mock.timers.tick(100);
  assert.equal(calls, 2);
  stop();
});
