import { existsSync } from 'node:fs';
import { HttpsProxyAgent } from 'https-proxy-agent';
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const live = process.argv.includes('--live');
const has = (k) => !!process.env[k]?.trim();
const firebaseAuth =
  (has('FIREBASE_CLIENT_EMAIL') && has('FIREBASE_PRIVATE_KEY')) ||
  has('GOOGLE_APPLICATION_CREDENTIALS') ||
  process.env.FIREBASE_USE_ADC === 'true';
const fields = [
  ['Firebase project', ['FIREBASE_PROJECT_ID']],
  [
    'Firebase web app',
    [
      'NEXT_PUBLIC_FIREBASE_API_KEY',
      'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
      'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
    ],
  ],
  ['Banner storage', ['FIREBASE_STORAGE_BUCKET']],
  [
    'Meta WhatsApp account',
    [
      'WHATSAPP_ACCESS_TOKEN',
      'WHATSAPP_PHONE_NUMBER_ID',
      'WHATSAPP_BUSINESS_ACCOUNT_ID',
      'WHATSAPP_APP_SECRET',
    ],
  ],
  ['Lab contact', ['LAB_PHONE']],
  ['Estimated message rate', ['WHATSAPP_MARKETING_RATE_PAISE']],
  ['Public origin', ['APP_URL']],
];
let problems = 0;
for (const [label, keys] of fields) {
  const missing = keys.filter((k) => !has(k));
  if (missing.length) {
    problems++;
    console.log(`MISSING ${label}: ${missing.join(', ')}`);
  } else console.log(`CONFIGURED ${label} (not yet verified)`);
}
if (!firebaseAuth) {
  problems++;
  console.log(
    'MISSING Firebase server authentication: configure ADC or service-account credentials',
  );
}
for (const k of ['CRON_SECRET', 'PUBLIC_RATE_LIMIT_SECRET', 'WHATSAPP_VERIFY_TOKEN']) {
  if ((process.env[k]?.length || 0) < 32) {
    problems++;
    console.log('MISSING/INVALID ' + k + ' (minimum 32 characters)');
  } else console.log('CONFIGURED ' + k + ' (value hidden)');
}
if (
  has('FIREBASE_PROJECT_ID') &&
  has('NEXT_PUBLIC_FIREBASE_PROJECT_ID') &&
  process.env.FIREBASE_PROJECT_ID !== process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID
) {
  problems++;
  console.log('INVALID: server and browser Firebase project IDs differ');
}
if (
  has('WHATSAPP_MARKETING_RATE_PAISE') &&
  !(Number(process.env.WHATSAPP_MARKETING_RATE_PAISE) > 0)
) {
  problems++;
  console.log('INVALID: message rate must be a positive number of paise');
}
try {
  const url = new URL(process.env.APP_URL);
  if (url.protocol !== 'https:')
    console.log('LOCAL ONLY: APP_URL needs HTTPS before production deployment');
  if (url.origin !== process.env.APP_URL) {
    problems++;
    console.log('INVALID: APP_URL must be an origin without a path or trailing slash');
  }
} catch {
  problems++;
  console.log('INVALID: APP_URL');
}
if (live) {
  if (firebaseAuth && has('FIREBASE_PROJECT_ID')) {
    try {
      const { initializeApp, cert, applicationDefault, deleteApp } =
        await import('firebase-admin/app');
      const { getFirestore } = await import('firebase-admin/firestore');
      const { getAuth } = await import('firebase-admin/auth');
      const { getStorage } = await import('firebase-admin/storage');
      const app = initializeApp(
        {
          projectId: process.env.FIREBASE_PROJECT_ID,
          ...(!process.env.FIREBASE_AUTH_EMULATOR_HOST &&
          (process.env.HTTPS_PROXY || process.env.https_proxy)
            ? { httpAgent: new HttpsProxyAgent(process.env.HTTPS_PROXY || process.env.https_proxy) }
            : {}),
          storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
          credential: has('FIREBASE_PRIVATE_KEY')
            ? cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
              })
            : applicationDefault(),
        },
        'bpl-setup-check',
      );
      for (const [label, probe] of [
        ['Firestore read', () => getFirestore(app).collection('bpl_campaigns').limit(1).get()],
        ['Firebase Auth access', () => getAuth(app).listUsers(1)],
        [
          'Banner storage access',
          async () => {
            if (!has('FIREBASE_STORAGE_BUCKET')) throw Error();
            if (!(await getStorage(app).bucket().exists())[0]) throw Error();
          },
        ],
      ]) {
        try {
          await probe();
          console.log('VERIFIED ' + label);
        } catch {
          problems++;
          console.log(
            'FAILED ' + label + ' (check project, permissions and service configuration)',
          );
        }
      }
      await deleteApp(app);
    } catch {
      problems++;
      console.log('FAILED Firebase initialization (credential details hidden)');
    }
  } else console.log('SKIPPED live Firebase checks: account configuration is missing');
  if (
    ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_BUSINESS_ACCOUNT_ID'].every(has)
  ) {
    for (const [label, path] of [
      ['WhatsApp phone', process.env.WHATSAPP_PHONE_NUMBER_ID + '?fields=id,verified_name'],
      [
        'WhatsApp templates',
        process.env.WHATSAPP_BUSINESS_ACCOUNT_ID +
          '/message_templates?fields=id,status,category&limit=1',
      ],
    ]) {
      try {
        const response = await fetch(
          `https://graph.facebook.com/${process.env.WHATSAPP_GRAPH_VERSION || 'v23.0'}/${path}`,
          {
            headers: { Authorization: 'Bearer ' + process.env.WHATSAPP_ACCESS_TOKEN },
            signal: AbortSignal.timeout(15000),
          },
        );
        if (!response.ok) throw Error();
        console.log('VERIFIED ' + label);
      } catch {
        problems++;
        console.log('FAILED ' + label + ' (check token, permissions and account IDs)');
      }
    }
  } else console.log('SKIPPED live Meta checks: account configuration is missing');
  console.log('Read-only checks only. No promotional messages sent.');
}
console.log(
  problems
    ? `${problems} setup item(s) still need account details or correction.`
    : 'Configuration present. Verify live connectivity, webhook events, administrator access and scheduler before launching.',
);
process.exitCode = problems ? 2 : 0;
