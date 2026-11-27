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
import { replyBlockFor } from '@/lib/chat-reply-state';
import styles from './whatsapp-inbox.module.css';
import TeamConversationTools, { workspacePath } from './team-conversation-tools';
import type { ConversationMeta, TeamContext } from '@/lib/crm-types';

type InboxResponse = ChatInboxResponse;
type ConversationResponse = ChatDetailResponse;
type Contact = {
  id: string;
  name: string;
  phone: string;
  conversation?: ChatConversation;
  meta?: ConversationMeta;
};
type Props = {
  customers: Customer[];
  selectedCustomerId?: string | null;
  onSelect?: (id: string) => void;
  onOpenIntegration?: () => void;
  initialWorkspaceId?: string;
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
  initialWorkspaceId = '',
}: Props) {
  const ownUid = labClientAuth().currentUser?.uid || '';
  const [workspace, setWorkspace] = useState(
    initialWorkspaceId === ownUid ? '' : initialWorkspaceId,
  );
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const [team, setTeam] = useState<TeamContext | null>(null),
    [teamError, setTeamError] = useState('');
  const [assignmentFilter, setAssignmentFilter] = useState('all'),
    [labelFilter, setLabelFilter] = useState('');
  const isOwnWorkspace = !workspace || workspace === ownUid;
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
    let active = true;
    setTeam(null);
    setTeamError('');
    accountApi<TeamContext>(workspacePath('account/team', workspace))
      .then((result) => {
        if (active) setTeam(result);
      })
      .catch((error) => {
        if (active) setTeamError(error.message);
      });
    return () => {
      active = false;
    };
  }, [workspace]);
  function changeWorkspace(next: string) {
    inboxRequest.current++;
    detailRequest.current++;
    inboxInFlight.current = false;
    setInbox(null);
    setDetail(null);
    setSelected(null);
    setText('');
    sendAttempt.current = null;
    setAssignmentFilter('all');
    setLabelFilter('');
    setWorkspace(next === ownUid ? '' : next);
  }

  useEffect(() => {
    if (selectedCustomerId !== undefined) setSelected(selectedCustomerId || null);
  }, [selectedCustomerId]);

  const refreshInbox = useCallback(
    async (quiet = false) => {
      if (inboxInFlight.current) return;
      const uid = labClientAuth().currentUser?.uid;
      if (!uid) return;
      inboxInFlight.current = true;
      const request = ++inboxRequest.current;
      if (!quiet) setInboxLoading(true);
      try {
        const result = await accountApi<InboxResponse>(workspacePath('account/inbox', workspace));
        if (
          request !== inboxRequest.current ||
          labClientAuth().currentUser?.uid !== uid ||
          workspaceRef.current !== workspace
        )
          return;
        setInbox(result);
        setInboxError('');
        setLastSynced(new Date().toISOString());
      } catch (error) {
        if (request === inboxRequest.current && labClientAuth().currentUser?.uid === uid)
          setInboxError(
            error instanceof Error ? error.message : 'Unable to load your conversations.',
          );
      } finally {
        if (request === inboxRequest.current) {
          inboxInFlight.current = false;
          setInboxLoading(false);
        }
      }
    },
    [workspace],
  );

  const refreshDetail = useCallback(
    async (id: string, quiet = false) => {
      const uid = labClientAuth().currentUser?.uid;
      if (!uid) return;
      const request = ++detailRequest.current;
      if (!quiet) setDetailLoading(true);
      try {
        const result = await accountApi<ConversationResponse>(
          workspacePath(`account/inbox/${id}`, workspace),
        );
        if (
          request !== detailRequest.current ||
          selectedRef.current !== id ||
          workspaceRef.current !== workspace ||
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
    },
    [workspace],
  );

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
    for (const customer of isOwnWorkspace ? customers : team?.contacts || [])
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
    return [...items.values()]
      .map((item) => ({
        ...item,
        meta: inbox?.metadata?.[item.id] || {
          assignedTo: item.conversation?.assignedTo || null,
          labels: item.conversation?.labels || [],
          status: item.conversation?.status || 'open',
        },
      }))
      .sort((a, b) => {
        const difference =
          parsedTime(b.conversation?.lastMessageAt) - parsedTime(a.conversation?.lastMessageAt);
        return difference || a.name.localeCompare(b.name);
      });
  }, [customers, inbox, isOwnWorkspace, team]);
  const filteredContacts = contacts.filter(
    (contact) =>
      `${contact.name} ${contact.phone}`.toLowerCase().includes(query.toLowerCase()) &&
      (assignmentFilter !== 'mine' || contact.meta?.assignedTo === ownUid) &&
      (assignmentFilter !== 'open' || contact.meta?.status === 'open') &&
      (assignmentFilter !== 'resolved' || contact.meta?.status === 'resolved') &&
      (!labelFilter ||
        contact.meta?.labels.some((label) =>
          label.toLowerCase().includes(labelFilter.toLowerCase()),
        )),
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

  const personalConnection = (detail?.provider ?? inbox?.provider) === 'personal';
  const configured = detail?.configured ?? inbox?.configured ?? false;
  const windowOpen = !!detail?.windowOpen;
  const canWrite =
    (detail?.canWrite ?? inbox?.canWrite ?? team?.canWrite) !== false &&
    (isOwnWorkspace || !!team?.canWrite);
  const canReply = canWrite && configured && windowOpen && !!activeContact && !detailError;
  const webhookUrl = isOwnWorkspace ? detail?.webhookUrl || inbox?.webhookUrl : null;
  const reason = detail?.reason || inbox?.reason;
  const senderPhone = detail?.senderPhone || inbox?.senderPhone;
  const testSender = detail?.testSender ?? inbox?.testSender ?? false;
  const replyBlock =
    detail?.replyBlock ||
    (!canReply
      ? replyBlockFor({
          configured,
          windowOpen,
          hasInbound: !!detail?.conversation.lastInboundAt,
          reason,
          senderPhone,
        })
      : null);

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
      const result = await accountApi<{ message: ChatMessage }>(
        workspacePath(`account/inbox/${id}/send`, workspace),
        {
          text: value,
          requestId: attempt.requestId,
        },
      );
      if (
        labClientAuth().currentUser?.uid !== uid ||
        selectedRef.current !== id ||
        workspaceRef.current !== workspace
      )
        return;
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
      <div className="crm-inbox-workspace">
        <label>
          Inbox workspace
          <select
            aria-label="Inbox workspace"
            value={workspace || ownUid}
            onChange={(e) => changeWorkspace(e.target.value)}
          >
            {(
              team?.workspaces || [{ id: ownUid, name: 'My WhatsApp workspace', role: 'owner' }]
            ).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} · {w.role}
              </option>
            ))}
          </select>
        </label>
        {team && (
          <span className="badge muted">
            {team.role === 'viewer' ? 'Read-only access' : 'Team access: ' + team.role}
          </span>
        )}
      </div>
      {teamError && (
        <div className={styles.error} role="alert">
          {teamError}
        </div>
      )}
      {team?.contactsTruncated && (
        <p className="crm-muted">
          Showing the latest 200 registered customers along with recorded conversations.
        </p>
      )}
      {inboxError && (
        <div className={styles.error} role="alert">
          <AlertCircle size={16} />
          <span>{inboxError}</span>
        </div>
      )}
      {senderPhone && (
        <div
          className={`${styles.senderStatus} ${testSender ? styles.testSender : ''}`}
          role="status"
        >
          <div>
            <strong>
              {personalConnection ? 'Linked WhatsApp number' : 'API sending number'}: {senderPhone}
            </strong>
            <span>
              {personalConnection
                ? 'Personal / mobile WhatsApp'
                : testSender
                  ? 'Meta test number'
                  : inbox?.senderName || 'Connected business number'}
            </span>
          </div>
          <p>
            {personalConnection
              ? 'Individual messages use your linked WhatsApp. Manage this device from WhatsApp → Linked devices on your phone.'
              : testSender
                ? 'This API is connected to a Meta test number. It supports the test recipients added in Meta, and is not your lab’s mobile WhatsApp number. To use your lab number while keeping its WhatsApp Business app, use supported Coexistence onboarding.'
                : 'API messages use this number. A verified connection does not open a reply window for every customer.'}
          </p>
          {onOpenIntegration && isOwnWorkspace && (
            <button className="text-button" type="button" onClick={onOpenIntegration}>
              View connected number
            </button>
          )}
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
          {onOpenIntegration && isOwnWorkspace && (
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
          <div className="crm-inbox-filters">
            <select
              aria-label="Filter conversations"
              value={assignmentFilter}
              onChange={(e) => setAssignmentFilter(e.target.value)}
            >
              <option value="all">All conversations</option>
              <option value="mine">Assigned to me</option>
              <option value="open">Open</option>
              <option value="resolved">Resolved</option>
            </select>
            <input
              aria-label="Filter by label"
              placeholder="Filter by label"
              value={labelFilter}
              onChange={(e) => setLabelFilter(e.target.value)}
            />
          </div>
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
                    {!!item.meta?.labels.length && (
                      <span className="crm-contact-labels">{item.meta.labels.join(' · ')}</span>
                    )}
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
        <div
          className={`${styles.conversationPane} ${team && activeContact ? 'crm-chat-with-tools' : ''}`}
        >
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
              {team && activeContact && (
                <TeamConversationTools
                  key={(workspace || ownUid) + ':' + selected}
                  workspace={workspace}
                  customerId={activeContact.id}
                  context={team}
                  onQuickReply={setText}
                  onChanged={() => void refreshInbox(true)}
                />
              )}
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
                        {personalConnection
                          ? 'New messages from your linked WhatsApp will appear here. Existing phone chat history is not imported.'
                          : 'Messages received through the connected WhatsApp API will appear here. Existing chats in the WhatsApp app are not automatically imported.'}
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
                  <div className={styles.replyNote} id="whatsapp-reply-requirement" role="status">
                    <Clock3 size={15} />
                    <span>
                      <strong>
                        {!canWrite
                          ? 'Read-only team access'
                          : replyBlock?.title || 'API reply unavailable'}
                      </strong>
                      {!canWrite
                        ? 'Your role can view conversations. Ask the workspace owner for staff access to send replies or add notes.'
                        : replyBlock?.message ||
                          'Refresh this conversation before sending a reply.'}
                    </span>
                  </div>
                )}
                <div className={styles.composerInput}>
                  <textarea
                    aria-label="WhatsApp reply"
                    aria-describedby={
                      !canReply && !detailLoading ? 'whatsapp-reply-requirement' : undefined
                    }
                    placeholder={
                      !canWrite
                        ? 'Read-only team access'
                        : canReply
                          ? 'Type an API reply…'
                          : 'Draft a message for the WhatsApp app (API reply unavailable)…'
                    }
                    value={text}
                    maxLength={4096}
                    rows={2}
                    disabled={sending || !canWrite}
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
                    title={!canReply ? replyBlock?.title || 'API reply unavailable' : 'Send reply'}
                  >
                    {sending ? <LoaderCircle className="spin" size={20} /> : <Send size={20} />}
                  </button>
                </div>
                {canWrite && !canReply && activeContact && text.trim() && (
                  <a
                    className={`button secondary small-button ${styles.manualDraft}`}
                    href={chatLink(activeContact.phone, text.trim())}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink size={14} />
                    Open WhatsApp app with this draft
                  </a>
                )}
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
