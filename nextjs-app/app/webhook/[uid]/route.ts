import { accountEnvironment } from '@/lib/server/account-environment';
import { handleWhatsAppWebhook } from '@/lib/whatsapp-webhook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ uid: string }> };
async function receive(request: Request, context: Context) {
  return handleWhatsAppWebhook(request, (await context.params).uid, accountEnvironment(true));
}
export const GET = receive;
export const POST = receive;
