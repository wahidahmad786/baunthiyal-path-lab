import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
test('setup generates private secrets without printing or rotating them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bpl-setup-'));
  try {
    writeFileSync(
      join(dir, '.env.example'),
      'APP_URL=http://localhost:3000\nCRON_SECRET=\nPUBLIC_RATE_LIMIT_SECRET=\nWHATSAPP_VERIFY_TOKEN=\n',
    );
    const env = { ...process.env };
    for (const key of ['CRON_SECRET', 'PUBLIC_RATE_LIMIT_SECRET', 'WHATSAPP_VERIFY_TOKEN'])
      delete env[key];
    const run = () =>
      spawnSync(process.execPath, [resolve('scripts/setup.mjs')], {
        cwd: dir,
        env,
        encoding: 'utf8',
      });
    const first = run();
    assert.equal(first.status, 0);
    const content = readFileSync(join(dir, '.env.local'), 'utf8');
    for (const key of ['CRON_SECRET', 'PUBLIC_RATE_LIMIT_SECRET', 'WHATSAPP_VERIFY_TOKEN']) {
      const value = content.match(new RegExp('^' + key + '=(.*)$', 'm'))![1];
      assert.ok(value.length >= 32);
      assert.ok(!first.stdout.includes(value));
    }
    assert.equal(statSync(join(dir, '.env.local')).mode & 0o777, 0o600);
    assert.equal(run().status, 0);
    assert.equal(readFileSync(join(dir, '.env.local'), 'utf8'), content);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('scheduler setup does not mutate cloud state without explicit application and validates the target', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bpl-schedule-'));
  try {
    const env = {
      ...process.env,
      FIREBASE_PROJECT_ID: 'bpl-test-project',
      SCHEDULER_REGION: 'asia-south1',
      SCHEDULER_SERVICE_ACCOUNT: 'worker@bpl-test-project.iam.gserviceaccount.com',
      APP_URL: 'https://lab.example',
      WORKER_OIDC_AUDIENCE: 'https://lab.example/api/worker',
    };
    const result = spawnSync(process.execPath, [resolve('scripts/setup-scheduler.mjs')], {
      cwd: dir,
      env,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"mode": "plan"/);
    assert.match(result.stdout, /"oidcToken"/);
    assert.match(result.stdout, /No cloud resources changed/);
    const invalid = spawnSync(process.execPath, [resolve('scripts/setup-scheduler.mjs')], {
      cwd: dir,
      env: { ...env, WORKER_OIDC_AUDIENCE: 'https://other.example' },
      encoding: 'utf8',
    });
    assert.notEqual(invalid.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
