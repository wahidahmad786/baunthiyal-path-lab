'use client';
import './whatsapp-connection-options.css';
import { useEffect, useState } from 'react';
import { MessageCircle, Search } from 'lucide-react';
import { accountApi, Field, Modal, Submit } from './ui';
import { workspacePath } from './team-conversation-tools';
export default function WhatsAppNewChat({
  workspace,
  onClose,
  onOpen,
}: {
  workspace: string;
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const [phone, setPhone] = useState(''),
    [name, setName] = useState(''),
    [query, setQuery] = useState('');
  const [contacts, setContacts] = useState<{ id: string; name: string; phone: string }[]>([]),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void accountApi<{ contacts: typeof contacts }>(
      workspacePath('account/inbox/contacts', workspace),
    )
      .then((r) => {
        if (active) setContacts(r.contacts);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [workspace]);
  return (
    <Modal
      title="New WhatsApp chat"
      description="Choose a phone contact or enter a WhatsApp number. Opening a chat does not send a message."
      onClose={onClose}
    >
      <form
        className="wa-new-chat-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            const r = await accountApi<{ conversation: { id: string } }>(
              workspacePath('account/inbox/start', workspace),
              { phone, name },
            );
            onOpen(r.conversation.id);
            onClose();
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Unable to open chat.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-body">
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          <Field label="WhatsApp number" hint="Include country code, for example +91 9876543210.">
            <input
              aria-label="WhatsApp number"
              required
              type="tel"
              autoComplete="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </Field>
          <Field label="Contact name (optional)">
            <input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Find a phone contact">
            <input
              type="search"
              placeholder="Search name or number"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </Field>
          <div className="wa-phone-contacts" aria-label="Synced phone contacts">
            {loading ? (
              <p role="status">Loading saved phone contacts…</p>
            ) : contacts.length ? (
              contacts
                .filter((c) => `${c.name} ${c.phone}`.toLowerCase().includes(query.toLowerCase()))
                .slice(0, 30)
                .map((c) => (
                  <button
                    type="button"
                    key={c.id}
                    onClick={() => {
                      setPhone(`+${c.phone}`);
                      setName(c.name);
                    }}
                  >
                    <span>{c.name}</span>
                    <small>+{c.phone}</small>
                  </button>
                ))
            ) : (
              <p>Enter a number now, or sync chats to load available phone contacts.</p>
            )}
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <Submit busy={busy} disabled={!phone.trim()}>
            <MessageCircle size={16} />
            Open chat
          </Submit>
        </div>
      </form>
    </Modal>
  );
}
