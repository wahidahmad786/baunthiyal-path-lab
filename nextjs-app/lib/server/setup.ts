import 'server-only';
import { db, auth, bucket, now } from './firebase';
import { approvedTemplates, inspectPhone } from './whatsapp';
import { col } from './service';
import type { SetupCheck } from '../setup-types';
export async function verifyConnections() {
  const checks: SetupCheck[] = [];
  const probe = async (name: string, fn: () => Promise<unknown>, detail: string) => {
    try {
      await fn();
      checks.push({ name, status: 'verified', detail });
    } catch {
      checks.push({
        name,
        status: 'failed',
        detail:
          'Check the account configuration, permissions and service availability. Secret values are hidden.',
      });
    }
  };
  await probe(
    'Firestore',
    () => db().collection('bpl_campaigns').limit(1).get(),
    'Authenticated read succeeded. No patient data is included in this report.',
  );
  await probe(
    'Firebase Authentication',
    () => auth().listUsers(1),
    'Administrator SDK access succeeded. User records remain private.',
  );
  if (process.env.FIREBASE_STORAGE_BUCKET)
    await probe(
      'Promotional banner storage',
      async () => {
        if (!(await bucket().exists())[0]) throw Error();
      },
      'Configured bucket exists and is accessible.',
    );
  else
    checks.push({
      name: 'Promotional banner storage',
      status: 'missing',
      detail: 'Configure FIREBASE_STORAGE_BUCKET.',
    });
  const clientKeys = [
    'NEXT_PUBLIC_FIREBASE_API_KEY',
    'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
    'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
  ];
  const clientReady =
    clientKeys.every((k) => !!process.env[k]) &&
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID === process.env.FIREBASE_PROJECT_ID;
  checks.push({
    name: 'Browser sign-in configuration',
    status: clientReady ? 'verified' : 'missing',
    detail: clientReady
      ? 'Browser and server project IDs match. Public config must also be present during the build.'
      : 'Set the three public Firebase app fields to the same project and rebuild.',
  });
  if (
    process.env.WHATSAPP_ACCESS_TOKEN &&
    process.env.WHATSAPP_PHONE_NUMBER_ID &&
    process.env.WHATSAPP_BUSINESS_ACCOUNT_ID
  ) {
    await probe(
      'WhatsApp Business phone',
      () => inspectPhone(),
      'The official Meta API accepted the configured token and phone ID.',
    );
    await probe(
      'Approved marketing templates',
      async () => {
        const templates = await approvedTemplates();
        if (
          !templates.some(
            (t) => /reply\s+STOP\b/i.test(t.body) && /Baunthiyal\s+Path\s+Lab/i.test(t.body),
          )
        )
          throw Error();
      },
      'At least one approved branded template with a STOP instruction is available.',
    );
  } else
    checks.push({
      name: 'WhatsApp Business API',
      status: 'missing',
      detail: 'Configure the token, WABA ID and phone-number ID through server secrets.',
    });
  const [worker, webhook] = await Promise.all([
    col('workerStatus').doc('latest').get(),
    col('integrationStatus').doc('metaWebhook').get(),
  ]);
  const completed = worker.data()?.completedAt;
  checks.push({
    name: 'Scheduled worker activity',
    status: completed && Date.parse(completed) > Date.now() - 15 * 60000 ? 'verified' : 'waiting',
    detail: completed
      ? `Last successful worker run: ${completed}`
      : 'No successful worker run recorded. A configured credential alone does not confirm a running scheduler.',
  });
  const signedAt = webhook.data()?.lastSignedWebhookAt;
  checks.push({
    name: 'Signed Meta webhook',
    status: signedAt ? 'verified' : 'waiting',
    detail: signedAt
      ? `Last valid signed event: ${signedAt}`
      : 'Awaiting a signed Meta event. Configure the callback and subscribe in your Meta application.',
  });
  return { checkedAt: now(), checks, ready: checks.every((c) => c.status === 'verified') };
}
