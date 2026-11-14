import { GoogleAuth } from 'google-auth-library';
import { decryptConnection, type EncryptedConnection } from '../lib/whatsapp-connection';

// One-time migration before enabling Embedded Signup on an existing portal.
// Dry-run by default; reports counts only and never prints credentials or identities.
async function run() {
  const project = process.env.FIREBASE_PROJECT_ID;
  const key = process.env.WHATSAPP_CONNECTION_ENCRYPTION_KEY || '';
  if (!project || !/^[a-f0-9]{64}$/i.test(key))
    throw new Error('Missing project or connection encryption key.');
  const auth = new GoogleAuth({
    ...(process.env.WHATSAPP_SERVICE_ACCOUNT_JSON
      ? { credentials: JSON.parse(process.env.WHATSAPP_SERVICE_ACCOUNT_JSON) }
      : { keyFile: process.env.WHATSAPP_SERVICE_ACCOUNT_FILE }),
    scopes: ['https://www.googleapis.com/auth/datastore'],
  });
  const client = await auth.getClient();
  const base = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
  const owners = new Map<string, string>();
  let page = '';
  do {
    const response: any = await client.request({
      url: `${base}/bpl_whatsappConnections`,
      params: { pageSize: 100, ...(page ? { pageToken: page } : {}) },
    });
    for (const document of response.data.documents || []) {
      const uid = document.name.split('/').pop();
      const fields = document.fields;
      const record = await decryptConnection(
        {
          version: 1,
          iv: fields.iv.stringValue,
          ciphertext: fields.ciphertext.stringValue,
        } as EncryptedConnection,
        uid,
        key,
      );
      if (!record.verifiedAt) continue;
      const previous = owners.get(record.businessAccountId);
      if (previous && previous !== uid)
        throw new Error(
          'Two saved portal accounts share a WhatsApp account. Resolve the conflict before enabling signup.',
        );
      owners.set(record.businessAccountId, uid);
    }
    page = response.data.nextPageToken || '';
  } while (page);
  const missing: [string, string][] = [];
  for (const [wabaId, uid] of owners) {
    const response: any = await client.request({
      url: `${base}/bpl_whatsappAccountOwners/${wabaId}`,
      validateStatus: () => true,
    });
    if (response.status === 404) missing.push([wabaId, uid]);
    else if (response.status !== 200 || response.data.fields?.ownerId?.stringValue !== uid)
      throw new Error('Ownership index conflict. No records were replaced.');
  }
  if (process.argv.includes('--apply'))
    for (const [wabaId, uid] of missing) {
      await client.request({
        url: `${base}:commit`,
        method: 'POST',
        data: {
          writes: [
            {
              update: {
                name: `projects/${project}/databases/(default)/documents/bpl_whatsappAccountOwners/${wabaId}`,
                fields: {
                  ownerId: { stringValue: uid },
                  updatedAt: { timestampValue: new Date().toISOString() },
                },
              },
              currentDocument: { exists: false },
            },
          ],
        },
      });
    }
  console.log(
    JSON.stringify({
      verifiedAccounts: owners.size,
      missingOwnershipEntries: missing.length,
      applied: process.argv.includes('--apply'),
    }),
  );
}
run().catch(() => {
  console.error(
    'Ownership migration could not complete. Check server credentials and duplicate accounts; no credentials were printed.',
  );
  process.exitCode = 1;
});
