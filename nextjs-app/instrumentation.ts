export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.NODE_ENV !== 'production') return;
  const { accountEnvironment } = await import('./lib/server/account-environment');
  const { restorePersonalSessions } = await import('./lib/personal-whatsapp');
  // A delayed pass lets the previous container release its 60-second ownership leases.
  const restore = () => {
    void restorePersonalSessions(accountEnvironment(true)).catch(() => {});
  };
  const first = setTimeout(restore, 65000);
  first.unref();
  const interval = setInterval(restore, 180000);
  interval.unref();
}
