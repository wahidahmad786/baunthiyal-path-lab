export type ChatMessageStatus =
  'received' | 'submitting' | 'accepted' | 'sent' | 'delivered' | 'read' | 'failed' | 'unknown';
export type ChatMessage = {
  id: string;
  metaId?: string;
  direction: 'inbound' | 'outbound';
  type: 'text' | 'template' | 'unsupported';
  text: string;
  status: ChatMessageStatus;
  createdAt: string;
  providerAt?: string;
  error?: string;
};
export type ChatConversation = {
  id: string;
  customerId: string;
  phone: string;
  customerName: string;
  lastMessagePreview: string;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  unreadCount: number;
  lastMessageStatus: ChatMessageStatus | null;
};
export type ChatEnvironment = {
  projectId: string;
  apiKey: string;
  encryptionKey: string;
  graphVersion?: string;
  serviceAccountJson?: string;
  authOrigin?: string;
  firestoreOrigin?: string;
  webhookBaseUrl?: string;
  webhookPublicReady?: boolean;
};
export type ChatInboxResponse = {
  conversations: ChatConversation[];
  configured: boolean;
  webhookUrl: string | null;
  connectionVerified: boolean;
  connectionVerifiedPreviously: boolean;
  webhookReady: boolean;
  webhookPublicReady: boolean;
  lastWebhookAt: string | null;
  reason: string | null;
  truncated?: boolean;
};
export type ChatDetailResponse = {
  conversation: ChatConversation;
  messages: ChatMessage[];
  recorded: boolean;
  configured: boolean;
  windowOpen: boolean;
  reason: string | null;
  webhookUrl: string | null;
  connectionVerified: boolean;
  connectionVerifiedPreviously: boolean;
  webhookReady: boolean;
  webhookPublicReady: boolean;
  lastWebhookAt: string | null;
  truncated?: boolean;
};
