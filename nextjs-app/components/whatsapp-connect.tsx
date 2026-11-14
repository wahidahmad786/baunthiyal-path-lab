'use client';
import { useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle, MessageCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import { labClientAuth } from '@/lib/client-auth';
import { loadFacebookSdk } from '@/lib/facebook-sdk';
import { readEmbeddedEvent, type EmbeddedAssets, type EmbeddedStatus } from '@/lib/embedded-signup';
import type { ConnectionSummary } from '@/lib/whatsapp-connection';
import { Notice } from './ui';

async function api(action = '', body?: unknown) {
  const user = labClientAuth().currentUser;
  if (!user) throw new Error('Sign in with Google to connect your own WhatsApp account.');
  const response = await fetch('/api/whatsapp/embedded-signup' + action, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${await user.getIdToken()}`,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Unable to connect WhatsApp.');
  return result;
}
export default function WhatsAppConnect({
  saved,
  onConnected,
}: {
  saved: ConnectionSummary | null;
  onConnected: (connection: ConnectionSummary) => void;
}) {
  const [status, setStatus] = useState<EmbeddedStatus | null>(null);
  const [prepared, setPrepared] = useState<{
    uid: string;
    sessionId: string;
    expires: number;
  } | null>(null);
  const [busy, setBusy] = useState('loading');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [health, setHealth] = useState<{
    tokenExpiresAt: string | null;
    dataAccessExpiresAt: string | null;
  } | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  async function prepare() {
    const attempt = ++generation.current;
    const active = () => mounted.current && generation.current === attempt;
    setBusy('loading');
    setError('');
    try {
      const result = (await api()) as EmbeddedStatus;
      if (!active()) return;
      setStatus(result);
      if (result.ready) {
        await loadFacebookSdk(result.appId!, result.graphVersion);
        if (!active()) return;
        const uid = labClientAuth().currentUser?.uid;
        const session = await api('/start', {});
        if (active() && uid && labClientAuth().currentUser?.uid === uid)
          setPrepared({ uid, sessionId: session.sessionId, expires: Date.now() + 9 * 60000 });
      }
    } catch (e) {
      if (active()) setError(e instanceof Error ? e.message : 'Unable to prepare Meta login.');
    } finally {
      if (active()) setBusy('');
    }
  }
  useEffect(() => {
    mounted.current = true;
    void prepare();
    return () => {
      mounted.current = false;
      generation.current++;
      cleanup.current?.();
    };
  }, []);
  async function check() {
    setBusy('check');
    setError('');
    setNotice('');
    try {
      const result = await api('/check', {});
      setHealth(result);
      setNotice(result.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to check Meta access.');
    } finally {
      setBusy('');
    }
  }
  function connect() {
    if (!status?.ready || !prepared || !window.FB) return;
    if (prepared.expires <= Date.now() || labClientAuth().currentUser?.uid !== prepared.uid) {
      setPrepared(null);
      setError('Prepare a fresh connection session before opening Meta.');
      return;
    }
    setBusy('meta');
    setError('');
    setNotice('');
    let assets: EmbeddedAssets | null = null,
      code = '',
      completing = false,
      stopped = false;
    const stop = () => {
      stopped = true;
      window.removeEventListener('message', listener);
      clearTimeout(timeout);
      cleanup.current = null;
    };
    const fail = (message: string) => {
      stop();
      if (mounted.current) {
        setPrepared(null);
        setBusy('');
        setError(message);
      }
    };
    const finish = async () => {
      if (stopped || completing || !assets || !code) return;
      if (labClientAuth().currentUser?.uid !== prepared.uid) {
        fail('Your Google account changed. Prepare a new WhatsApp connection.');
        return;
      }
      completing = true;
      setBusy('saving');
      try {
        const result = await api('/complete', { ...assets, code, sessionId: prepared.sessionId });
        stop();
        if (mounted.current && labClientAuth().currentUser?.uid === prepared.uid) {
          onConnected(result.connection);
          setNotice(result.message);
          setPrepared(null);
          setBusy('');
          void prepare();
        }
      } catch (e) {
        fail(e instanceof Error ? e.message : 'Meta connection could not be completed.');
      }
    };
    const listener = (event: MessageEvent) => {
      if (stopped || completing) return;
      const result = readEmbeddedEvent(event.origin, event.data);
      if (result === 'cancel')
        return fail('Meta connection was cancelled. Your saved connection has been kept.');
      if (result === 'error')
        return fail(
          'Meta could not complete onboarding. Check your business account eligibility and try again.',
        );
      if (result) {
        assets = result;
        void finish();
      }
    };
    const timeout = setTimeout(
      () =>
        fail(
          'Meta login has not completed. Finish the Meta popup, then prepare a new session if needed.',
        ),
      10 * 60000,
    );
    window.addEventListener('message', listener);
    cleanup.current = stop;
    try {
      // Keep this call synchronous inside the click handler so browsers allow the popup.
      window.FB.login(
        (response) => {
          if (stopped) return;
          code = response.authResponse?.code || '';
          if (!code)
            return fail('Meta permission was not completed. Your saved connection has been kept.');
          void finish();
          setTimeout(() => {
            if (!stopped && !completing)
              fail(
                'Meta did not return the selected WhatsApp account. Connect again and click Finish.',
              );
          }, 8000);
        },
        {
          config_id: status.configId,
          auth_type: 'rerequest',
          response_type: 'code',
          override_default_response_type: true,
          extras: {
            setup: {},
            ...(status.coexistence ? { featureType: 'whatsapp_business_app_onboarding' } : {}),
          },
        },
      );
    } catch {
      fail('Meta login could not open. Allow popups for this portal and try again.');
    }
  }
  const tokenExpiry = health?.tokenExpiresAt ?? saved?.tokenExpiresAt;
  const accessExpiry = health?.dataAccessExpiresAt ?? saved?.dataAccessExpiresAt;
  return (
    <section className="panel quick-whatsapp-connect">
      <div className="quick-connect-heading">
        <span className="integration-mark">
          <MessageCircle size={25} />
        </span>
        <div>
          <h2>{saved ? 'Your WhatsApp connection' : 'Connect your own WhatsApp Business'}</h2>
          <p>
            Use your Meta account to select your business and WhatsApp number. Each Google login
            keeps its own connection.
          </p>
        </div>
      </div>
      {saved && (
        <div className="quick-connect-account">
          <Check size={17} />
          <strong>{saved.phone}</strong>
          <span>{saved.verifiedName}</span>
        </div>
      )}
      <p>
        Meta authorization is saved securely on the server. Signing out or closing your browser does
        not remove it. Meta can still revoke access or require renewal.
      </p>
      {tokenExpiry && (
        <p>
          Token access ends: {new Date(tokenExpiry).toLocaleString('en-IN')}. Reconnect before this
          date.
        </p>
      )}
      {accessExpiry && (
        <p>Data permission ends: {new Date(accessExpiry).toLocaleString('en-IN')}.</p>
      )}
      {status?.coexistence && (
        <p>
          Choose your existing WhatsApp Business app number in Meta to keep using the mobile app.
          Meta decides eligibility.
        </p>
      )}
      {status && !status.ready && <Notice>{status.reason}</Notice>}
      {error && <Notice error>{error}</Notice>}
      {notice && <Notice>{notice}</Notice>}
      <div className="inline-actions">
        {status?.ready && prepared ? (
          <button className="button primary" type="button" disabled={!!busy} onClick={connect}>
            {busy ? <LoaderCircle size={17} className="spin" /> : <MessageCircle size={17} />}
            {saved ? 'Reconnect WhatsApp' : 'Connect WhatsApp'}
          </button>
        ) : status?.ready || error ? (
          <button
            type="button"
            className="button secondary"
            disabled={!!busy}
            onClick={() => void prepare()}
          >
            <RefreshCw size={16} />
            Try again
          </button>
        ) : null}
        {saved && (
          <button
            type="button"
            className="button secondary"
            disabled={!!busy}
            onClick={() => void check()}
          >
            {busy === 'check' ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <ShieldCheck size={16} />
            )}
            Check connection
          </button>
        )}
        {busy && (
          <span role="status">
            {busy === 'meta'
              ? 'Complete the Meta permission popup…'
              : busy === 'saving'
                ? 'Verifying and saving your WhatsApp account…'
                : 'Checking connection…'}
          </span>
        )}
      </div>
    </section>
  );
}
