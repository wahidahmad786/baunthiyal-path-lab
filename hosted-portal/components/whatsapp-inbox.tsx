'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CheckCheck,
  Clock3,
  Copy,
  ExternalLink,
  LoaderCircle,
  MessageCircle,
  RefreshCw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
} from 'lucide-react';
import type { Customer } from '@/lib/domain';
import type {
  ChatConversation,
  ChatMessage,
  ChatMessageStatus,
  ChatInboxResponse,
  ChatDetailResponse,
} from '@/lib/chat-types';
import { labClientAuth } from '@/lib/client-auth';
import { accountApi } from './ui';
import styles from './whatsapp-inbox.module.css';

type InboxResponse = ChatInboxResponse;
type ConversationResponse = ChatDetailResponse;
type Contact = {
  id: string;
  name: string;
  phone: string;
  conversation?: ChatConversation;
};
type Props = {
  customers: Customer[];
  selectedCustomerId?: string | null;
  onSelect?: (id: string) => void;
  onOpenIntegration?: () => void;
};

const labels: Record<ChatMessageStatus, string> = {
  received: 'Received',
  submitting: 'Submitting',
  accepted: 'Accepted by WhatsApp',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
  failed: 'Failed',
  unknown: 'Delivery unconfirmed',
};
function parsedTime(value?: string | null) {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : 0;
}
function messageTime(value?: string | null) {
  const time = parsedTime(value);
  return time
    ? new Date(time).toLocaleTimeString('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';
}
function messageDay(value: string) {
  const time = parsedTime(value);
  return time
    ? new Date(time).toLocaleDateString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : '';
}
function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}
function chatLink(phone: string, text = '') {
  const digits = phone.replace(/\D/g, '');
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}
function Delivery({ status, compact = false }: { status: ChatMessageStatus; compact?: boolean }) {
  const Icon =
    status === 'read' || status === 'delivered'
      ? CheckCheck
      : status === 'sent' || status === 'received'
        ? Check
        : status === 'failed'
          ? AlertCircle
          : status === 'submitting'
            ? LoaderCircle
            : Clock3;
  return (
    <span
      className={`${styles.delivery} ${status === 'read' ? styles.read : ''} ${status === 'failed' ? styles.failed : ''}`}
      title={labels[status]}
      aria-label={labels[status]}
    >
      <Icon size={compact ? 13 : 14} className={status === 'submitting' ? 'spin' : undefined} />
      {!compact && <span>{labels[status]}</span>}
    </span>
  );
}

