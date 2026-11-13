import 'server-only';
import { applicationDefault, cert, getApps, getApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getStorage } from 'firebase-admin/storage';
import { HttpsProxyAgent } from 'https-proxy-agent';
export function firebaseConfigured() {
  return (
    !!process.env.FIREBASE_PROJECT_ID &&
    ((!!process.env.FIREBASE_CLIENT_EMAIL && !!process.env.FIREBASE_PRIVATE_KEY) ||
      !!process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      process.env.FIREBASE_USE_ADC === 'true' ||
      !!process.env.FIREBASE_AUTH_EMULATOR_HOST)
  );
}
export function adminApp() {
  if (!firebaseConfigured())
    throw new Error('Firebase is not configured. Add server credentials in environment settings.');
  return (
    (getApps().some((app) => app.name === 'baunthiyal-marketing')
      ? getApp('baunthiyal-marketing')
      : undefined) ||
    initializeApp(
      {
        projectId: process.env.FIREBASE_PROJECT_ID,
        ...(!process.env.FIREBASE_AUTH_EMULATOR_HOST &&
        (process.env.HTTPS_PROXY || process.env.https_proxy)
          ? {
              httpAgent: new HttpsProxyAgent((process.env.HTTPS_PROXY || process.env.https_proxy)!),
            }
          : {}),
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
        credential: process.env.FIREBASE_PRIVATE_KEY
          ? cert({
              projectId: process.env.FIREBASE_PROJECT_ID,
              clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
              privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            })
          : applicationDefault(),
      },
      'baunthiyal-marketing',
    )
  );
}
export const db = () => getFirestore(adminApp());
export const auth = () => getAuth(adminApp());
export const bucket = () => getStorage(adminApp()).bucket();
export const now = () => new Date().toISOString();
export function publicOrigin() {
  const value = process.env.APP_URL;
  if (!value) throw new Error('APP_URL is required');
  const url = new URL(value);
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:')
    throw new Error('APP_URL must use HTTPS');
  return url.origin;
}
