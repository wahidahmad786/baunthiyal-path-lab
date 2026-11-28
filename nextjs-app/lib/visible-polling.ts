/** Schedule one refresh at a time, only while the page is visible. */
export function startVisiblePolling(
  refresh: () => Promise<unknown>,
  delay: number,
  page: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'> = document,
) {
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    clear();
    if (!stopped && !running && page.visibilityState === 'visible')
      timer = setTimeout(() => void tick(), delay);
  };
  const tick = async () => {
    clear();
    if (stopped || running || page.visibilityState !== 'visible') return;
    running = true;
    try {
      await refresh();
    } catch {
      // Each caller owns its error UI. A transient failure must not stop polling.
    } finally {
      running = false;
      schedule();
    }
  };
  const onVisibility = () => {
    if (page.visibilityState === 'visible') void tick();
    else clear();
  };
  page.addEventListener('visibilitychange', onVisibility);
  schedule();
  return () => {
    stopped = true;
    clear();
    page.removeEventListener('visibilitychange', onVisibility);
  };
}
