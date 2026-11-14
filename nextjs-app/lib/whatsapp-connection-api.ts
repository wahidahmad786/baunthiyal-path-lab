import {
  connectionSchema,
  connectionSummary,
  encryptConnection,
  decryptConnection,
  verifyMetaConnection,
  type EncryptedConnection,
  type ConnectionRecord,
} from './whatsapp-connection';
import { loadMarketingTemplates, MetaTemplateError } from './meta-marketing-templates';
import { allowedRequestOrigin } from './request-origin';
import { ChatError, ChatStore } from './account-chat-api';
import { claimWhatsAppAccount } from './whatsapp-account-owner';

export type ConnectionEnvironment = {
  projectId: string;
  apiKey: string;
  encryptionKey: string;
  graphVersion?: string;
  authOrigin?: string;
  firestoreOrigin?: string;
  appOrigin?: string;
  webhookBaseUrl?: string;
  webhookPublicReady?: boolean;
  serviceAccountJson?: string;
};
class ConnectionError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });

export async function handleWhatsAppConnection(
  request: Request,
  env: ConnectionEnvironment,
  send: typeof fetch = fetch,
): Promise<Response> {
  try {
    const path = new URL(request.url).pathname.replace(/\/$/, '');
    const templateRequest = path === '/api/whatsapp/integration/templates';
    const verificationTokenRequest = path === '/api/whatsapp/integration/verification-token';
    if (verificationTokenRequest && request.method !== 'POST')
      return json({ error: 'Method not allowed' }, 405);
    if (templateRequest && request.method !== 'GET')
      return json({ error: 'Method not allowed' }, 405);
    if (!['GET', 'POST'].includes(request.method))
      return json({ error: 'Method not allowed' }, 405);
    if (request.method === 'POST' && !allowedRequestOrigin(request, env.appOrigin))
      throw new ConnectionError(403, 'Request origin is not allowed');
    const token = request.headers.get('authorization')?.match(/^Bearer (\S+)$/)?.[1];
    if (!token)
      throw new ConnectionError(401, 'Sign in with Google to manage your WhatsApp connection.');
    const authBase = env.authOrigin || 'https://identitytoolkit.googleapis.com';
    const checked = await send(
      `${authBase}/v1/accounts:lookup?key=${encodeURIComponent(env.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: token }),
        signal: AbortSignal.timeout(15000),
      },
    );
    const identity = (await checked.json()).users?.[0];
    if (!checked.ok || !identity || identity.disabled)
      throw new ConnectionError(401, 'Your sign-in has expired. Please sign in again.');
    if (!identity.emailVerified)
      throw new ConnectionError(403, 'Use a verified Google account to connect WhatsApp.');
    if (!env.encryptionKey)
      throw new ConnectionError(
        503,
        'Secure connection storage is unavailable. Please contact the lab administrator.',
      );
    const uid = identity.localId;
    const url = `${env.firestoreOrigin || 'https://firestore.googleapis.com'}/v1/projects/${env.projectId}/databases/(default)/documents/bpl_whatsappConnections/${encodeURIComponent(uid)}`;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const existing = await send(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!existing.ok && existing.status !== 404)
      throw new ConnectionError(503, 'Unable to read your WhatsApp connection. Try again later.');
    const document = existing.ok ? await existing.json() : null;
    let previous: ConnectionRecord | null = null;
    if (document) {
      const f = document.fields;
      previous = await decryptConnection(
        {
          version: Number(f.version.integerValue),
          iv: f.iv.stringValue,
          ciphertext: f.ciphertext.stringValue,
        } as EncryptedConnection,
        uid,
        env.encryptionKey,
      );
    }
    if (templateRequest) {
      if (!previous)
        throw new ConnectionError(
          409,
          'Open WhatsApp Integration and connect your WhatsApp Business account before loading templates.',
          'WHATSAPP_NOT_CONNECTED',
        );
      if (!previous.verifiedAt)
        throw new ConnectionError(
          409,
          'Open WhatsApp Integration and choose Verify & save before loading approved templates.',
          'WHATSAPP_NOT_VERIFIED',
        );
      try {
        const result = await loadMarketingTemplates(previous, env.graphVersion, send);
        return json({
          templates: result.templates,
          approvedMarketing: result.approvedMarketing,
          unsupported: result.unsupported,
          reasons: result.reasons,
          unavailableTemplates: result.unavailableTemplates,
          pendingMarketing: result.pendingMarketing,
          rejectedMarketing: result.rejectedMarketing,
        });
      } catch (error) {
        if (error instanceof MetaTemplateError && [190, 102, 104].includes(error.code))
          throw new ConnectionError(409, error.message, 'META_ACCESS_TOKEN_INVALID');
        if (error instanceof MetaTemplateError)
          throw new ConnectionError(error.status, error.message, 'WHATSAPP_TEMPLATE_FETCH_FAILED');
        throw new ConnectionError(
          502,
          'Meta could not load approved templates. Check your saved access token and WhatsApp account permissions in WhatsApp Integration.',
          'WHATSAPP_TEMPLATE_FETCH_FAILED',
        );
      }
    }
    function webhook(record: ConnectionRecord | null) {
      let callbackUrl: string | null = null;
      if (env.webhookBaseUrl) {
        const base = new URL(env.webhookBaseUrl);
        if (base.protocol === 'https:')
          callbackUrl = `${base.origin}/webhook/${encodeURIComponent(uid)}`;
      }
      return {
        callbackUrl,
        publicReady: env.webhookPublicReady === true,
        verifyTokenSaved: !!record?.verifyToken,
      };
    }
    if (verificationTokenRequest) {
      if (!previous?.verifyToken)
        throw new ConnectionError(
          409,
          'Enter a webhook verification token and choose Save details first.',
        );
      // Explicit authenticated owner action; access tokens and app secrets are never returned.
      return json({ verifyToken: previous.verifyToken });
    }
    if (request.method === 'GET')
      return json({
        connection: previous ? connectionSummary(previous) : null,
        webhook: webhook(previous),
      });
    const text = await request.text();
    if (text.length > 16000) throw new ConnectionError(413, 'Connection details are too large.');
    const parsed = connectionSchema.safeParse(JSON.parse(text));
    if (!parsed.success)
      throw new ConnectionError(400, parsed.error.issues.map((i) => i.message).join('. '));
    const input = parsed.data;
    const { verify: _verify, ...credentials } = input;
    const record: ConnectionRecord = {
      ...credentials,
      accessToken: input.accessToken || previous?.accessToken || '',
      appSecret: input.appSecret || previous?.appSecret || '',
      verifyToken: input.verifyToken || previous?.verifyToken || '',
      verifiedAt: null,
      verifiedName: '',
    };
    if (record.accessToken.length < 20 || record.appSecret.length < 16)
      throw new ConnectionError(400, 'Enter an access token and app secret before saving.');
    if (input.verify)
      Object.assign(record, await verifyMetaConnection(record, env.graphVersion, send));
    if (input.verify && env.serviceAccountJson) {
      const store = await ChatStore.open(env, uid, send, token, true);
      await claimWhatsAppAccount(store, record.businessAccountId);
    }
    // Verification describes these exact credentials; editing and saving always clears it.
    const envelope = await encryptConnection(record, uid, env.encryptionKey);
    const timestamp = new Date().toISOString();
    const fields = {
      ownerId: { stringValue: uid },
      version: { integerValue: '1' },
      iv: { stringValue: envelope.iv },
      ciphertext: { stringValue: envelope.ciphertext },
      createdAt: { timestampValue: document?.fields.createdAt.timestampValue || timestamp },
      updatedAt: { timestampValue: timestamp },
    };
    const saved = await send(url.replace(/\/documents\/.*$/, '/documents:commit'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        writes: [
          {
            update: {
              name: `projects/${env.projectId}/databases/(default)/documents/bpl_whatsappConnections/${uid}`,
              fields,
            },
            currentDocument: document ? { updateTime: document.updateTime } : { exists: false },
          },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!saved.ok)
      throw new ConnectionError(
        saved.status === 409 ? 409 : 503,
        'Unable to save. Refresh your connection details and try again.',
      );
    return json({
      connection: connectionSummary(record),
      webhook: webhook(record),
      message: input.verify
        ? 'Meta verified your WhatsApp credentials. Connection saved.'
        : 'Connection details saved securely. Verify with Meta before sending.',
    });
  } catch (error) {
    if (error instanceof ChatError)
      return json({ error: error.message, code: error.code }, error.status);
    if (error instanceof MetaTemplateError)
      return json(
        {
          error: error.message,
          code: [190, 102, 104].includes(error.code)
            ? 'META_ACCESS_TOKEN_INVALID'
            : 'WHATSAPP_VERIFICATION_FAILED',
        },
        error.status,
      );
    if (error instanceof ConnectionError)
      return json(
        { error: error.message, ...(error.code ? { code: error.code } : {}) },
        error.status,
      );
    if (error instanceof SyntaxError)
      return json({ error: 'Enter valid connection details.' }, 400);
    return json(
      {
        error:
          (error instanceof Error && error.message.startsWith('Meta')) ||
          (error instanceof Error &&
            /Phone Number|phone number|access token does not match/.test(error.message))
            ? error.message
            : 'Unable to verify or save this connection. Please check your details and try again.',
      },
      400,
    );
  }
}