export default function WhatsAppInbox({
  customers,
  selectedCustomerId,
  onSelect,
  onOpenIntegration,
}: Props) {
  const [selected, setSelected] = useState<string | null>(selectedCustomerId || null);
  const [query, setQuery] = useState('');
  const [inbox, setInbox] = useState<InboxResponse | null>(null);
  const [detail, setDetail] = useState<ConversationResponse | null>(null);
  const [inboxLoading, setInboxLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [inboxError, setInboxError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [copyMessage, setCopyMessage] = useState('');
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const inboxRequest = useRef(0);
  const detailRequest = useRef(0);
  const inboxInFlight = useRef(false);
  const scrollArea = useRef<HTMLDivElement>(null);
  const sendAttempt = useRef<{ customerId: string; text: string; requestId: string } | null>(null);
  const selectedRef = useRef<string | null>(selected);
  selectedRef.current = selected;

  useEffect(() => {
    if (selectedCustomerId !== undefined) setSelected(selectedCustomerId || null);
  }, [selectedCustomerId]);

  const refreshInbox = useCallback(async (quiet = false) => {
    if (inboxInFlight.current) return;
    const uid = labClientAuth().currentUser?.uid;
    if (!uid) return;
    inboxInFlight.current = true;
    const request = ++inboxRequest.current;
    if (!quiet) setInboxLoading(true);
    try {
      const result = await accountApi<InboxResponse>('account/inbox');
      if (request !== inboxRequest.current || labClientAuth().currentUser?.uid !== uid) return;
      setInbox(result);
      setInboxError('');
      setLastSynced(new Date().toISOString());
    } catch (error) {
      if (request === inboxRequest.current && labClientAuth().currentUser?.uid === uid)
        setInboxError(
          error instanceof Error ? error.message : 'Unable to load your conversations.',
        );
    } finally {
      inboxInFlight.current = false;
      if (request === inboxRequest.current) setInboxLoading(false);
    }
  }, []);

  const refreshDetail = useCallback(async (id: string, quiet = false) => {
    const uid = labClientAuth().currentUser?.uid;
    if (!uid) return;
    const request = ++detailRequest.current;
    if (!quiet) setDetailLoading(true);
    try {
      const result = await accountApi<ConversationResponse>(`account/inbox/${id}`);
      if (
        request !== detailRequest.current ||
        selectedRef.current !== id ||
        labClientAuth().currentUser?.uid !== uid
      )
        return;
      setDetail(result);
      setDetailError('');
    } catch (error) {
      if (
        request === detailRequest.current &&
        selectedRef.current === id &&
        labClientAuth().currentUser?.uid === uid
      )
        setDetailError(
          error instanceof Error ? error.message : 'Unable to load this conversation.',
        );
    } finally {
      if (request === detailRequest.current) setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshInbox();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refreshInbox(true);
    }, 15000);
    return () => {
      clearInterval(timer);
      inboxRequest.current++;
      inboxInFlight.current = false;
    };
  }, [refreshInbox]);

  useEffect(() => {
    detailRequest.current++;
    setDetail(null);
    setDetailError('');
    setSendError('');
    setText('');
    sendAttempt.current = null;
    if (!selected) return;
    void refreshDetail(selected);
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refreshDetail(selected, true);
    }, 15000);
    return () => {
      clearInterval(timer);
      detailRequest.current++;
    };
  }, [selected, refreshDetail]);

  const contacts = useMemo(() => {
    const items = new Map<string, Contact>();
    for (const customer of customers)
      items.set(customer.id, {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
      });
    for (const conversation of inbox?.conversations || []) {
      const id = conversation.customerId || conversation.id;
      const customer = items.get(id);
      items.set(id, {
        id,
        name: customer?.name || conversation.customerName || `+${conversation.phone}`,
        phone: customer?.phone || conversation.phone,
        conversation,
      });
    }
    return [...items.values()].sort((a, b) => {
      const difference =
        parsedTime(b.conversation?.lastMessageAt) - parsedTime(a.conversation?.lastMessageAt);
      return difference || a.name.localeCompare(b.name);
    });
  }, [customers, inbox]);
  const filteredContacts = contacts.filter((contact) =>
    `${contact.name} ${contact.phone}`.toLowerCase().includes(query.toLowerCase()),
  );
  const contact = contacts.find((item) => item.id === selected);
  const activeContact: Contact | null =
    contact ||
    (detail && detail.conversation.id === selected
      ? {
          id: detail.conversation.id,
          name: detail.conversation.customerName || `+${detail.conversation.phone}`,
          phone: detail.conversation.phone,
          conversation: detail.conversation,
        }
      : null);
  const messages = useMemo(() => {
    const byId = new Map<string, ChatMessage>();
    for (const message of detail?.messages || []) byId.set(message.id, message);
    return [...byId.values()].sort((a, b) => parsedTime(a.createdAt) - parsedTime(b.createdAt));
  }, [detail]);
  const latestMessage = messages.at(-1);
  useEffect(() => {
    const area = scrollArea.current;
    if (!area) return;
    area.scrollTop = area.scrollHeight;
  }, [selected, latestMessage?.id]);

  const configured = detail?.configured ?? inbox?.configured ?? false;
  const windowOpen = !!detail?.windowOpen;
  const canReply = configured && windowOpen && !!activeContact && !detailError;
  const webhookUrl = detail?.webhookUrl || inbox?.webhookUrl;
  const reason = detail?.reason || inbox?.reason;

  async function sendMessage() {
    const id = selected;
    const value = text.trim();
    const uid = labClientAuth().currentUser?.uid;
    if (!id || !uid || !value || !canReply || sending) return;
    if (
      !sendAttempt.current ||
      sendAttempt.current.customerId !== id ||
      sendAttempt.current.text !== value
    )
      sendAttempt.current = { customerId: id, text: value, requestId: crypto.randomUUID() };
    const attempt = sendAttempt.current;
    setSending(true);
    setSendError('');
    try {
      const result = await accountApi<{ message: ChatMessage }>(`account/inbox/${id}/send`, {
        text: value,
        requestId: attempt.requestId,
      });
      if (labClientAuth().currentUser?.uid !== uid || selectedRef.current !== id) return;
      setDetail((current) =>
        current
          ? {
              ...current,
              recorded: true,
              // A signed status may already have arrived while the send response was in flight.
              // Keep its recorded state, then refresh the authoritative history below.
              messages: current.messages.some((message) => message.id === result.message.id)
                ? current.messages
                : [...current.messages, result.message],
            }
          : current,
      );
      if (['accepted', 'sent', 'delivered', 'read'].includes(result.message.status)) {
        setText('');
        sendAttempt.current = null;
      } else {
        setSendError(
          result.message.error ||
            'This message has not been confirmed as sent. Check its recorded status before trying again.',
        );
      }
      void refreshInbox(true);
      void refreshDetail(id, true);
    } catch (error) {
      if (labClientAuth().currentUser?.uid === uid && selectedRef.current === id) {
        setSendError(error instanceof Error ? error.message : 'Unable to send your message.');
        // Read the persisted attempt; a lost response never becomes a fabricated sent state.
        void refreshDetail(id, true);
      }
    } finally {
      setSending(false);
    }
  }

  function chooseContact(id: string) {
    setSelected(id);
    onSelect?.(id);
  }

  return (
    <section className={styles.inbox} aria-label="WhatsApp conversations">
      <div className={styles.heading}>
        <div>
          <span className={styles.headingIcon}>
            <MessageCircle size={23} />
          </span>
          <div>
            <h2>WhatsApp inbox</h2>
            <p>Conversations, replies and delivery updates in one place.</p>
          </div>
        </div>
        <div className={styles.headingActions}>
          <span>Auto-refresh · 15 sec</span>
          <button
            type="button"
            className="button secondary small-button"
            onClick={() => {
              void refreshInbox();
              if (selected) void refreshDetail(selected, true);
            }}
            disabled={inboxLoading}
          >
            <RefreshCw size={15} className={inboxLoading ? 'spin' : undefined} />
            Refresh
          </button>
        </div>
      </div>
      {inboxError && (
        <div className={styles.error} role="alert">
          <AlertCircle size={16} />
          <span>{inboxError}</span>
        </div>
      )}
      {inbox && !inbox.configured && (
        <div className={styles.connectionNote} role="status">
          <ShieldCheck size={18} />
          <div>
            <strong>Connect live WhatsApp messages</strong>
            <p>
              {inbox.reason ||
                'Connect the official WhatsApp API and its signed webhook to receive messages here.'}{' '}
              You can open a customer in WhatsApp while completing the connection.
            </p>
          </div>
          {onOpenIntegration && (
            <button className="button secondary small-button" onClick={onOpenIntegration}>
              <Settings2 size={14} />
              Connection
            </button>
          )}
        </div>
      )}
      {webhookUrl && (
        <details className={styles.webhook}>
          <summary>WhatsApp callback URL</summary>
          <p>Use this callback URL when subscribing your WhatsApp app in Meta.</p>
          <div>
            <input aria-label="WhatsApp callback URL" readOnly value={webhookUrl} />
            <button
              type="button"
              className="button secondary small-button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(webhookUrl);
                  setCopyMessage('Callback URL copied.');
                } catch {
                  setCopyMessage('Select the callback URL and copy it.');
                }
              }}
            >
              <Copy size={14} /> Copy
            </button>
          </div>
          {copyMessage && <small role="status">{copyMessage}</small>}
        </details>
      )}
      <div className={`${styles.shell} ${selected ? styles.hasSelection : ''}`}>
        <aside className={styles.threads} aria-label="Customer conversations">
          <div className={styles.threadHeading}>
            <h3>Customers</h3>
            <span>{contacts.length}</span>
          </div>
          <label className={styles.search}>
            <Search size={16} />
            <input
              aria-label="Search WhatsApp customers"
              placeholder="Search name or phone"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className={styles.contactList}>
            {inboxLoading && !inbox && !contacts.length ? (
              <div className={styles.smallEmpty} role="status">
                <LoaderCircle className="spin" size={20} /> Loading conversations…
              </div>
            ) : filteredContacts.length ? (
              filteredContacts.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className={`${styles.contact} ${selected === item.id ? styles.selected : ''}`}
                  onClick={() => chooseContact(item.id)}
                  aria-pressed={selected === item.id}
                >
                  <span className={styles.avatar}>
                    {initials(item.name) || <MessageCircle size={18} />}
                  </span>
                  <span className={styles.contactBody}>
                    <span className={styles.contactName}>
                      <strong>{item.name}</strong>
                      <small>{messageTime(item.conversation?.lastMessageAt)}</small>
                    </span>
                    <span className={styles.contactPhone}>+{item.phone.replace(/\D/g, '')}</span>
                    <span className={styles.contactPreview}>
                      {item.conversation?.lastMessageStatus && (
                        <Delivery status={item.conversation.lastMessageStatus} compact />
                      )}
                      <span>
                        {item.conversation?.lastMessagePreview || 'No portal message recorded'}
                      </span>
                    </span>
                  </span>
                </button>
              ))
            ) : (
              <div className={styles.smallEmpty}>
                <MessageCircle size={26} />
                <strong>{query ? 'No matching customers' : 'Your conversations start here'}</strong>
                <p>
                  {query
                    ? 'Try another name or phone number.'
                    : 'Registered customers and incoming API conversations will appear here.'}
                </p>
              </div>
            )}
          </div>
          <div className={styles.threadFooter}>
            <ShieldCheck size={13} />
            {lastSynced ? `Updated ${messageTime(lastSynced)}` : 'Private to your workspace'}
          </div>
        </aside>
        <div className={styles.conversationPane}>
          {selected && (activeContact || detailLoading || detailError) ? (
            <>
              <header className={styles.chatHeader}>
                <button
                  type="button"
                  className={`icon-button ${styles.backButton}`}
                  onClick={() => setSelected(null)}
                  aria-label="Back to customers"
                >
                  <ArrowLeft size={20} />
                </button>
                <span className={styles.avatar}>
                  {initials(activeContact?.name || '') || <MessageCircle size={18} />}
                </span>
                <div className={styles.chatTitle}>
                  <h3>
                    {activeContact?.name ||
                      (detailLoading ? 'Loading conversation…' : 'Conversation')}
                  </h3>
                  <p>
                    {activeContact
                      ? `+${activeContact.phone.replace(/\D/g, '')}`
                      : detailError
                        ? 'Unable to open this conversation'
                        : 'Checking recorded messages'}
                  </p>
                </div>
                {activeContact && (
                  <a
                    className={`button secondary small-button ${styles.openApp}`}
                    href={chatLink(activeContact.phone, text.trim())}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink size={14} /> Open WhatsApp
                  </a>
                )}
              </header>
              <div
                className={styles.messages}
                ref={scrollArea}
                role="log"
                aria-label="Recorded WhatsApp messages"
                aria-live="polite"
              >
                {detailError && (
                  <div className={styles.error} role="alert">
                    <AlertCircle size={16} />
                    <span>{detailError}</span>
                  </div>
                )}
                {detailLoading && !detail ? (
                  <div className={styles.chatEmpty} role="status">
                    <LoaderCircle className="spin" size={24} />
                    <p>Loading recorded messages…</p>
                  </div>
                ) : messages.length ? (
                  messages.map((message, index) => {
                    const day = messageDay(message.createdAt);
                    const showDay =
                      index === 0 || day !== messageDay(messages[index - 1].createdAt);
                    return (
                      <div key={message.id}>
                        {showDay && day && (
                          <div className={styles.day}>
                            <span>{day}</span>
                          </div>
                        )}
                        <div
                          className={`${styles.messageRow} ${message.direction === 'outbound' ? styles.outbound : styles.inbound}`}
                        >
                          <article className={styles.bubble}>
                            <p>
                              {message.text ||
                                (message.type === 'unsupported'
                                  ? 'A message type that is not displayed in this inbox.'
                                  : '')}
                            </p>
                            <div className={styles.messageMeta}>
                              <time dateTime={message.createdAt}>
                                {messageTime(message.createdAt)}
                              </time>
                              <Delivery status={message.status} />
                            </div>
                            {message.error && (
                              <small className={styles.messageError}>{message.error}</small>
                            )}
                            {message.direction === 'outbound' && message.status === 'failed' && (
                              <button
                                type="button"
                                className={styles.retry}
                                onClick={() => {
                                  setText(message.text);
                                  setSendError('');
                                  sendAttempt.current = null;
                                }}
                              >
                                Retry in composer
                              </button>
                            )}
                          </article>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  !detailError && (
                    <div className={styles.chatEmpty}>
                      <span className={styles.emptyChatIcon}>
                        <MessageCircle size={31} />
                      </span>
                      <h3>No portal message recorded</h3>
                      <p>
                        Messages received through the connected WhatsApp API will appear here.
                        Existing chats in the WhatsApp app are not automatically imported.
                      </p>
                      {activeContact && (
                        <a
                          className="button secondary small-button"
                          href={chatLink(activeContact.phone)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <ExternalLink size={14} /> Open this customer in WhatsApp
                        </a>
                      )}
                    </div>
                  )
                )}
              </div>
              <form
                className={styles.composer}
                onSubmit={(event) => {
                  event.preventDefault();
                  void sendMessage();
                }}
              >
                {sendError && (
                  <div className={styles.error} role="alert">
                    <AlertCircle size={15} />
                    <span>{sendError}</span>
                  </div>
                )}
                {!canReply && !detailLoading && (
                  <div className={styles.replyNote}>
                    <Clock3 size={15} />
                    <span>
                      {!configured
                        ? reason || 'Connect live WhatsApp messages to reply from this inbox.'
                        : !windowOpen
                          ? 'Portal replies are available for 24 hours after a customer messages you. Outside this window, use an approved template or open WhatsApp.'
                          : 'Refresh this conversation before sending a reply.'}
                    </span>
                  </div>
                )}
                <div className={styles.composerInput}>
                  <textarea
                    aria-label="WhatsApp reply"
                    placeholder={
                      canReply ? 'Type a reply…' : 'Write a message to open in WhatsApp…'
                    }
                    value={text}
                    maxLength={4096}
                    rows={2}
                    disabled={sending}
                    onChange={(event) => {
                      setText(event.target.value);
                      setSendError('');
                    }}
                    onKeyDown={(event) => {
                      if (
                        event.key === 'Enter' &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing &&
                        canReply
                      ) {
                        event.preventDefault();
                        void sendMessage();
                      }
                    }}
                  />
                  <button
                    type="submit"
                    className={styles.sendButton}
                    disabled={!canReply || !text.trim() || sending}
                    aria-label="Send WhatsApp reply"
                    title={
                      !canReply
                        ? 'See the connection or reply-window requirement above.'
                        : 'Send reply'
                    }
                  >
                    {sending ? <LoaderCircle className="spin" size={20} /> : <Send size={20} />}
                  </button>
                </div>
                <small>
                  Delivery and read ticks come from WhatsApp. Opening the app does not mark a
                  message as sent here.
                </small>
              </form>
            </>
          ) : (
            <div className={styles.welcome}>
              <span className={styles.welcomeIcon}>
                <MessageCircle size={50} strokeWidth={1.3} />
              </span>
              <h3>Every conversation, cared for.</h3>
              <p>
                Select a customer to view recorded WhatsApp messages, check their delivery status or
                open a chat in WhatsApp.
              </p>
              <span className={styles.trust}>
                <ShieldCheck size={15} /> Private conversations · Real message status
              </span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
