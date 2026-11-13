// Run in a trusted admin environment: node scripts/grant-admin.mjs <Firebase-user-UID>
import { existsSync } from 'node:fs';
import { applicationDefault, initializeApp, deleteApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { HttpsProxyAgent } from 'https-proxy-agent';
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
if (!process.argv[2]) throw new Error('Pass an existing Firebase user UID');
const proxy =
  !process.env.FIREBASE_AUTH_EMULATOR_HOST && (process.env.HTTPS_PROXY || process.env.https_proxy);
const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
const app = initializeApp({
  credential: applicationDefault(),
  projectId: process.env.FIREBASE_PROJECT_ID,
  ...(agent ? { httpAgent: agent } : {}),
});
try {
  const user = await getAuth(app).getUser(process.argv[2]);
  await getAuth(app).setCustomUserClaims(user.uid, { ...user.customClaims, bplAdmin: true });
  console.log(
    'Lab administrator claim granted. Existing claims preserved. Sign in again for a fresh token.',
  );
} finally {
  await deleteApp(app);
  agent?.destroy();
}
