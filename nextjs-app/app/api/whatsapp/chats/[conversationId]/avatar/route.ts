import { handlePersonalAvatar } from '@/lib/personal-avatar';
import { accountEnvironment } from '@/lib/server/account-environment';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
) {
  return handlePersonalAvatar(
    request,
    (await context.params).conversationId,
    accountEnvironment(true),
  );
}
