'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Bell, Check, RefreshCw, X } from 'lucide-react';
import { accountApi } from './ui';
import type { ConnectionHealth } from '@/lib/crm-types';
export default function ConnectionAlerts({
  bookings,
  onOpenBookings,
  onOpenIntegration,
  onHealthy,
}: {
  bookings: number;
  onOpenBookings: () => void;
  onOpenIntegration: () => void;
  onHealthy: (healthy: boolean) => void;
}) {
  const [health, setHealth] = useState<ConnectionHealth | null>(null),
    [open, setOpen] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const active = useRef(true),
    checking = useRef(false),
    onHealth = useRef(onHealthy);
  onHealth.current = onHealthy;
  const check = useCallback(async (force = false) => {
    if (checking.current) return;
    checking.current = true;
    setBusy(true);
    try {
      const result = await accountApi<ConnectionHealth>(
        'account/connection-health' + (force ? '/check' : ''),
        force ? {} : undefined,
      );
      if (active.current) {
        setHealth(result);
        setError('');
        onHealth.current(result.state === 'healthy');
      }
    } catch (e) {
      if (active.current) setError((e as Error).message);
    } finally {
      checking.current = false;
      if (active.current) setBusy(false);
    }
  }, []);
  useEffect(() => {
    active.current = true;
    void check();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void check();
    }, 300000);
    return () => {
      active.current = false;
      clearInterval(timer);
    };
  }, [check]);
  const alerts = health?.alerts || [],
    count = alerts.filter((a) => !a.dismissedAt).length + bookings;
  return (
    <div className="crm-notifications">
      <button
        type="button"
        className="icon-button notification-button"
        aria-label={`Notifications, ${count} unread`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Bell size={19} />
        {count > 0 && <span className="crm-notification-count">{count}</span>}
      </button>
      {open && (
        <section className="panel crm-notification-panel" aria-label="Connection notifications">
          <div className="crm-heading">
            <h3>Notifications</h3>
            <button
              type="button"
              className="icon-button"
              aria-label="Close notifications"
              onClick={() => setOpen(false)}
            >
              <X size={17} />
            </button>
          </div>
          <p className="crm-muted">Connection checks every 5 minutes while the portal is open.</p>
          {error && (
            <p role="alert" className="crm-error">
              {error}
            </p>
          )}
          {health && (
            <p className="crm-muted">
              {health.message}
              <br />
              Last checked:{' '}
              {health.checkedAt
                ? new Date(health.checkedAt).toLocaleString('en-IN')
                : 'Not checked yet'}
            </p>
          )}
          {alerts.map((alert) => (
            <article key={alert.id} className={`crm-alert-card ${alert.severity}`}>
              <strong>
                <AlertCircle size={15} />
                {alert.title}
              </strong>
              <p>{alert.message}</p>
              <button
                type="button"
                className="text-button"
                disabled={busy || !!alert.dismissedAt}
                onClick={async () => {
                  try {
                    await accountApi(`account/connection-health/alerts/${alert.id}/dismiss`, {});
                    await check();
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                <Check size={13} />
                {alert.dismissedAt ? 'Acknowledged' : 'Acknowledge'}
              </button>
            </article>
          ))}
          {bookings > 0 && (
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                setOpen(false);
                onOpenBookings();
              }}
            >
              {bookings} pending booking requests
            </button>
          )}
          <div className="inline-actions">
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => void check(true)}
            >
              <RefreshCw size={14} className={busy ? 'spin' : ''} />
              Check now
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setOpen(false);
                onOpenIntegration();
              }}
            >
              WhatsApp Integration
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
