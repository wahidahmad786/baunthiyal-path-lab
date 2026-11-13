'use client';
import { useState } from 'react';
import Link from 'next/link';
import { LegalLinks } from '@/components/legal-links';
import { ArrowLeft, LockKeyhole } from 'lucide-react';
import {
  GoogleAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  signOut,
  setPersistence,
  browserSessionPersistence,
  sendPasswordResetEmail,
  type User,
} from 'firebase/auth';
import { Field, Notice, Submit, api } from '@/components/ui';
import { labClientAuth, clientAuthConfigured, previewOnly, signInError } from '@/lib/client-auth';
import { hasLabAdminAccess } from '@/lib/access';
export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const configured = clientAuthConfigured;
  async function finishSignIn(user: User) {
    const auth = labClientAuth();
    try {
      const token = await user.getIdTokenResult(true);
      if (!user.emailVerified) throw new Error('Please use a verified Google account.');
      if (!previewOnly) {
        await api('logout', {});
        const configuration = await api<{ firebase: boolean }>('configuration');
        if (configuration.firebase && hasLabAdminAccess(token.claims))
          await api('session', { idToken: token.token });
      }
    } catch (error) {
      await signOut(auth);
      throw error;
    }
    window.location.assign('/');
  }
  return (
    <div className="public-shell">
      <Link href="/" className="public-brand">
        <img src="/logo.svg" alt="Baunthiyal Path Lab" width={47} height={47} />
        <div>
          <strong>Baunthiyal Path Lab</strong>
          <span>Your Health, Our Priority</span>
        </div>
      </Link>
      <div className="public-card">
        <div className="login-icon">
          <LockKeyhole size={23} />
        </div>
        <h1>Welcome to your workspace.</h1>
        <p>Sign in to manage your campaigns, customer preferences, and community connections.</p>
        {error && <Notice error>{error}</Notice>}
        {notice && <Notice>{notice}</Notice>}
        <button
          type="button"
          className="button google-signin"
          disabled={!configured || busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            setNotice('');
            try {
              const auth = labClientAuth();
              await setPersistence(auth, browserSessionPersistence);
              const provider = new GoogleAuthProvider();
              provider.setCustomParameters({ prompt: 'select_account' });
              const credential = await signInWithPopup(auth, provider);
              await finishSignIn(credential.user);
            } catch (error) {
              setError(signInError(error));
            } finally {
              setBusy(false);
            }
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="#4285F4"
              d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.75 2.98-4.33 2.98-7.36Z"
            />
            <path
              fill="#34A853"
              d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.24-2.51c-.9.6-2.05.96-3.38.96-2.6 0-4.8-1.76-5.59-4.12H3.07v2.59A10 10 0 0 0 12 22Z"
            />
            <path
              fill="#FBBC05"
              d="M6.41 13.92a6 6 0 0 1 0-3.84V7.49H3.07a10 10 0 0 0 0 9.02l3.34-2.59Z"
            />
            <path
              fill="#EA4335"
              d="M12 5.96c1.47 0 2.79.5 3.83 1.5l2.87-2.87A9.62 9.62 0 0 0 12 2a10 10 0 0 0-8.93 5.49l3.34 2.59C7.2 7.72 9.4 5.96 12 5.96Z"
            />
          </svg>
          {busy ? 'Signing in…' : 'Continue with Google'}
        </button>
        <div className="login-divider">
          <span>or sign in with email</span>
        </div>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            setNotice('');
            try {
              const auth = labClientAuth();
              await setPersistence(auth, browserSessionPersistence);
              const credential = await signInWithEmailAndPassword(auth, email.trim(), password);
              await finishSignIn(credential.user);
            } catch (e) {
              setError(signInError(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Email address">
            <input
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@yourlab.com"
            />
          </Field>
          <Field label="Password">
            <input
              required
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Submit busy={busy} disabled={!configured}>
            Sign in securely
          </Submit>
        </form>
        <button
          type="button"
          className="text-button"
          style={{ marginTop: 18 }}
          disabled={!configured || busy}
          onClick={async () => {
            setError('');
            setNotice('');
            if (!email.trim()) {
              setError('Enter your registered email address first.');
              return;
            }
            setBusy(true);
            try {
              await sendPasswordResetEmail(labClientAuth(), email.trim());
              setNotice('If this email is registered, a password setup link has been sent.');
            } catch {
              setError('Unable to request a password link. Check the email and try again later.');
            } finally {
              setBusy(false);
            }
          }}
        >
          Set or reset your password
        </button>
        <Link href="/" className="back-link">
          <ArrowLeft size={13} />
          Back to marketing workspace
        </Link>
      </div>
      <div className="public-footer">
        Baunthiyal Path Lab<span>Your workspace · Your Health, Our Priority</span>
        <LegalLinks />
      </div>
    </div>
  );
}
