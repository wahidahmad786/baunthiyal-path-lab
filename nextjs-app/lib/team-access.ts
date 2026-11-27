import { ChatError, ChatStore } from './account-chat-api';
import type { ChatEnvironment } from './chat-types';
import type { TeamRole } from './crm-types';

export type AccountIdentity = { uid: string; token: string; email: string; name: string };
export const standardUid = /^[A-Za-z0-9_-]{1,128}$/;
export async function inboxAccess(
  request: Request,
  env: ChatEnvironment,
  send: typeof fetch,
  user: AccountIdentity,
) {
  const owner = new URL(request.url).searchParams.get('workspace') || user.uid;
  if (!standardUid.test(owner)) throw new ChatError(400, 'Invalid workspace.');
  if (owner === user.uid)
    return {
      store: await ChatStore.open(env, owner, send, user.token),
      role: 'owner' as TeamRole,
      canWrite: true,
    };
  const store = await ChatStore.open(env, owner, send, undefined, true);
  const member = await store.read(`teamMembers/${user.uid}`);
  if (
    !member ||
    member.data.active !== true ||
    member.data.email !== user.email ||
    !['staff', 'viewer'].includes(member.data.role)
  )
    throw new ChatError(403, 'You do not have access to this team inbox.');
  return { store, role: member.data.role as TeamRole, canWrite: member.data.role === 'staff' };
}
