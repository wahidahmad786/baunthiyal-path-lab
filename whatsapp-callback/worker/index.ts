import { handleWhatsAppWebhook } from '../lib/whatsapp-webhook';
export default {
  async fetch(request: Request, env: Record<string,string>): Promise<Response> {
    const path = new URL(request.url).pathname;
    if ((path === '/' || path === '/health') && request.method === 'GET') return Response.json({ application: 'Baunthiyal Path Lab WhatsApp callback', status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } });
    const match = path.match(/^\/webhook\/([^/]+)$/);
    if (!match) return new Response('Not found', { status: 404 });
    let uid: string;
    try { uid = decodeURIComponent(match[1]); } catch { return new Response('Invalid callback', { status: 400 }); }
    return handleWhatsAppWebhook(request, uid, {
      projectId: env.FIREBASE_PROJECT_ID, apiKey: '', encryptionKey: env.WHATSAPP_CONNECTION_ENCRYPTION_KEY,
      serviceAccountJson: env.WHATSAPP_SERVICE_ACCOUNT_JSON,
    });
  },
};
