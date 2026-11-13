// Browser regression harness only. Never imported by application source.
export const labClientAuth = () => ({
  currentUser: { uid: 'browser-owner', getIdToken: async () => 'browser-test-token-only' },
});
