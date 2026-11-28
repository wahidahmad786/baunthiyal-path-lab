'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CheckCheck,
  Clock3,
  ExternalLink,
  ListFilter,
  LoaderCircle,
  MessageCircle,
  Paperclip,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
} from 'lucide-react';
import { startVisiblePolling } from '@/lib/visible-polling';
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
import WhatsAppNewChat from './whatsapp-new-chat';
import {
  acceptedAttachmentFiles,
  AttachmentDraftPreview,
  InboxAttachmentView,
  maxAttachmentCaption,
  messageAttachment,
  uploadInboxAttachment,
  validateAttachmentFile,
  type AttachmentFile,
} from './whatsapp-inbox-attachments';
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
  onSelect?: (id: string | null) => void;
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
    .replace(/^\+?[\d\s()-]+$/, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}
const photoRequests: (() => void)[] = [];
let activePhotoRequests = 0;
function runPhotoRequests() {
  while (activePhotoRequests < 3 && photoRequests.length) {
    activePhotoRequests++;
    photoRequests.shift()?.();
  }
}
function schedulePhoto(request: AbortSignal, load: () => Promise<void>) {
  const queued = () => {
    void Promise.resolve()
      .then(() => {
        if (!request.aborted) return load();
      })
      .finally(() => {
        activePhotoRequests--;
        runPhotoRequests();
      });
  };
  photoRequests.push(queued);
  runPhotoRequests();
  const cancelQueued = () => {
    const pending = photoRequests.indexOf(queued);
    if (pending !== -1) photoRequests.splice(pending, 1);
  };
  request.addEventListener('abort', cancelQueued, { once: true });
}
function usePrivateImage(path?: string) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [result, setResult] = useState<{ path: string; url?: string } | null>(null);
  useEffect(() => {
    const element = anchor.current;
    if (!path || !element) return;
    const request = new AbortController();
    let observer: IntersectionObserver | undefined;
    let url: string | undefined;
    const load = async () => {
      try {
        const user = labClientAuth().currentUser;
        if (!user) throw new Error('Sign in required');
        const token = await user.getIdToken();
        const response = await fetch(path, {
          headers: { Authorization: 'Bearer ' + token },
          cache: 'no-store',
          signal: request.signal,
        });
        if (
          !response.ok ||
          !/^image\/(?:jpeg|png|webp|gif|avif)(?:;|$)/i.test(
            response.headers.get('Content-Type') || '',
          )
        )
          throw new Error('Photo unavailable');
        const blob = await response.blob();
        if (request.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setResult({ path, url });
      } catch {
        if (!request.signal.aborted) setResult({ path });
      }
    };
    let scheduled = false;
    const start = () => {
      if (scheduled || request.signal.aborted) return;
      scheduled = true;
      observer?.disconnect();
      schedulePhoto(request.signal, load);
    };
    if (typeof IntersectionObserver === 'undefined') start();
    else {
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) start();
        },
        { rootMargin: '32px' },
      );
      observer.observe(element);
    }
    return () => {
      observer?.disconnect();
      request.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [path]);
  return {
    anchor,
    url: result?.path === path ? result?.url : undefined,
    pending: !!path && result?.path !== path,
  };
}
function ChatAvatar({ name, path }: { name: string; path?: string }) {
  const image = usePrivateImage(path);
  const [broken, setBroken] = useState('');
  return (
    <span className={styles.avatar} ref={image.anchor} aria-hidden="true">
      {image.url && image.url !== broken ? (
        <img src={image.url} alt="" onError={() => setBroken(image.url || '')} />
      ) : (
        initials(name) || <MessageCircle size={18} />
      )}
    </span>
  );
}
function chatLink(phone: string, text = '') {
  const digits = phone.replace(/\D/g, '');
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}
function Delivery({ status }: { status: ChatMessageStatus }) {
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
      <Icon size={14} className={status === 'submitting' ? 'spin' : undefined} />
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
  const [showFilters, setShowFilters] = useState(false);
  const [inbox, setInbox] = useState<InboxResponse | null>(null);
  const [detail, setDetail] = useState<ConversationResponse | null>(null);
  const [inboxLoading, setInboxLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [inboxError, setInboxError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [text, setText] = useState('');
  const [attachmentDraft, setAttachmentDraft] = useState<AttachmentFile | null>(null);
  const [caption, setCaption] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const captionInput = useRef<HTMLTextAreaElement>(null);
  const attachmentAttempt = useRef<{
    customerId: string;
    workspace: string;
    file: File;
    caption: string;
    requestId: string;
  } | null>(null);
  const sendInFlight = useRef(false);
  const [sending, setSending] = useState(false);
  const [newChat, setNewChat] = useState(false),
    [syncBusy, setSyncBusy] = useState(false),
    [syncError, setSyncError] = useState('');
  const [olderMessages, setOlderMessages] = useState<ChatMessage[]>([]),
    [olderBefore, setOlderBefore] = useState<string | null>(null),
    [olderLoaded, setOlderLoaded] = useState(false),
    [olderLoading, setOlderLoading] = useState(false);
  const restoreScroll = useRef<{ height: number; top: number } | null>(null);

  const [sendError, setSendError] = useState('');
  const inboxRevision = useRef<string | undefined>(undefined),
    detailRevision = useRef<string | undefined>(undefined);
  const inboxRequest = useRef(0);
  const detailRequest = useRef(0);
  const inboxInFlight = useRef(false);
  const scrollArea = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
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
    inboxRevision.current = undefined;
    detailRevision.current = undefined;
    inboxRequest.current++;
    detailRequest.current++;
    inboxInFlight.current = false;
    setInbox(null);
    setDetail(null);
    setSelected(null);
    onSelect?.(null);
    setQuery('');
    setShowFilters(false);
    setNewChat(false);
    setSyncError('');
    setText('');
    clearAttachment();
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
        const inboxPath = workspacePath('account/inbox', workspace);
        const result = await accountApi<InboxResponse>(
          inboxPath +
            (inboxRevision.current
              ? (inboxPath.includes('?') ? '&' : '?') +
                'revision=' +
                encodeURIComponent(inboxRevision.current)
              : ''),
        );
        if (
          request !== inboxRequest.current ||
          labClientAuth().currentUser?.uid !== uid ||
          workspaceRef.current !== workspace
        )
          return;
        inboxRevision.current = result.revision;
        setInbox((old) =>
          result.unchanged && old
            ? { ...old, ...result, conversations: old.conversations, metadata: old.metadata }
            : result,
        );
        setInboxError('');
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
          (() => {
            const path = workspacePath(`account/inbox/${id}`, workspace);
            return (
              path +
              (detailRevision.current
                ? (path.includes('?') ? '&' : '?') +
                  'revision=' +
                  encodeURIComponent(detailRevision.current)
                : '')
            );
          })(),
        );
        if (
          request !== detailRequest.current ||
          selectedRef.current !== id ||
          workspaceRef.current !== workspace ||
          labClientAuth().currentUser?.uid !== uid
        )
          return;
        detailRevision.current = result.revision;
        setDetail((old) =>
          result.unchanged && old
            ? {
                ...old,
                ...result,
                conversation: old.conversation,
                messages: old.messages,
                recorded: old.recorded,
              }
            : result,
        );
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
    const stop = startVisiblePolling(() => refreshInbox(true), 5000);
    return () => {
      stop();
      inboxRequest.current++;
      inboxInFlight.current = false;
    };
  }, [refreshInbox]);

  useEffect(() => {
    detailRequest.current++;
    detailRevision.current = undefined;
    followLatest.current = true;
    restoreScroll.current = null;
    setDetail(null);
    setOlderMessages([]);
    setOlderBefore(null);
    setOlderLoaded(false);
    setOlderLoading(false);
    setDetailError('');
    setSendError('');
    setText('');
    clearAttachment();
    sendAttempt.current = null;
    if (!selected) return;
    void refreshDetail(selected);
    const stop = startVisiblePolling(() => refreshDetail(selected, true), 5000);
    return () => {
      stop();
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
  }, [customers, inbox?.conversations, inbox?.metadata, isOwnWorkspace, team?.contacts]);
  const filteredContacts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const labelNeedle = labelFilter.trim().toLowerCase();
    return contacts.filter(
      (contact) =>
        (!needle || `${contact.name} ${contact.phone}`.toLowerCase().includes(needle)) &&
        (assignmentFilter !== 'mine' || contact.meta?.assignedTo === ownUid) &&
        (assignmentFilter !== 'open' || contact.meta?.status === 'open') &&
        (assignmentFilter !== 'resolved' || contact.meta?.status === 'resolved') &&
        (!labelNeedle ||
          contact.meta?.labels.some((label) => label.toLowerCase().includes(labelNeedle))),
    );
  }, [contacts, query, assignmentFilter, ownUid, labelFilter]);
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
    for (const message of olderMessages) byId.set(message.id, message);
    for (const message of detail?.messages || []) byId.set(message.id, message);
    return [...byId.values()].sort((a, b) => parsedTime(a.createdAt) - parsedTime(b.createdAt));
  }, [detail?.messages, olderMessages]);
  const latestMessage = messages.at(-1);
  useEffect(() => {
    const area = scrollArea.current;
    if (area && followLatest.current) area.scrollTop = area.scrollHeight;
  }, [selected, latestMessage?.id]);

  useEffect(() => {
    if (restoreScroll.current && scrollArea.current) {
      const old = restoreScroll.current;
      scrollArea.current.scrollTop = scrollArea.current.scrollHeight - old.height + old.top;
      restoreScroll.current = null;
    }
  }, [olderMessages.length]);
  const personalConnection = (detail?.provider ?? inbox?.provider) === 'personal';
  const configured = detail?.configured ?? inbox?.configured ?? false;
  const canSync =
    personalConnection && configured && (inbox?.role || team?.role || 'owner') === 'owner';
  const windowOpen = !!detail?.windowOpen;
  const canWrite =
    (detail?.canWrite ?? inbox?.canWrite ?? team?.canWrite) !== false &&
    (isOwnWorkspace || !!team?.canWrite);
  const canReply =
    canWrite &&
    configured &&
    windowOpen &&
    !!activeContact &&
    detail?.conversation.id === selected &&
    activeContact.id === selected &&
    !detailError;
  const canAttach = personalConnection && canReply;
  const draftCanHaveCaption = attachmentDraft && attachmentDraft.kind !== 'audio';
  const reason = detail?.reason || inbox?.reason;
  const senderPhone = detail?.senderPhone || inbox?.senderPhone;
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

  function clearAttachment() {
    setAttachmentDraft(null);
    setCaption('');
    attachmentAttempt.current = null;
    if (fileInput.current) fileInput.current.value = '';
  }

  function chooseAttachment(file?: File) {
    if (!file || !canAttach || sendInFlight.current) return;
    try {
      const next = validateAttachmentFile(file);
      setAttachmentDraft(next);
      if (next.kind === 'audio') setCaption('');
      attachmentAttempt.current = null;
      setSendError('');
      if (next.kind !== 'audio') requestAnimationFrame(() => captionInput.current?.focus());
    } catch (error) {
      setSendError(error instanceof Error ? error.message : 'Could not attach this file.');
    }
  }

  async function sendMessage() {
    const id = selected;
    const draft = attachmentDraft;
    const value = (draftCanHaveCaption ? caption : draft ? '' : text).trim();
    const uid = labClientAuth().currentUser?.uid;
    if (!id || !uid || !canReply || (draft ? !canAttach : !value) || sendInFlight.current) return;
    sendInFlight.current = true;
    setSending(true);
    setSendError('');
    try {
      let result: { message: ChatMessage };
      if (draft) {
        const existing = attachmentAttempt.current;
        const requestId =
          existing?.customerId === id &&
          existing.workspace === workspace &&
          existing.file === draft.file &&
          existing.caption === value
            ? existing.requestId
            : crypto.randomUUID();
        attachmentAttempt.current = {
          customerId: id,
          workspace,
          file: draft.file,
          caption: value,
          requestId,
        };
        result = await uploadInboxAttachment(
          workspacePath(
            '/api/account/inbox/' + encodeURIComponent(id) + '/send-attachment',
            workspace,
          ),
          draft.file,
          value,
          requestId,
        );
      } else {
        if (
          !sendAttempt.current ||
          sendAttempt.current.customerId !== id ||
          sendAttempt.current.text !== value
        )
          sendAttempt.current = { customerId: id, text: value, requestId: crypto.randomUUID() };
        result = await accountApi<{ message: ChatMessage }>(
          workspacePath(`account/inbox/${id}/send`, workspace),
          { text: value, requestId: sendAttempt.current.requestId },
        );
      }
      if (
        labClientAuth().currentUser?.uid !== uid ||
        selectedRef.current !== id ||
        workspaceRef.current !== workspace
      )
        return;
      followLatest.current = true;
      setDetail((current) =>
        current
          ? {
              ...current,
              recorded: true,
              // A delivery status may already have arrived from the provider while the send was in flight.
              messages: current.messages.some((message) => message.id === result.message.id)
                ? current.messages
                : [...current.messages, result.message],
            }
          : current,
      );
      if (['accepted', 'sent', 'delivered', 'read'].includes(result.message.status)) {
        if (draft) clearAttachment();
        else {
          setText('');
          sendAttempt.current = null;
        }
      } else {
        setSendError(
          result.message.error ||
            (draft
              ? 'This file has not been confirmed as sent. Check the message status before clicking Send again.'
              : 'This message has not been confirmed as sent. Check its recorded status before trying again.'),
        );
      }
      void refreshInbox(true);
      void refreshDetail(id, true);
    } catch (error) {
      if (
        labClientAuth().currentUser?.uid === uid &&
        selectedRef.current === id &&
        workspaceRef.current === workspace
      ) {
        setSendError(error instanceof Error ? error.message : 'Unable to send your message.');
        // Read the persisted attempt; a lost response never becomes a fabricated sent state.
        void refreshDetail(id, true);
      }
    } finally {
      sendInFlight.current = false;
      setSending(false);
    }
  }

  async function syncChats() {
    setSyncBusy(true);
    setSyncError('');
    try {
      const r = await accountApi<{ history: InboxResponse['history'] }>(
        workspacePath('account/inbox/sync', workspace),
        {},
      );
      setInbox((old) => (old ? { ...old, history: r.history } : old));
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : 'Chat sync could not start.');
    } finally {
      setSyncBusy(false);
    }
  }
  async function loadEarlier() {
    const cursor = olderLoaded ? olderBefore : detail?.nextBefore,
      chatId = selected,
      actor = labClientAuth().currentUser?.uid,
      space = workspace;
    if (!cursor || !chatId || olderLoading) return;
    setOlderLoading(true);
    try {
      const base = workspacePath(`account/inbox/${chatId}`, space),
        url = base + (base.includes('?') ? '&' : '?') + 'before=' + encodeURIComponent(cursor);
      const page = await accountApi<ConversationResponse>(url);
      if (
        selectedRef.current !== chatId ||
        workspaceRef.current !== space ||
        labClientAuth().currentUser?.uid !== actor
      )
        return;
      if (scrollArea.current)
        restoreScroll.current = {
          height: scrollArea.current.scrollHeight,
          top: scrollArea.current.scrollTop,
        };
      setOlderMessages((old) => [...old, ...(detail?.messages || []), ...page.messages]);
      setOlderBefore(page.nextBefore || null);
      setOlderLoaded(true);
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : 'Earlier messages could not load.');
    } finally {
      setOlderLoading(false);
    }
  }
  function chooseContact(id: string) {
    if (selectedRef.current !== id) {
      setText('');
      clearAttachment();
      setSendError('');
      sendAttempt.current = null;
    }
    setSelected(id);
    onSelect?.(id);
    if (window.matchMedia('(max-width: 690px)').matches)
      setTimeout(
        () =>
          document
            .getElementById('whatsapp-chat-pane')
            ?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
        50,
      );
  }

  return (
    <section className={styles.inbox} aria-label="WhatsApp conversations">
      {inbox?.history?.phase === 'needs_relink' && onOpenIntegration && isOwnWorkspace && (
        <div className={styles.notice} role="status">
          <span>Chat history sync needs a fresh link.</span>
          <button type="button" className="text-button" onClick={onOpenIntegration}>
            Open WhatsApp Integration
          </button>
        </div>
      )}
      {syncError && (
        <div className={styles.error} role="alert">
          {syncError}
        </div>
      )}
      {teamError && (
        <div className={styles.error} role="alert">
          {teamError}
        </div>
      )}
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
          {onOpenIntegration && isOwnWorkspace && (
            <button className="button secondary small-button" onClick={onOpenIntegration}>
              <Settings2 size={14} />
              Connection
            </button>
          )}
        </div>
      )}
      <div className={`${styles.shell} ${selected ? styles.hasSelection : ''}`}>
        <aside className={styles.threads} aria-label="Customer conversations">
          <div className={styles.threadHeading}>
            <h2>Chats</h2>
            <div className={styles.toolbar}>
              {personalConnection && canWrite && (
                <button
                  type="button"
                  className={styles.iconAction}
                  onClick={() => setNewChat(true)}
                  aria-label="New WhatsApp chat"
                  title="New chat"
                >
                  <Plus size={21} />
                </button>
              )}
              <button
                type="button"
                className={styles.iconAction}
                aria-label="Conversation filters"
                aria-expanded={showFilters}
                aria-controls="whatsapp-chat-filters"
                title="Conversation filters"
                onClick={() => setShowFilters((value) => !value)}
              >
                <ListFilter size={20} />
                {(assignmentFilter !== 'all' || labelFilter) && <i aria-hidden="true" />}
              </button>
              <button
                type="button"
                className={styles.iconAction}
                aria-label={canSync ? 'Sync chats' : 'Refresh conversations'}
                title={canSync ? 'Sync chats' : 'Refresh conversations'}
                disabled={syncBusy || inboxLoading}
                onClick={() => {
                  if (canSync) void syncChats();
                  else {
                    inboxRevision.current = undefined;
                    detailRevision.current = undefined;
                    void refreshInbox();
                    if (selected) void refreshDetail(selected, true);
                  }
                }}
              >
                <RefreshCw size={18} className={syncBusy || inboxLoading ? 'spin' : undefined} />
              </button>
            </div>
          </div>
          {((team?.workspaces.length ?? 0) > 1 || !isOwnWorkspace) && (
            <div className={styles.workspacePicker}>
              <select
                aria-label="Inbox workspace"
                value={workspace || ownUid}
                onChange={(e) => changeWorkspace(e.target.value)}
              >
                {(team?.workspaces?.length
                  ? team.workspaces
                  : [{ id: workspace || ownUid, name: 'Current workspace' }]
                ).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <label className={styles.search}>
            <Search size={18} />
            <input
              aria-label="Search WhatsApp customers"
              placeholder="Search chats"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div id="whatsapp-chat-filters" className={styles.filters} hidden={!showFilters}>
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
          {inbox?.history?.phase === 'syncing' && (
            <progress
              className={styles.syncProgress}
              max={100}
              value={inbox.history.progress ?? undefined}
              aria-label="Syncing chats from WhatsApp"
            />
          )}
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
                  <ChatAvatar
                    name={item.name}
                    path={
                      personalConnection && inbox?.configured && isOwnWorkspace && item.conversation
                        ? '/api/whatsapp/chats/' + encodeURIComponent(item.id) + '/avatar'
                        : undefined
                    }
                  />
                  <span className={styles.contactBody}>
                    <span className={styles.contactName}>
                      <strong>{item.name}</strong>
                      <small>{messageTime(item.conversation?.lastMessageAt)}</small>
                    </span>
                    <span className={styles.contactPreview}>
                      {item.conversation?.lastMessageStatus &&
                        item.conversation.lastMessageStatus !== 'received' && (
                          <Delivery status={item.conversation.lastMessageStatus} />
                        )}
                      <span className={styles.previewText}>
                        {item.conversation?.lastMessagePreview || 'Start a conversation'}
                      </span>
                      {!!item.conversation?.unreadCount && (
                        <small
                          className={styles.unread}
                          aria-label={item.conversation.unreadCount + ' unread messages'}
                        >
                          {item.conversation.unreadCount > 99
                            ? '99+'
                            : item.conversation.unreadCount}
                        </small>
                      )}
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
                    : personalConnection
                      ? 'Sync chats from your phone, or use + to start a conversation with a WhatsApp number.'
                      : 'Registered customers and incoming API conversations will appear here.'}
                </p>
              </div>
            )}
          </div>
        </aside>
        <div className={styles.conversationPane} id="whatsapp-chat-pane">
          {selected && (activeContact || detailLoading || detailError) ? (
            <>
              <header className={styles.chatHeader}>
                <button
                  type="button"
                  className={`${styles.iconAction} ${styles.backButton}`}
                  onClick={() => {
                    setSelected(null);
                    onSelect?.(null);
                  }}
                  aria-label="Back to chats"
                >
                  <ArrowLeft size={20} />
                </button>
                <ChatAvatar
                  name={activeContact?.name || ''}
                  path={
                    personalConnection &&
                    configured &&
                    isOwnWorkspace &&
                    activeContact?.conversation
                      ? '/api/whatsapp/chats/' + encodeURIComponent(activeContact.id) + '/avatar'
                      : undefined
                  }
                />
                <div className={styles.chatTitle}>
                  <h3>
                    {activeContact?.name ||
                      (detailLoading ? 'Loading conversation…' : 'Conversation')}
                  </h3>
                </div>
                {activeContact && (
                  <a
                    className={styles.iconAction}
                    href={chatLink(activeContact.phone, text.trim())}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Open conversation in WhatsApp"
                    title="Open in WhatsApp"
                  >
                    <ExternalLink size={18} />
                  </a>
                )}
                {team && activeContact && (
                  <TeamConversationTools
                    key={(workspace || ownUid) + ':' + selected}
                    workspace={workspace}
                    customerId={activeContact.id}
                    context={team}
                    compact
                    onQuickReply={setText}
                    onChanged={() => {
                      inboxRevision.current = undefined;
                      void refreshInbox(true);
                    }}
                  />
                )}
              </header>
              <div
                className={styles.messages}
                ref={scrollArea}
                onScroll={(event) => {
                  const target = event.currentTarget;
                  followLatest.current =
                    target.scrollHeight - target.scrollTop - target.clientHeight < 80;
                }}
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
                {personalConnection && (olderLoaded ? olderBefore : detail?.nextBefore) && (
                  <button
                    className={`button secondary small-button ${styles.loadEarlier}`}
                    disabled={olderLoading}
                    onClick={() => void loadEarlier()}
                  >
                    {olderLoading ? 'Loading earlier messages…' : 'Load earlier messages'}
                  </button>
                )}
                {detail?.historyClipped && (
                  <p className={styles.historyNote}>
                    Showing available recent history. Older messages may remain on your phone.
                  </p>
                )}
                {detailLoading && !detail ? (
                  <div className={styles.chatEmpty} role="status">
                    <LoaderCircle className="spin" size={24} />
                    <p>Loading recorded messages…</p>
                  </div>
                ) : messages.length ? (
                  messages.map((message, index) => {
                    const day = messageDay(message.createdAt);
                    const attachment = messageAttachment(message);
                    const hasLegacyImage =
                      message.type === 'image' && !(message as { attachment?: unknown }).attachment;
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
                            {attachment && (
                              <InboxAttachmentView
                                attachment={attachment}
                                path={
                                  attachment.available && activeContact
                                    ? workspacePath(
                                        '/api/account/inbox/' +
                                          encodeURIComponent(activeContact.id) +
                                          '/messages/' +
                                          encodeURIComponent(message.id) +
                                          (hasLegacyImage ? '/image' : '/attachment'),
                                        workspace,
                                      )
                                    : undefined
                                }
                              />
                            )}
                            {(message.text || (!attachment && message.type === 'unsupported')) && (
                              <p>{message.text || 'This message type is not available here.'}</p>
                            )}
                            <div className={styles.messageMeta}>
                              <time dateTime={message.createdAt}>
                                {messageTime(message.createdAt)}
                              </time>
                              {message.direction === 'outbound' && (
                                <Delivery status={message.status} />
                              )}
                            </div>
                            {message.error && (
                              <small className={styles.messageError}>{message.error}</small>
                            )}
                            {!attachment &&
                              message.direction === 'outbound' &&
                              message.status === 'failed' && (
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
                          ? 'Available phone history and new messages appear here after sync. You can type a message below to start this conversation.'
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
                {attachmentDraft && (
                  <AttachmentDraftPreview
                    draft={attachmentDraft}
                    disabled={sending}
                    onRemove={() => {
                      clearAttachment();
                      setSendError('');
                    }}
                  />
                )}
                <div className={styles.composerInput}>
                  {personalConnection && canWrite && (
                    <>
                      <input
                        ref={fileInput}
                        type="file"
                        hidden
                        aria-label="Choose a file"
                        accept={acceptedAttachmentFiles}
                        onChange={(event) => {
                          chooseAttachment(event.currentTarget.files?.[0]);
                          event.currentTarget.value = '';
                        }}
                      />
                      <button
                        type="button"
                        className={`${styles.iconAction} ${styles.attachButton}`}
                        onClick={() => fileInput.current?.click()}
                        disabled={!canAttach || sending}
                        aria-label="Attach a file"
                        title="Attach a file (up to 16 MB)"
                      >
                        <Paperclip size={21} aria-hidden="true" />
                      </button>
                    </>
                  )}
                  {draftCanHaveCaption ? (
                    <textarea
                      ref={captionInput}
                      aria-label="Attachment caption"
                      placeholder="Add a caption (optional)…"
                      value={caption}
                      maxLength={maxAttachmentCaption}
                      rows={1}
                      disabled={sending || !canAttach}
                      onChange={(event) => {
                        setCaption(event.target.value);
                        setSendError('');
                      }}
                    />
                  ) : !attachmentDraft ? (
                    <textarea
                      aria-label="WhatsApp reply"
                      aria-describedby={
                        !canReply && !detailLoading ? 'whatsapp-reply-requirement' : undefined
                      }
                      placeholder={
                        !canWrite
                          ? 'Read-only team access'
                          : canReply
                            ? personalConnection
                              ? 'Type a message…'
                              : 'Type an API reply…'
                            : personalConnection
                              ? 'Connect WhatsApp to send your message…'
                              : 'Draft a message for the WhatsApp app (API reply unavailable)…'
                      }
                      value={text}
                      maxLength={4096}
                      rows={1}
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
                  ) : (
                    <span className={styles.captionUnavailable}>
                      Audio sends without a caption.
                    </span>
                  )}
                  <button
                    type="submit"
                    className={styles.sendButton}
                    disabled={sending || (attachmentDraft ? !canAttach : !canReply || !text.trim())}
                    aria-label={attachmentDraft ? 'Send WhatsApp file' : 'Send WhatsApp reply'}
                    title={attachmentDraft ? 'Send file' : 'Send reply'}
                  >
                    {sending ? <LoaderCircle className="spin" size={20} /> : <Send size={20} />}
                  </button>
                </div>
                {!attachmentDraft && canWrite && !canReply && activeContact && text.trim() && (
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
              </form>
            </>
          ) : (
            <div className={styles.welcome}>
              <span className={styles.welcomeIcon}>
                <MessageCircle size={50} strokeWidth={1.3} />
              </span>
              <h3>Select a chat</h3>
              <p>Open a conversation to read messages and reply.</p>
            </div>
          )}
        </div>
      </div>
      {newChat && personalConnection && canWrite && (
        <WhatsAppNewChat
          key={workspace}
          workspace={workspace}
          onClose={() => setNewChat(false)}
          onOpen={(id) => {
            chooseContact(id);
            void refreshInbox(true);
          }}
        />
      )}
    </section>
  );
}
