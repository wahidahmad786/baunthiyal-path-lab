'use client';
import { useEffect, useState } from 'react';
import { Copy, MessageCircle, Plus, Users, X } from 'lucide-react';
import { accountApi, Field, Notice } from './ui';
import type { TeamContext, QuickReply } from '@/lib/crm-types';
export default function TeamSettings({
  onOpenInbox,
}: {
  onOpenInbox: (workspace: string) => void;
}) {
  const [data, setData] = useState<TeamContext | null>(null),
    [email, setEmail] = useState(''),
    [role, setRole] = useState('staff');
  const [link, setLink] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const [reply, setReply] = useState({ title: '', text: '' }),
    [editingReply, setEditingReply] = useState<QuickReply | null>(null);
  async function load() {
    try {
      setData(await accountApi<TeamContext>('account/team'));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="crm-module">
      <div className="crm-heading">
        <div>
          <h2>
            <Users size={21} /> Team & quick replies
          </h2>
          <p>Invite verified Google users to your inbox and prepare reusable replies.</p>
        </div>
      </div>
      {error && <Notice error>{error}</Notice>}
      {notice && <Notice>{notice}</Notice>}
      <div className="crm-grid">
        <section className="panel crm-card">
          <h3>Invite a team member</h3>
          <p className="crm-muted">
            Members can see this workspace’s customer names, phone numbers, chats and internal
            notes. Staff can reply and assign chats; viewers have read-only access. Other portal
            records and WhatsApp credentials are not shared.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const result = await accountApi<{ inviteUrl: string; message: string }>(
                  'account/team/invites',
                  { email: email.trim(), role },
                );
                setLink(result.inviteUrl);
                setNotice(result.message);
              });
            }}
          >
            <Field label="Member’s Google email">
              <input
                type="email"
                required
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setLink('');
                }}
              />
            </Field>
            <Field label="Inbox role">
              <select
                value={role}
                onChange={(e) => {
                  setRole(e.target.value);
                  setLink('');
                }}
              >
                <option value="staff">Staff · read, reply, assign and add notes</option>
                <option value="viewer">Viewer · read only</option>
              </select>
            </Field>
            <button type="submit" className="button primary" disabled={busy || !data}>
              <Plus size={16} />
              Create invite link
            </button>
          </form>
          {link && (
            <div className="crm-invite-link">
              <Field
                label="Private invite link"
                hint="Share this with the selected person. Only their verified Google email can accept; valid for 48 hours."
              >
                <input
                  aria-label="Private invite link"
                  readOnly
                  value={link}
                  onFocus={(e) => e.currentTarget.select()}
                />
              </Field>
              <button
                className="button secondary"
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(link);
                    setNotice('Invite link copied.');
                  } catch {
                    setError('Select the link to copy it manually.');
                  }
                }}
              >
                <Copy size={14} />
                Copy invite link
              </button>
            </div>
          )}
          <h3 className="crm-section-title">Members</h3>
          {!data ? (
            <p>Loading your team…</p>
          ) : (
            data.members
              .filter((m) => m.active)
              .map((m) => (
                <article className="crm-list-item" key={m.uid}>
                  <strong>{m.name}</strong>
                  <span>
                    {m.email || ''} · {m.role}
                  </span>
                  {m.role !== 'owner' && (
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await accountApi(`account/team/members/${m.uid}`, {});
                          setNotice('Team access removed.');
                        })
                      }
                    >
                      <X size={13} />
                      Remove access
                    </button>
                  )}
                </article>
              ))
          )}
        </section>
        <section className="panel crm-card">
          <h3>{editingReply ? 'Edit quick reply' : 'Create a quick reply'}</h3>
          <p className="crm-muted">
            Selecting a quick reply fills the chat composer. It is sent only when staff press Send,
            and the WhatsApp reply-window rule still applies.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await accountApi(
                  'account/team/quick-replies' + (editingReply ? '/' + editingReply.id : ''),
                  reply,
                );
                setReply({ title: '', text: '' });
                setEditingReply(null);
                setNotice('Quick reply saved.');
              });
            }}
          >
            <Field label="Quick reply title">
              <input
                maxLength={60}
                required
                value={reply.title}
                onChange={(e) => setReply({ ...reply, title: e.target.value })}
              />
            </Field>
            <Field label="Reply text">
              <textarea
                rows={4}
                maxLength={2000}
                required
                value={reply.text}
                onChange={(e) => setReply({ ...reply, text: e.target.value })}
              />
            </Field>
            <div className="inline-actions">
              <button type="submit" className="button primary" disabled={busy || !data}>
                Save quick reply
              </button>
              {editingReply && (
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => {
                    setEditingReply(null);
                    setReply({ title: '', text: '' });
                  }}
                >
                  Cancel edit
                </button>
              )}
            </div>
          </form>
          {data?.quickReplies.map((q) => (
            <article className="crm-list-item" key={q.id}>
              <strong>{q.title}</strong>
              <p className="crm-template-body">{q.text}</p>
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => {
                  setEditingReply(q);
                  setReply({ title: q.title, text: q.text });
                }}
              >
                Edit reply
              </button>
            </article>
          ))}
        </section>
      </div>
      {!!data?.workspaces.length && (
        <section className="panel crm-card">
          <h3>Your inbox workspaces</h3>
          {data.workspaces.map((w) => (
            <article className="crm-list-item" key={w.id}>
              <strong>{w.name}</strong>
              <span>{w.role}</span>
              <button type="button" className="text-button" onClick={() => onOpenInbox(w.id)}>
                <MessageCircle size={14} />
                Open inbox
              </button>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
