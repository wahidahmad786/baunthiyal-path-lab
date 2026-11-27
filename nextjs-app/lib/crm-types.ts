export type TeamRole = 'owner' | 'staff' | 'viewer';
export type TeamMember = {
  uid: string;
  name: string;
  role: TeamRole;
  email?: string;
  active: boolean;
};
export type TeamWorkspace = { id: string; name: string; role: TeamRole };
export type QuickReply = { id: string; title: string; text: string };
export type ConversationMeta = {
  assignedTo: string | null;
  labels: string[];
  status: 'open' | 'resolved';
};
export type ConversationNote = {
  id: string;
  text: string;
  authorName: string;
  authorId: string;
  createdAt: string;
};
export type TeamContext = {
  workspaceId: string;
  role: TeamRole;
  canWrite: boolean;
  members: TeamMember[];
  quickReplies: QuickReply[];
  workspaces: TeamWorkspace[];
  contacts?: { id: string; name: string; phone: string }[];
  contactsTruncated?: boolean;
};
export type ConnectionAlert = {
  id: string;
  severity: 'warning' | 'error';
  title: string;
  message: string;
  firstSeenAt: string;
  lastSeenAt: string;
  dismissedAt: string | null;
  resolvedAt: string | null;
};
export type ConnectionHealth = {
  state: 'healthy' | 'action_required' | 'not_connected' | 'unknown';
  checkedAt: string | null;
  nextCheckAt: string | null;
  tokenExpiresAt: string | null;
  dataAccessExpiresAt: string | null;
  webhookReady: boolean;
  message: string;
  alerts: ConnectionAlert[];
};
