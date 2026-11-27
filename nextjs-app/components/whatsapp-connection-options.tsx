'use client';
import { useCallback, useEffect, useState } from 'react';
import { MessageCircle, QrCode, ShieldCheck, RefreshCw, Smartphone } from 'lucide-react';
import { labClientAuth } from '@/lib/client-auth';
import WhatsAppIntegration from './whatsapp-integration';
import type { PersonalStatus } from '@/lib/personal-whatsapp';
import './whatsapp-connection-options.css';
type Connection = {
  mode: 'meta' | 'personal' | null;
  locked: boolean;
  phone: string | null;
  connectedAt: string | null;
  personal: PersonalStatus | null;
};
export default function WhatsAppConnectionOptions({
  onConnectionChange,
  onProviderChange,
}: {
  onConnectionChange?: (connected: boolean) => void;
  onProviderChange?: (mode: 'meta' | 'personal' | null) => void;
}) {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false),
    [phone, setPhone] = useState(''),
    [pairing, setPairing] = useState(false);
  const [choice, setChoice] = useState<'personal' | null>(null);
  const request = useCallback(
    async (data?: unknown) => {
      const user = labClientAuth().currentUser;
      if (!user) throw new Error('Sign in with Google to connect WhatsApp.');
      const response = await fetch('/api/whatsapp/provider', {
        method: data ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${await user.getIdToken()}`,
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
        ...(data ? { body: JSON.stringify(data) } : {}),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to load WhatsApp connection.');
      setConnection(result);
      onProviderChange?.(result.mode);
      if (result.mode === 'personal') onConnectionChange?.(result.personal?.status === 'connected');
      return result as Connection;
    },
    [onConnectionChange, onProviderChange],
  );
  useEffect(() => {
    let live = true;
    void request().catch((e) => {
      if (live) setError(e.message);
    });
    return () => {
      live = false;
    };
  }, [request]);
  useEffect(() => {
    if (connection?.mode !== 'personal') return;
    const interval = setInterval(
      () => {
        if (!document.hidden) void request().catch((e) => setError(e.message));
      },
      connection.personal?.status === 'connected' ? 15000 : 3000,
    );
    return () => clearInterval(interval);
  }, [request, connection?.mode, connection?.personal?.status]);
  async function action(data: unknown) {
    setBusy(true);
    setError('');
    try {
      await request(data);
      setChoice(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection failed.');
    } finally {
      setBusy(false);
    }
  }
  const personal = connection?.personal;
  const linking =
    personal && ['connecting', 'qr', 'pairing', 'reconnecting'].includes(personal.status);
  return (
    <div className="wa-options">
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {!connection && !error && (
        <div className="card">
          <p>Loading your WhatsApp connection…</p>
        </div>
      )}
      {!connection && error && (
        <button className="button secondary" onClick={() => void action(undefined)} disabled={busy}>
          Try again
        </button>
      )}
      {connection?.mode === 'meta' && (
        <>
          <div className="wa-choice-note">
            <ShieldCheck size={22} />
            <div>
              <strong>Meta Business API</strong>
              <p>
                {connection.locked
                  ? 'This connection method is saved for your Google account.'
                  : 'Complete your Meta connection below.'}
              </p>
            </div>
            {!connection.locked && (
              <button
                className="text-button"
                disabled={busy}
                onClick={() => void action({ action: 'cancel' })}
              >
                Back to connection methods
              </button>
            )}
          </div>
          <WhatsAppIntegration
            onConnectionChange={(connected) => {
              onConnectionChange?.(connected);
              if (connected) void request().catch((e) => setError(e.message));
            }}
          />
        </>
      )}
      {connection && !connection.mode && !choice && (
        <>
          <div className="wa-choice-heading">
            <h2>Connect your WhatsApp</h2>
            <p>
              Choose how this Google account will connect. After the first successful connection,
              the method stays with your account.
            </p>
          </div>
          <div className="wa-method-grid">
            <article className="card wa-method">
              <div className="wa-method-icon">
                <ShieldCheck />
              </div>
              <span className="wa-method-label">OFFICIAL BUSINESS PLATFORM</span>
              <h3>Meta Business API</h3>
              <p>
                Connect an eligible WhatsApp Business number with Meta. Use approved templates,
                campaign reporting and the shared inbox.
              </p>
              <ul>
                <li>Meta setup and permissions required</li>
                <li>Marketing uses approved templates and customer consent</li>
                <li>Meta messaging charges may apply</li>
              </ul>
              <button
                className="button primary"
                disabled={busy}
                onClick={() => void action({ action: 'select-meta' })}
              >
                Continue with Meta
              </button>
            </article>
            <article className="card wa-method">
              <div className="wa-method-icon">
                <QrCode />
              </div>
              <span className="wa-method-label">PERSONAL OR BUSINESS MOBILE APP</span>
              <h3>Link your WhatsApp</h3>
              <p>
                Scan a QR code or use a pairing code from your phone. Keep using your existing
                WhatsApp mobile app.
              </p>
              <ul>
                <li>Human one-to-one conversations in the inbox</li>
                <li>Encrypted linked-device session saved on the server</li>
                <li>Unofficial integration; re-linking may be required</li>
              </ul>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => setChoice('personal')}
              >
                Continue with QR or phone
              </button>
            </article>
          </div>
        </>
      )}
      {(choice === 'personal' || connection?.mode === 'personal') && (
        <section className="card wa-link-card">
          <div className="wa-link-heading">
            <MessageCircle size={26} />
            <div>
              <h2>{connection?.locked ? 'Your linked WhatsApp' : 'Link your WhatsApp'}</h2>
              <p>
                {connection?.locked
                  ? 'Your connection method is saved for this Google account.'
                  : 'Approve this linked device on your own phone.'}
              </p>
            </div>
          </div>
          {connection?.phone && (
            <div className="wa-linked-phone">
              <Smartphone size={21} />
              <strong>{connection.phone}</strong>
              <span className="badge">{personal?.status.replaceAll('_', ' ') || 'Saved'}</span>
            </div>
          )}
          {personal && (
            <p role="status" aria-live="polite">
              {personal.message}
            </p>
          )}
          {personal?.qr && (
            <div className="wa-qr">
              <img
                src={personal.qr}
                alt="Scan this WhatsApp linking QR code using your own phone"
                width={280}
                height={280}
              />
              <p>WhatsApp → Settings → Linked devices → Link a device</p>
            </div>
          )}
          {personal?.pairingCode && (
            <div className="wa-pair-code">
              <span>Enter this code in WhatsApp on your phone</span>
              <strong>{personal.pairingCode.match(/.{1,4}/g)?.join(' - ')}</strong>
              <p>Linked devices → Link a device → Link with phone number</p>
            </div>
          )}
          {personal?.status !== 'connected' && !linking && (
            <>
              <p className="wa-linked-disclosure">
                This uses an unofficial WhatsApp Web client. WhatsApp can end a session or restrict
                an account. Meta-approved campaigns remain available only through the official
                Business API.
              </p>
              <label className="wa-accept">
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={(e) => setAccepted(e.target.checked)}
                />{' '}
                I own this WhatsApp account and understand the linked-device limitations.
              </label>
              <div className="wa-pair-tabs">
                <button
                  type="button"
                  className={`button ${!pairing ? 'primary' : 'secondary'}`}
                  onClick={() => setPairing(false)}
                >
                  Scan QR code
                </button>
                <button
                  type="button"
                  className={`button ${pairing ? 'primary' : 'secondary'}`}
                  onClick={() => setPairing(true)}
                >
                  Use phone number
                </button>
              </div>
              {pairing && (
                <label className="wa-phone-input">
                  WhatsApp number with country code
                  <input
                    type="tel"
                    autoComplete="tel"
                    value={phone}
                    placeholder="+91 6395951791"
                    onChange={(e) => setPhone(e.target.value)}
                  />
                  <small>
                    Approve the pairing code in WhatsApp. No OTP or password is collected here.
                  </small>
                </label>
              )}
              <button
                className="button primary"
                disabled={
                  busy ||
                  !accepted ||
                  (pairing && !/^[1-9]\d{7,14}$/.test(phone.replace(/\D/g, '')))
                }
                onClick={() =>
                  void action({
                    action: 'connect-personal',
                    acceptedUnofficial: true,
                    ...(pairing ? { phone: phone.replace(/\D/g, '') } : {}),
                    ...(personal?.status === 'relink_required' ? { relink: true } : {}),
                  })
                }
              >
                <RefreshCw size={16} />
                {busy
                  ? 'Connecting…'
                  : personal?.status === 'relink_required'
                    ? 'Re-link the same WhatsApp'
                    : connection?.locked
                      ? 'Reconnect saved WhatsApp'
                      : 'Start linking'}
              </button>
            </>
          )}
          {linking && (
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => void action(undefined)}
            >
              <RefreshCw size={16} />
              Refresh connection
            </button>
          )}
          {personal?.status === 'connected' && (
            <p className="wa-linked-success">
              Connected. Open WhatsApp Inbox to send and receive individual messages.
            </p>
          )}
          <p className="wa-hosting-note">
            Linked messages need a running server. Free hosting can sleep when idle; the portal
            restores saved sessions when it wakes. Re-linking is required if WhatsApp removes this
            device.
          </p>
          {!connection?.locked && (
            <button
              className="text-button"
              disabled={busy}
              onClick={() =>
                connection?.mode ? void action({ action: 'cancel' }) : setChoice(null)
              }
            >
              Back to connection methods
            </button>
          )}
        </section>
      )}
    </div>
  );
}
