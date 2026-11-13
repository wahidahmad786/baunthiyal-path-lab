import { existsSync } from 'node:fs';
import { GoogleAuth } from 'google-auth-library';
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const required = [
  'FIREBASE_PROJECT_ID',
  'SCHEDULER_REGION',
  'SCHEDULER_SERVICE_ACCOUNT',
  'APP_URL',
  'WORKER_OIDC_AUDIENCE',
];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error('Scheduler blocked: configure ' + missing.join(', '));
  process.exit(2);
}
const project = process.env.FIREBASE_PROJECT_ID,
  location = process.env.SCHEDULER_REGION;
if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project) || !/^[a-z]+-[a-z]+\d$/.test(location))
  throw Error('Invalid project or region');
const origin = new URL(process.env.APP_URL);
if (origin.protocol !== 'https:' || origin.origin !== process.env.APP_URL)
  throw Error('APP_URL must be a canonical HTTPS origin');
const uri = origin.origin + '/api/worker';
if (process.env.WORKER_OIDC_AUDIENCE !== uri)
  throw Error('WORKER_OIDC_AUDIENCE must equal APP_URL + /api/worker');
if (!process.env.SCHEDULER_SERVICE_ACCOUNT.endsWith('@' + project + '.iam.gserviceaccount.com'))
  throw Error('Use an existing scheduler service account in the same project');
const name = `projects/${project}/locations/${location}/jobs/bpl-campaign-worker`;
const job = {
  name,
  description: 'Baunthiyal Path Lab campaign queue worker',
  schedule: '* * * * *',
  timeZone: 'Asia/Kolkata',
  attemptDeadline: '300s',
  retryConfig: { retryCount: 0 },
  httpTarget: {
    uri,
    httpMethod: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from('{}').toString('base64'),
    oidcToken: {
      serviceAccountEmail: process.env.SCHEDULER_SERVICE_ACCOUNT,
      audience: process.env.WORKER_OIDC_AUDIENCE,
    },
  },
};
if (!process.argv.includes('--apply')) {
  console.log(JSON.stringify({ mode: 'plan', job }, null, 2));
  console.log(
    'No cloud resources changed. Add --apply after project access and server deployment are available.',
  );
  process.exit(0);
}
const client = await new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
}).getClient();
let existing;
try {
  existing = (await client.request({ url: 'https://cloudscheduler.googleapis.com/v1/' + name }))
    .data;
} catch (e) {
  if (e.response?.status !== 404)
    throw Error(
      'Cannot read scheduler configuration. Check Google authentication, API enablement and scheduler permissions.',
    );
}
if (existing?.httpTarget?.uri && existing.httpTarget.uri !== uri)
  throw Error(
    'The scheduler job name belongs to another endpoint. Existing job was left unchanged.',
  );
if (existing)
  await client.request({
    url: 'https://cloudscheduler.googleapis.com/v1/' + name,
    method: 'PATCH',
    params: { updateMask: 'description,schedule,timeZone,attemptDeadline,retryConfig,httpTarget' },
    data: job,
  });
else
  await client.request({
    url: `https://cloudscheduler.googleapis.com/v1/projects/${project}/locations/${location}/jobs`,
    method: 'POST',
    data: job,
  });
console.log(
  existing
    ? 'Scheduler updated. Existing enabled/paused state preserved.'
    : 'Scheduler created. OIDC authentication enabled.',
);
console.log(
  'No campaign was launched and no immediate job run was requested. Verify activity under Connections & setup.',
);
