import 'server-only';
import { readFileSync } from 'node:fs';

export function accountEnvironment(includeServiceIdentity = false) {
  return {
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || '',
    encryptionKey: process.env.WHATSAPP_CONNECTION_ENCRYPTION_KEY || '',
    graphVersion: process.env.WHATSAPP_GRAPH_VERSION,
    appOrigin: process.env.APP_URL,
    authOrigin: process.env.FIREBASE_AUTH_EMULATOR_HOST
      ? `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com`
      : undefined,
    firestoreOrigin: process.env.FIRESTORE_EMULATOR_HOST
      ? `http://${process.env.FIRESTORE_EMULATOR_HOST}`
      : undefined,
    serviceAccountJson: includeServiceIdentity
      ? process.env.WHATSAPP_SERVICE_ACCOUNT_JSON ||
        (process.env.WHATSAPP_SERVICE_ACCOUNT_FILE
          ? readFileSync(process.env.WHATSAPP_SERVICE_ACCOUNT_FILE, 'utf8')
          : '')
      : '',
    webhookBaseUrl: process.env.WHATSAPP_WEBHOOK_BASE_URL,
    webhookPublicReady: process.env.WHATSAPP_WEBHOOK_PUBLIC_READY === 'true',
  };
}
