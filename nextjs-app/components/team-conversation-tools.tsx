'use client';
import { useEffect, useRef, useState } from 'react';
import { EllipsisVertical, MessageSquareText, Save } from 'lucide-react';
import { accountApi, Notice } from './ui';
import type { ConversationMeta, ConversationNote, TeamContext } from '@/lib/crm-types';
export const workspacePath = (path: string, workspace: string) =>
  path + (workspace ? '?workspace=' + encodeURIComponent(workspace) : '');
export default function TeamConversationTools({
  workspace,
  customerId,
  context,
  compact = false,
  onQuickReply,
  onChanged,
}: {
  workspace: string;
  customerId: string;
  context: TeamContext;
  compact?: boolean;
  onQuickReply: (text: string) => void;
  onChanged: () => void;
}) {
  const [meta, setMeta] = useState<ConversationMeta>({
      assignedTo: null,
      labels: [],
      status: 'open',
    }),
    [notes, setNotes] = useState<ConversationNote[]>([]);
  const [labels, setLabels] = useState(''),
    [note, setNote] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const active = useRef(true),
    dirtyLabels = useRef(false),
    revision = useRef(0);
  const base = `account/team/conversations/${customerId}`;
  async function load() {
    const request = ++revision.current;
    try {
      const result = await accountApi<{ meta: ConversationMeta; notes: ConversationNote[] }>(
        workspacePath(base, workspace),
      );
      if (active.current && request === revision.current) {
        setMeta(result.meta);
        setNotes(result.notes);
        if (!dirtyLabels.current) setLabels(result.meta.labels.join(', '));
        setError('');
      }
    } catch (e) {
      if (active.current && request === revision.current) setError((e as Error).message);
    }
  }
  useEffect(() => {
    active.current = true;
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 15000);
    return () => {
      active.current = false;
      revision.current++;
      clearInterval(timer);
    };
  }, [workspace, customerId]);
  async function saveMeta(next: ConversationMeta) {
    setBusy(true);
    revision.current++;
    try {
      const result = await accountApi<{ meta: ConversationMeta }>(
        workspacePath(base + '/meta', workspace),
        next,
      );
      if (active.current) {
        setMeta(result.meta);
        dirtyLabels.current = false;
        setLabels(result.meta.labels.join(', '));
        setError('');
        onChanged();
      }
    } catch (e) {
      if (active.current) setError((e as Error).message);
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <details
      className={'crm-conversation-tools' + (compact ? ' crm-conversation-tools-compact' : '')}
    >
      <summary
        aria-label={compact ? 'Conversation tools' : undefined}
        title={compact ? 'Conversation tools' : undefined}
      >
        {compact ? (
          <EllipsisVertical size={21} />
        ) : (
          <>
            <MessageSquareText size={15} />
            Assignment, labels & internal notes {meta.status === 'resolved' ? '· Resolved' : ''}
          </>
        )}
      </summary>
      <div className="crm-thread-tools-body">
        {error && <Notice error>{error}</Notice>}
        <div className="crm-two-fields">
          <label>
            Assigned to
            <select
              aria-label="Assign conversation"
              disabled={!context.canWrite || busy}
              value={meta.assignedTo || ''}
              onChange={(e) => void saveMeta({ ...meta, assignedTo: e.target.value || null })}
            >
              <option value="">Unassigned</option>
              {context.members
                .filter((m) => m.active && m.role !== 'viewer')
                .map((m) => (
                  <option key={m.uid} value={m.uid}>
                    {m.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Conversation status
            <select
              aria-label="Conversation status"
              disabled={!context.canWrite || busy}
              value={meta.status}
              onChange={(e) =>
                void saveMeta({ ...meta, status: e.target.value as ConversationMeta['status'] })
              }
            >
              <option value="open">Open</option>
              <option value="resolved">Resolved</option>
            </select>
          </label>
        </div>
        <label>
          Labels · comma separated
          <input
            aria-label="Conversation labels"
            maxLength={130}
            disabled={!context.canWrite || busy}
            value={labels}
            onChange={(e) => {
              dirtyLabels.current = true;
              setLabels(e.target.value);
            }}
          />
        </label>
        {context.canWrite && (
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() =>
              void saveMeta({
                ...meta,
                labels: labels
                  .split(',')
                  .map((v) => v.trim())
                  .filter(Boolean),
              })
            }
          >
            <Save size={13} />
            Save labels
          </button>
        )}
        {context.canWrite && !!context.quickReplies.length && (
          <label>
            Quick reply
            <select
              aria-label="Insert quick reply"
              value=""
              onChange={(e) => {
                const reply = context.quickReplies.find((q) => q.id === e.target.value);
                if (reply) onQuickReply(reply.text);
              }}
            >
              <option value="">Choose a reply to insert…</option>
              {context.quickReplies.map((q) => (
                <option key={q.id} value={q.id}>
                  {q.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <h4>Internal notes</h4>
        <p className="crm-muted">
          Visible only to your authorized team. These notes are not sent to the customer.
        </p>
        {context.canWrite && (
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              try {
                await accountApi(workspacePath(base + '/notes', workspace), { text: note });
                if (active.current) {
                  setNote('');
                  await load();
                }
              } catch (e) {
                if (active.current) setError((e as Error).message);
              } finally {
                if (active.current) setBusy(false);
              }
            }}
          >
            <textarea
              aria-label="Internal note"
              rows={2}
              maxLength={3000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <button
              type="submit"
              className="button secondary small-button"
              disabled={busy || !note.trim()}
            >
              Add internal note
            </button>
          </form>
        )}
        <div className="crm-notes-list">
          {notes.length ? (
            notes.map((n) => (
              <article className="crm-list-item" key={n.id}>
                <strong>{n.authorName}</strong>
                <p>{n.text}</p>
                <small>{new Date(n.createdAt).toLocaleString('en-IN')}</small>
              </article>
            ))
          ) : (
            <p className="crm-muted">No internal notes yet.</p>
          )}
        </div>
      </div>
    </details>
  );
}
