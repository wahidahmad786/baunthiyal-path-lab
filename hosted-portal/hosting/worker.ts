import { handleWhatsAppConnection } from '../lib/whatsapp-connection-api';
import { handleAccountCustomers } from '../lib/account-customers-api';
import { handleAccountCatalog } from '../lib/account-catalog-api';
import { handleAccountChat } from '../lib/account-chat-api';
import { files } from './static-files.generated';

type Environment = {
  FIREBASE_PROJECT_ID: string;
  FIREBASE_WEB_API_KEY: string;
  WHATSAPP_CONNECTION_ENCRYPTION_KEY: string;
  WHATSAPP_GRAPH_VERSION?: string;
  WHATSAPP_SERVICE_ACCOUNT_JSON?: string;
  WHATSAPP_WEBHOOK_BASE_URL?: string;
  WHATSAPP_WEBHOOK_PUBLIC_READY?: string;
};
export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/api/account/catalog') || path === '/api/account/offers') return handleAccountCatalog(request, { projectId: env.FIREBASE_PROJECT_ID, apiKey: env.FIREBASE_WEB_API_KEY });
    if (path === '/api/account/inbox' || path.startsWith('/api/account/inbox/')) return handleAccountChat(request, {
      projectId: env.FIREBASE_PROJECT_ID, apiKey: env.FIREBASE_WEB_API_KEY, encryptionKey: env.WHATSAPP_CONNECTION_ENCRYPTION_KEY,
      graphVersion: env.WHATSAPP_GRAPH_VERSION, serviceAccountJson: env.WHATSAPP_SERVICE_ACCOUNT_JSON,
      webhookBaseUrl: env.WHATSAPP_WEBHOOK_BASE_URL, webhookPublicReady: env.WHATSAPP_WEBHOOK_PUBLIC_READY === 'true',
    });
    if (path === '/api/account/customers' || /^\/api\/account\/customers\/[a-f0-9]{32}\/consent$/.test(path)) return handleAccountCustomers(request, {
      projectId: env.FIREBASE_PROJECT_ID,
      apiKey: env.FIREBASE_WEB_API_KEY,
    });
    if (path === '/api/whatsapp/integration' || path === '/api/whatsapp/integration/templates') return handleWhatsAppConnection(request, {
      projectId: env.FIREBASE_PROJECT_ID,
      apiKey: env.FIREBASE_WEB_API_KEY,
      encryptionKey: env.WHATSAPP_CONNECTION_ENCRYPTION_KEY,
      graphVersion: env.WHATSAPP_GRAPH_VERSION,
    });
    if (path === '/api/health') return Response.json({ status: 'ok', application: 'Baunthiyal Path Lab', scope: 'account-integration' });
    if (path.startsWith('/api/') && path !== '/api/configuration') return Response.json({ error: 'This action is not available on this host.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    const file = files[path] || files[`${path.replace(/\/$/, '')}/index.html`] || files['/404.html'];
    if (!file) return new Response('Not found', { status: 404 });
    const found = !!(files[path] || files[`${path.replace(/\/$/, '')}/index.html`]);
    const body = request.method === 'HEAD' ? null : Uint8Array.from(atob(file.content), c => c.charCodeAt(0));
    return new Response(body, {
      status: found ? 200 : 404,
      headers: {
        'Content-Type': file.type,
        'Cache-Control': path.startsWith('/_next/static/') ? 'public, max-age=31536000, immutable' : 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
      },
    });
  },
};
