import { z } from 'zod';
import {
  ChatError,
  ChatStore,
  chatHash,
  chatJson,
  readChatBody,
  verifyUser,
} from './account-chat-api';
import { allowedRequestOrigin } from './request-origin';
import { inboxAccess, standardUid, type AccountIdentity } from './team-access';
import type { ChatEnvironment } from './chat-types';
import type { TeamMember, TeamWorkspace, ConversationMeta } from './crm-types';

const uid = z.string().regex(standardUid);
const inviteInput = z
  .object({
    email: z
      .email()
      .max(254)
      .transform((v) => v.trim().toLowerCase()),
    role: z.enum(['staff', 'viewer']),
  })
  .strict();
const acceptInput = z.object({ owner: uid, token: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const metaInput = z
  .object({
    assignedTo: uid.nullable(),
    labels: z.array(z.string().trim().min(1).max(24)).max(5),
    status: z.enum(['open', 'resolved']),
  })
  .strict();
const replyInput = z
  .object({ title: z.string().trim().min(1).max(60), text: z.string().trim().min(1).max(2000) })
  .strict();
const noteInput = z.object({ text: z.string().trim().min(1).max(3000) }).strict();
const timestamp = () => new Date().toISOString();
async function body(request: Request) {
  return JSON.parse(new TextDecoder().decode(await readChatBody(request, 18000)));
}
function parsed<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new ChatError(400, result.error.issues[0]?.message || 'Check the entered details.');
  return result.data;
}
function requireOwner(role: string) {
  if (role !== 'owner')
    throw new ChatError(403, 'Only the workspace owner can manage team access and quick replies.');
}
function rawMember(data: Record<string, any>, id: string, owner: boolean): TeamMember {
  return {
    uid: id,
    name: String(data.name || data.email || 'Team member').slice(0, 120),
    role: data.role,
    active: data.active === true,
    ...(owner ? { email: data.email } : {}),
  };
}
export function conversationMeta(data?: Record<string, any> | null): ConversationMeta {
  return {
    assignedTo: typeof data?.assignedTo === 'string' ? data.assignedTo : null,
    labels: Array.isArray(data?.labels)
      ? data.labels.filter((v: unknown) => typeof v === 'string').slice(0, 5)
      : [],
    status: data?.status === 'resolved' ? 'resolved' : 'open',
  };
}
export async function teamWorkspaces(
  store: ChatStore,
  user: AccountIdentity,
): Promise<TeamWorkspace[]> {
  const listed = await store.list('teamAccess', 'joinedAt desc', 100);
  const workspaces: TeamWorkspace[] = [
    { id: user.uid, name: 'My WhatsApp workspace', role: 'owner' },
  ];
  // The index is a convenience, never an authorization grant. Validate every membership.
  for (const doc of listed.docs) {
    const owner = doc.name.split('/').pop()!;
    if (!standardUid.test(owner) || owner === user.uid) continue;
    const member = await store.read(
      `bpl_customerWorkspaces/${owner}/teamMembers/${user.uid}`,
      true,
    );
    if (
      member?.data.active === true &&
      member.data.email === user.email &&
      ['staff', 'viewer'].includes(member.data.role)
    )
      workspaces.push({
        id: owner,
        name: String(doc.data.name || 'Team inbox').slice(0, 120),
        role: member.data.role,
      });
  }
  return workspaces;
}
export async function handleTeam(
  request: Request,
  env: ChatEnvironment,
  send: typeof fetch = fetch,
): Promise<Response> {
  try {
    if (!['GET', 'POST'].includes(request.method))
      return chatJson({ error: 'Method not allowed' }, 405);
    if (request.method === 'POST' && !allowedRequestOrigin(request, env.appOrigin))
      throw new ChatError(403, 'Request origin is not allowed');
    const user = await verifyUser(request, env, send);
    const own = await ChatStore.open(env, user.uid, send, user.token, true);
    const path = new URL(request.url).pathname
      .replace(/^\/api\/account\/team\/?/, '')
      .split('/')
      .filter(Boolean);
    if (path[0] === 'accept' && request.method === 'POST') {
      const input = parsed(acceptInput, await body(request));
      if (input.owner === user.uid) throw new ChatError(409, 'You already own this workspace.');
      const target = await ChatStore.open(env, input.owner, send, undefined, true);
      const inviteId = await chatHash(input.token);
      const invitation = await target.read(`teamInvites/${inviteId}`);
      if (
        !invitation ||
        invitation.data.email !== user.email ||
        invitation.data.revokedAt ||
        invitation.data.acceptedBy ||
        !Number.isFinite(Date.parse(invitation.data.expiresAt)) ||
        Date.parse(invitation.data.expiresAt) <= Date.now()
      )
        throw new ChatError(
          403,
          'This invite is unavailable, expired, already used, or belongs to another Google email.',
        );
      const existing = await target.read(`teamMembers/${user.uid}`);
      const previousGrant = Math.max(
        Date.parse(existing?.data.joinedAt || '') || 0,
        Date.parse(existing?.data.removedAt || '') || 0,
      );
      if (
        previousGrant &&
        (!Number.isFinite(Date.parse(invitation.data.createdAt)) ||
          Date.parse(invitation.data.createdAt) <= previousGrant)
      )
        throw new ChatError(
          403,
          'This invitation predates a newer access decision. Ask the owner for a fresh invitation.',
        );
      const now = timestamp();
      await target.commit([
        target.write(
          `teamMembers/${user.uid}`,
          {
            ownerId: input.owner,
            uid: user.uid,
            email: user.email,
            name: user.name,
            role: invitation.data.role,
            active: true,
            joinedAt: now,
          },
          existing,
        ),
        target.write(
          `teamInvites/${inviteId}`,
          { ...invitation.data, acceptedBy: user.uid, acceptedAt: now },
          invitation,
        ),
        own.write(
          `teamAccess/${input.owner}`,
          { name: invitation.data.workspaceName, joinedAt: now },
          undefined,
        ),
      ]);
      return chatJson({
        message: 'Team invite accepted. Open WhatsApp Inbox and select this workspace.',
        workspaceId: input.owner,
      });
    }
    const access = await inboxAccess(request, env, send, user);
    const { store, role, canWrite } = access;
    if (!path.length && request.method === 'GET') {
      const [members, replies, workspaces] = await Promise.all([
        store.list('teamMembers', 'joinedAt asc', 100),
        store.list('quickReplies', 'updatedAt desc', 100),
        teamWorkspaces(own, user),
      ]);
      const profile = await store.read('teamProfile/current');
      const contacts =
        role !== 'owner' ? await store.list('customers', 'createdAt desc', 200) : null;
      const roster: TeamMember[] = [
        {
          uid: store.uid,
          name: role === 'owner' ? user.name : String(profile?.data.name || 'Workspace owner'),
          role: 'owner',
          active: true,
        },
      ];
      for (const doc of members.docs)
        if (doc.data.active || role === 'owner')
          roster.push(rawMember(doc.data, doc.name.split('/').pop()!, role === 'owner'));
      return chatJson({
        workspaceId: store.uid,
        role,
        canWrite,
        members: roster,
        quickReplies: replies.docs.map((d) => ({
          id: d.name.split('/').pop(),
          title: d.data.title,
          text: d.data.text,
        })),
        workspaces,
        contacts:
          contacts?.docs.map((d) => ({
            id: d.name.split('/').pop(),
            name: d.data.name,
            phone: d.data.phone,
          })) || [],
        contactsTruncated: !!contacts?.truncated,
      });
    }
    if (path[0] === 'invites' && request.method === 'POST') {
      requireOwner(role);
      const input = parsed(inviteInput, await body(request));
      if (input.email === user.email) throw new ChatError(400, 'You already own this workspace.');
      const recent = await store.list('teamInvites', 'createdAt desc', 100);
      if (
        recent.docs.filter((d) => Date.parse(d.data.createdAt) > Date.now() - 86400000).length >= 30
      )
        throw new ChatError(429, 'Invite limit reached. Try again tomorrow.');
      const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('');
      const id = await chatHash(token),
        now = timestamp();
      const origin = new URL(env.appOrigin || request.url).origin;
      const link = new URL('/team-invite', origin);
      link.searchParams.set('owner', store.uid);
      link.searchParams.set('token', token);
      await store.commit([
        store.write(
          `teamInvites/${id}`,
          {
            ...input,
            workspaceName: user.name + ' · WhatsApp team',
            createdAt: now,
            expiresAt: new Date(Date.now() + 48 * 3600000).toISOString(),
            acceptedBy: null,
            revokedAt: null,
          },
          null,
        ),
        store.write('teamProfile/current', { name: user.name }, undefined),
      ]);
      return chatJson(
        {
          inviteUrl: link.href,
          message:
            'Invite link created for this email. Share it with the person; it expires in 48 hours.',
        },
        201,
      );
    }
    if (path[0] === 'members' && path[1] && request.method === 'POST') {
      requireOwner(role);
      const memberId = parsed(uid, path[1]);
      if (memberId === store.uid)
        throw new ChatError(400, 'The workspace owner cannot be removed.');
      const member = await store.read(`teamMembers/${memberId}`);
      if (!member) throw new ChatError(404, 'Team member not found.');
      const invitations = await store.list('teamInvites', 'createdAt desc', 100);
      await store.commit([
        store.write(
          `teamMembers/${memberId}`,
          { ...member.data, active: false, removedAt: timestamp() },
          member,
        ),
        {
          delete: `projects/${env.projectId}/databases/(default)/documents/bpl_customerWorkspaces/${memberId}/teamAccess/${store.uid}`,
        },
        ...invitations.docs
          .filter(
            (d) => d.data.email === member.data.email && !d.data.acceptedBy && !d.data.revokedAt,
          )
          .map((d) =>
            store.write(
              `teamInvites/${d.name.split('/').pop()}`,
              { ...d.data, revokedAt: timestamp() },
              d,
            ),
          ),
      ]);
      return chatJson({ message: 'Team access removed.' });
    }
    if (path[0] === 'quick-replies' && path.length === 1 && request.method === 'POST') {
      requireOwner(role);
      const input = parsed(replyInput, await body(request));
      const id = crypto.randomUUID();
      await store.commit([
        store.write(
          `quickReplies/${id}`,
          { ...input, updatedAt: timestamp(), authorId: user.uid },
          null,
        ),
      ]);
      return chatJson({ id, ...input }, 201);
    }
    if (
      path[0] === 'quick-replies' &&
      /^[a-f0-9-]{36}$/.test(path[1] || '') &&
      path.length === 2 &&
      request.method === 'POST'
    ) {
      requireOwner(role);
      const input = parsed(replyInput, await body(request));
      const existing = await store.read(`quickReplies/${path[1]}`);
      if (!existing) throw new ChatError(404, 'Quick reply not found.');
      await store.commit([
        store.write(
          `quickReplies/${path[1]}`,
          { ...input, updatedAt: timestamp(), authorId: user.uid },
          existing,
        ),
      ]);
      return chatJson({ id: path[1], ...input });
    }
    if (path[0] === 'conversations' && /^[a-f0-9]{32}$/.test(path[1] || '')) {
      const id = path[1];
      const [customer, conversation] = await Promise.all([
        store.read(`customers/${id}`),
        store.read(`conversations/${id}`),
      ]);
      if (!customer && !conversation) throw new ChatError(404, 'Conversation not found.');
      if (request.method === 'GET' && path.length === 2) {
        const [meta, notes] = await Promise.all([
          store.read(`conversationMeta/${id}`),
          store.list(`conversationNotes/${id}/entries`, 'createdAt desc', 50),
        ]);
        return chatJson({
          meta: conversationMeta(meta?.data),
          notes: notes.docs.map((d) => ({
            id: d.name.split('/').pop(),
            text: d.data.text,
            authorId: d.data.authorId,
            authorName: d.data.authorName,
            createdAt: d.data.createdAt,
          })),
        });
      }
      if (!canWrite) throw new ChatError(403, 'This team role has read-only access.');
      if (path[2] === 'meta' && request.method === 'POST') {
        const input = parsed(metaInput, await body(request));
        if (input.assignedTo && input.assignedTo !== store.uid) {
          const assigned = await store.read(`teamMembers/${input.assignedTo}`);
          if (!assigned?.data.active || assigned.data.role !== 'staff')
            throw new ChatError(400, 'Choose an active owner or staff member.');
        }
        const existing = await store.read(`conversationMeta/${id}`);
        await store.commit([
          store.write(
            `conversationMeta/${id}`,
            {
              ...input,
              labels: [...new Set(input.labels)],
              updatedAt: timestamp(),
              updatedBy: user.uid,
            },
            existing,
          ),
          store.write('inboxStatus/personalRevision', { at: timestamp() }, undefined),
        ]);
        return chatJson({ meta: input });
      }
      if (path[2] === 'notes' && request.method === 'POST') {
        const input = parsed(noteInput, await body(request));
        const noteId = crypto.randomUUID();
        const note = {
          ...input,
          authorId: user.uid,
          authorName: user.name,
          createdAt: timestamp(),
        };
        await store.commit([store.write(`conversationNotes/${id}/entries/${noteId}`, note, null)]);
        return chatJson({ id: noteId, ...note }, 201);
      }
    }
    throw new ChatError(404, 'Team action not found.');
  } catch (error) {
    if (error instanceof ChatError) return chatJson({ error: error.message }, error.status);
    if (error instanceof SyntaxError) return chatJson({ error: 'Invalid team request.' }, 400);
    return chatJson({ error: 'Unable to update the team inbox. Please try again.' }, 503);
  }
}
