'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { onIdTokenChanged } from 'firebase/auth';
import { labClientAuth, clientAuthConfigured } from '@/lib/client-auth';
import { accountApi, Notice } from '@/components/ui';
export default function TeamInvite() {
  const [signedIn, setSignedIn] = useState(false),
    [checked, setChecked] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [returnTo, setReturnTo] = useState('');
  useEffect(() => {
    setReturnTo(window.location.pathname + window.location.search);
    if (!clientAuthConfigured) {
      setChecked(true);
      return;
    }
    return onIdTokenChanged(labClientAuth(), (user) => {
      setSignedIn(!!user);
      setChecked(true);
    });
  }, []);
  return (
    <div className="public-shell">
      <Link className="public-brand" href="/">
        <img src="/logo.svg" alt="Baunthiyal Path Lab" width={45} height={45} />
        <strong>Baunthiyal Path Lab</strong>
      </Link>
      <section className="public-card">
        <h1>Join a WhatsApp team inbox</h1>
        <p>
          Accept with the verified Google email that received this private invitation. Team access
          includes customer names, phone numbers, conversations and internal notes.
        </p>
        {error && <Notice error>{error}</Notice>}
        {message && <Notice>{message}</Notice>}
        {!checked ? (
          <p>Checking sign-in…</p>
        ) : !signedIn ? (
          <Link className="button primary" href={'/login?returnTo=' + encodeURIComponent(returnTo)}>
            Sign in to accept
          </Link>
        ) : !message ? (
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                const query = new URLSearchParams(window.location.search);
                const result = await accountApi<{ message: string }>('account/team/accept', {
                  owner: query.get('owner'),
                  token: query.get('token'),
                });
                setMessage(result.message);
                window.history.replaceState(null, '', '/team-invite');
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Accepting…' : 'Accept team invitation'}
          </button>
        ) : (
          <Link className="button primary" href="/">
            Open dashboard
          </Link>
        )}
      </section>
    </div>
  );
}
