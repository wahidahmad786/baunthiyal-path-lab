export type SetupCheck = {
  name: string;
  status: 'verified' | 'missing' | 'failed' | 'waiting';
  detail: string;
};
export type SetupReport = { checkedAt: string; checks: SetupCheck[]; ready: boolean };

export type FirebaseSetupSnapshot = {
  projectId: string;
  projectNumber: string;
  appId: string;
  databaseRegion: string;
  plan: string;
  firestoreVerified: boolean;
  authenticationEnabled: boolean;
  googleSignInEnabled?: boolean;
  firestoreRulesDeployed: boolean;
  adminConfigured: boolean;
  backendDeployed: boolean;
  verifiedAt: string;
};
