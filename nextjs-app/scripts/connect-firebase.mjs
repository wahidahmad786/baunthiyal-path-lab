import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { GoogleAuth } from 'google-auth-library';
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const number = process.env.FIREBASE_PROJECT_NUMBER;
if (!/^\d{6,20}$/.test(number || '')) {
  console.error('Set the confirmed FIREBASE_PROJECT_NUMBER first.');
  process.exit(2);
}
const credentialOptions =
  process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY
    ? {
        credentials: {
          client_email: process.env.FIREBASE_CLIENT_EMAIL,
          private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        },
      }
    : {};
let project;
try {
  const client = await new GoogleAuth({
    ...credentialOptions,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  }).getClient();
  project = (
    await client.request({ url: `https://firebase.googleapis.com/v1beta1/projects/${number}` })
  ).data;
  if (String(project.projectNumber) !== number || !project.projectId)
    throw Error('Project mismatch');
  const values = {
    FIREBASE_PROJECT_ID: project.projectId,
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: project.projectId,
  };
  if (project.resources?.storageBucket)
    values.FIREBASE_STORAGE_BUCKET = project.resources.storageBucket;
  const apps =
    (
      await client.request({
        url: `https://firebase.googleapis.com/v1beta1/projects/${project.projectId}/webApps?pageSize=100`,
      })
    ).data.apps || [];
  const app = process.env.FIREBASE_WEB_APP_ID
    ? apps.find((a) => a.appId === process.env.FIREBASE_WEB_APP_ID)
    : apps.length === 1
      ? apps[0]
      : undefined;
  if (app) {
    const config = (
      await client.request({ url: `https://firebase.googleapis.com/v1beta1/${app.name}/config` })
    ).data;
    if (config.projectId !== project.projectId) throw Error('Web app project mismatch');
    if (config.apiKey) values.NEXT_PUBLIC_FIREBASE_API_KEY = config.apiKey;
    if (config.authDomain) values.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN = config.authDomain;
    if (config.storageBucket) values.FIREBASE_STORAGE_BUCKET = config.storageBucket;
  }
  let text = existsSync('.env.local') ? readFileSync('.env.local', 'utf8') : '';
  for (const [key, value] of Object.entries(values)) {
    const line = key + '=' + JSON.stringify(value);
    text = new RegExp('^' + key + '=.*$', 'm').test(text)
      ? text.replace(new RegExp('^' + key + '=.*$', 'm'), line)
      : text + '\n' + line + '\n';
  }
  writeFileSync('.env.local', text, { mode: 0o600 });
  chmodSync('.env.local', 0o600);
  console.log(
    'Verified Firebase project number and saved its actual Project ID and available public configuration.',
  );
  if (!app)
    console.log(
      apps.length
        ? 'Multiple existing web apps found; set FIREBASE_WEB_APP_ID to select the correct one.'
        : 'No existing web app found. Register/select a web app in the existing project before configuring login.',
    );
  console.log(
    'No cloud resources, security rules, users, patient records or campaigns were changed.',
  );
} catch {
  console.error(
    'Firebase project discovery is blocked: authenticate with the project owner account or configure an authorized Google credential. The project number alone does not grant access. No secret values were printed.',
  );
  process.exitCode = 2;
}
