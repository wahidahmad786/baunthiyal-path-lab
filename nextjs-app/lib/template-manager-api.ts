import { z } from 'zod';
import {
  ChatError,
  ChatStore,
  chatJson,
  readChatBody,
  readChatConnection,
  verifyUser,
} from './account-chat-api';
import { allowedRequestOrigin } from './request-origin';
import { handleAccountBanners } from './account-banners-api';
import { bannerReference, imageDetails } from './banner';
import { metaJson, metaFailure, MetaGraphError } from './meta-client';
import {
  assertTemplateReady,
  templateComponents,
  templateDraftSchema,
  type TemplateDraftInput,
  type ManagedTemplate,
} from './template-manager';
import type { ChatEnvironment } from './chat-types';
import type { ConnectionRecord } from './whatsapp-connection';

const now = () => new Date().toISOString();
const draftSave = z
  .object({ draft: templateDraftSchema, expectedRevision: z.number().int().min(1).optional() })
  .strict();
const states = new Set([
  'APPROVED',
  'PENDING',
  'REJECTED',
  'PAUSED',
  'DISABLED',
  'IN_APPEAL',
  'PENDING_DELETION',
  'DELETED',
  'LIMIT_EXCEEDED',
]);
function draftView(doc: { name: string; data: Record<string, any> }) {
  const input = templateDraftSchema.parse(
    Object.fromEntries(Object.keys(templateDraftSchema.shape).map((k) => [k, doc.data[k]])),
  );
  return {
    ...input,
    id: doc.name.split('/').pop(),
    revision: doc.data.revision,
    state: doc.data.state,
    metaId: doc.data.metaId || undefined,
    providerStatus: doc.data.providerStatus || undefined,
    lastError: doc.data.lastError || undefined,
    updatedAt: doc.data.updatedAt,
  };
}
async function uploadImage(
  request: Request,
  store: ChatStore,
  connection: ConnectionRecord,
  path: string,
  token: string,
) {
  const reference = bannerReference(path);
  if (!reference || reference.uid !== store.uid)
    throw new ChatError(400, 'Choose an image from your own workspace.');
  const response = await handleAccountBanners(
    new Request(new URL(`/api/account/banners/${reference.id}`, request.url), {
      headers: { Authorization: 'Bearer ' + token },
    }),
    { ...store.env, serviceAccountJson: store.env.serviceAccountJson! },
    store.send,
  );
  if (!response.ok)
    throw new ChatError(400, 'This saved image could not be loaded. Upload it again.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  const details = imageDetails(bytes);
  if (!details) throw new ChatError(400, 'Choose a valid PNG or JPEG image.');
  const version = store.env.graphVersion || 'v23.0';
  const session = await metaJson(
    connection,
    `${connection.appId}/uploads`,
    store.send,
    version,
    {},
    {
      file_name: `template-${reference.id}.${details.type === 'image/png' ? 'png' : 'jpg'}`,
      file_length: String(bytes.length),
      file_type: details.type,
    },
  );
  if (
    typeof session.id !== 'string' ||
    !/^upload:[A-Za-z0-9_:?=.&%+~/-]+$/.test(session.id) ||
    session.id.length > 4096
  )
    throw new ChatError(502, 'Meta did not return a usable image upload session.');
  const uploadUrl = new URL(`https://graph.facebook.com/${version}/${session.id}`);
  let uploaded: Response;
  try {
    uploaded = await store.send(uploadUrl, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: `OAuth ${connection.accessToken}`,
        file_offset: '0',
        'Content-Type': details.type,
      },
      body: bytes,
      signal: AbortSignal.timeout(25000),
    });
  } catch {
    throw new MetaGraphError(
      503,
      0,
      'The image upload could not complete. Try submitting the draft again.',
    );
  }
  const result = await uploaded.json().catch(() => null);
  if (!uploaded.ok || result?.error)
    throw metaFailure(uploaded.status, Number(result?.error?.code || 0));
  if (typeof result?.h !== 'string' || !result.h || result.h.length > 8192)
    throw new ChatError(502, 'Meta did not return an image sample handle.');
  return result.h as string;
}
function managedTemplate(raw: any, waba: string): ManagedTemplate | null {
  if (
    !raw ||
    !/^[1-9]\d{4,29}$/.test(raw.id) ||
    typeof raw.name !== 'string' ||
    typeof raw.language !== 'string'
  )
    return null;
  const components = Array.isArray(raw.components) ? raw.components : [];
  const header = components.find((c: any) => c.type === 'HEADER');
  const reason =
    typeof raw.rejected_reason === 'string' && /^[A-Z0-9_ ]{1,120}$/.test(raw.rejected_reason)
      ? raw.rejected_reason
      : null;
  return {
    id: raw.id,
    name: raw.name.slice(0, 512),
    language: raw.language.slice(0, 32),
    category: ['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(raw.category)
      ? raw.category
      : 'UNKNOWN',
    status: states.has(raw.status) ? raw.status : 'UNKNOWN',
    body: String(components.find((c: any) => c.type === 'BODY')?.text || '').slice(0, 1024),
    headerType: header?.format || 'NONE',
    headerText: String(header?.text || '').slice(0, 60),
    footer: String(components.find((c: any) => c.type === 'FOOTER')?.text || '').slice(0, 60),
    checkedAt: now(),
    rejectedReason: reason,
    businessAccountId: waba,
  };
}
export async function handleTemplateManager(
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
    const store = await ChatStore.open(env, user.uid, send, user.token, true);
    const path = new URL(request.url).pathname
      .replace(/^\/api\/account\/templates\/?/, '')
      .split('/')
      .filter(Boolean);
    const connection = await readChatConnection(store);
    if (!path.length && request.method === 'GET') {
      const [drafts, records, sync] = await Promise.all([
        store.list('templateDrafts', 'updatedAt desc', 100),
        store.list('templateRecords', 'checkedAt desc', 200),
        store.read('templateSync/current'),
      ]);
      return chatJson({
        drafts: drafts.docs.map(draftView),
        templates: records.docs
          .map((d) => d.data)
          .filter((d) => d.businessAccountId === connection?.businessAccountId),
        connected: !!connection?.verifiedAt,
        lastSyncedAt:
          sync?.data.businessAccountId === connection?.businessAccountId
            ? sync?.data.checkedAt
            : null,
        truncated: drafts.truncated || records.truncated || !!sync?.data.truncated,
      });
    }
    if (path[0] === 'drafts' && path.length <= 2 && request.method === 'POST') {
      const data = draftSave.safeParse(
        JSON.parse(new TextDecoder().decode(await readChatBody(request, 18000))),
      );
      if (!data.success)
        throw new ChatError(400, data.error.issues[0]?.message || 'Check the draft details.');
      const input = data.data;
      const id = path[1] || crypto.randomUUID();
      if (!z.uuid().safeParse(id).success) throw new ChatError(400, 'Invalid draft.');
      if (input.draft.bannerPath) {
        const image = bannerReference(input.draft.bannerPath);
        if (!image || image.uid !== user.uid)
          throw new ChatError(400, 'Choose an image from your own workspace.');
      }
      const existing = await store.read(`templateDrafts/${id}`);
      if (path[1] && !existing) throw new ChatError(404, 'Draft not found.');
      if (
        existing &&
        (existing.data.state !== 'DRAFT' || input.expectedRevision !== existing.data.revision)
      )
        throw new ChatError(
          409,
          'This draft changed or has been submitted. Refresh it before editing.',
        );
      if (!existing) {
        const drafts = await store.list('templateDrafts', 'updatedAt desc', 200);
        if (drafts.docs.length >= 200)
          throw new ChatError(409, 'Draft limit reached. Reuse an existing draft.');
      }
      const record = {
        ...input.draft,
        ownerId: user.uid,
        state: 'DRAFT',
        revision: (existing?.data.revision || 0) + 1,
        updatedAt: now(),
        createdAt: existing?.data.createdAt || now(),
      };
      await store.commit([store.write(`templateDrafts/${id}`, record, existing)]);
      return chatJson({ draft: draftView({ name: id, data: record }) }, existing ? 200 : 201);
    }
    if (!connection?.verifiedAt)
      throw new ChatError(
        409,
        'Connect and verify your WhatsApp account in WhatsApp Integration first. Drafts can still be saved.',
      );
    if (path[0] === 'sync' && path.length === 1 && request.method === 'POST') {
      const previous = await store.read('templateSync/current');
      if (
        previous?.data.businessAccountId === connection.businessAccountId &&
        Date.parse(previous.data.checkedAt || '') > Date.now() - 10000
      )
        return chatJson({
          message: 'Meta status was refreshed just now. Please wait a few seconds.',
        });
      const records: ManagedTemplate[] = [];
      let cursor = '',
        truncated = false;
      for (let page = 0; page < 10; page++) {
        const result = await metaJson(
          connection,
          `${connection.businessAccountId}/message_templates`,
          send,
          env.graphVersion,
          undefined,
          {
            fields: 'id,name,language,category,status,components,rejected_reason',
            limit: '100',
            ...(cursor ? { after: cursor } : {}),
          },
        );
        if (!Array.isArray(result.data))
          throw new MetaGraphError(
            502,
            0,
            'Meta returned incomplete template data. Previously saved statuses were kept.',
          );
        for (const raw of Array.isArray(result.data) ? result.data : []) {
          const record = managedTemplate(raw, connection.businessAccountId);
          if (record) records.push(record);
        }
        cursor = result.paging?.cursors?.after || '';
        if (!result.paging?.next || !cursor) break;
        if (page === 9) truncated = true;
      }
      for (let offset = 0; offset < records.length; offset += 200)
        await store.commit(
          records
            .slice(offset, offset + 200)
            .map((record) => store.write(`templateRecords/${record.id}`, record, undefined)),
        );
      const drafts = await store.list('templateDrafts', 'updatedAt desc', 200);
      for (const draft of drafts.docs) {
        if (
          draft.data.businessAccountId !== connection.businessAccountId ||
          !['SUBMITTING', 'SUBMISSION_UNKNOWN', 'SUBMITTED'].includes(draft.data.state)
        )
          continue;
        const found = records.find((r) =>
          draft.data.metaId
            ? r.id === draft.data.metaId
            : r.name === draft.data.name &&
              r.language === draft.data.language &&
              r.body === draft.data.body &&
              r.footer === draft.data.footer &&
              r.headerType === draft.data.headerType,
        );
        if (found)
          await store.commit([
            store.write(
              `templateDrafts/${draft.name.split('/').pop()}`,
              {
                ...draft.data,
                state: 'SUBMITTED',
                metaId: found.id,
                providerStatus: found.status,
                updatedAt: now(),
              },
              draft,
            ),
          ]);
      }
      // A complete successful listing is also authoritative evidence of deleted templates.
      if (!truncated) {
        const old = await store.list('templateRecords', 'checkedAt desc', 1000);
        const missing = old.docs.filter(
          (d) =>
            d.data.businessAccountId === connection.businessAccountId &&
            !records.some((r) => r.id === d.data.id),
        );
        for (let offset = 0; offset < missing.length; offset += 200)
          await store.commit(
            missing
              .slice(offset, offset + 200)
              .map((d) =>
                store.write(
                  `templateRecords/${d.name.split('/').pop()}`,
                  { ...d.data, status: 'DELETED', checkedAt: now() },
                  d,
                ),
              ),
          );
      }
      await store.commit([
        store.write(
          'templateSync/current',
          { businessAccountId: connection.businessAccountId, checkedAt: now(), truncated },
          undefined,
        ),
      ]);
      return chatJson({
        message: `Refreshed ${records.length} real Meta templates.`,
        count: records.length,
        truncated,
      });
    }
    if (
      path[0] === 'drafts' &&
      z.uuid().safeParse(path[1]).success &&
      path[2] === 'submit' &&
      path.length === 3 &&
      request.method === 'POST'
    ) {
      const document = await store.read(`templateDrafts/${path[1]}`);
      if (!document) throw new ChatError(404, 'Draft not found.');
      if (document.data.state !== 'DRAFT')
        throw new ChatError(
          409,
          'This draft was already submitted or its result is unconfirmed. Refresh Meta status before taking further action.',
        );
      const input = templateDraftSchema.parse(
        Object.fromEntries(
          Object.keys(templateDraftSchema.shape).map((k) => [k, document.data[k]]),
        ),
      );
      try {
        assertTemplateReady(input);
      } catch (error) {
        throw new ChatError(400, (error as Error).message);
      }
      let current = {
        ...document.data,
        state: 'SUBMITTING',
        businessAccountId: connection.businessAccountId,
        revision: document.data.revision + 1,
        updatedAt: now(),
      };
      await store.commit([store.write(`templateDrafts/${path[1]}`, current, document)]);
      let submittedToProvider = false;
      try {
        const handle =
          input.headerType === 'IMAGE'
            ? await uploadImage(request, store, connection, input.bannerPath, user.token)
            : undefined;
        const components = templateComponents(input, handle);
        submittedToProvider = true;
        const result = await metaJson(
          connection,
          `${connection.businessAccountId}/message_templates`,
          send,
          env.graphVersion,
          {
            name: input.name,
            language: input.language,
            category: input.category,
            allow_category_change: true,
            components,
          },
        );
        if (!/^[1-9]\d{4,29}$/.test(result.id))
          throw new MetaGraphError(
            502,
            0,
            'Meta did not confirm the submitted template ID. Refresh Meta status before retrying.',
            true,
          );
        current = {
          ...current,
          state: 'SUBMITTED',
          metaId: result.id,
          providerStatus: states.has(result.status) ? result.status : 'UNKNOWN',
          lastError: '',
          updatedAt: now(),
        } as typeof current;
        await store.commit([store.write(`templateDrafts/${path[1]}`, current, undefined)]);
        return chatJson({
          draft: draftView({ name: path[1], data: current }),
          message:
            'Template submitted to Meta. Meta controls approval; refresh Meta status to check the result.',
        });
      } catch (error) {
        const uncertain =
          submittedToProvider && (!(error instanceof MetaGraphError) || error.uncertain);
        const saved = await store.read(`templateDrafts/${path[1]}`);
        if (saved)
          await store.commit([
            store.write(
              `templateDrafts/${path[1]}`,
              {
                ...saved.data,
                state: uncertain ? 'SUBMISSION_UNKNOWN' : 'DRAFT',
                lastError:
                  error instanceof MetaGraphError || error instanceof ChatError
                    ? error.message
                    : 'The request could not complete. Refresh Meta status before retrying.',
                updatedAt: now(),
              },
              saved,
            ),
          ]);
        throw error;
      }
    }
    throw new ChatError(404, 'Template action not found.');
  } catch (error) {
    if (error instanceof ChatError || error instanceof MetaGraphError)
      return chatJson(
        { error: error.message, ...(error instanceof MetaGraphError ? { code: error.code } : {}) },
        error.status,
      );
    if (error instanceof SyntaxError || error instanceof z.ZodError)
      return chatJson({ error: 'Check your template details and try again.' }, 400);
    return chatJson(
      {
        error:
          'Unable to complete the template action. Refresh its saved status before trying again.',
      },
      503,
    );
  }
}
