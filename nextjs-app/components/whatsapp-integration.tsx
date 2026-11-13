'use client';
import { useEffect, useState } from 'react';
import {
  Check,
  ExternalLink,
  LoaderCircle,
  LockKeyhole,
  MessageCircle,
  ShieldCheck,
} from 'lucide-react';
import { labClientAuth } from '@/lib/client-auth';
import type { ConnectionSummary } from '@/lib/whatsapp-connection';
import { metaTestSender } from '@/lib/chat-reply-state';
import { Field, Notice } from './ui';

const empty = {
  phone: '',
  phoneNumberId: '',
  businessAccountId: '',
  appId: '',
  accessToken: '',
  appSecret: '',
  verifyToken: '',
};
export default function WhatsAppIntegration({
  onConnectionChange,
}: {
  onConnectionChange?: (connected: boolean) => void;
}) {
  const [values, setValues] = useState(empty);
  const [saved, setSaved] = useState<ConnectionSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [siteOrigin, setSiteOrigin] = useState('');
  useEffect(() => {
    setSiteOrigin(window.location.origin);
  }, []);
  const [verificationFailed, setVerificationFailed] = useState(false);
  const [webhook, setWebhook] = useState<{
    callbackUrl: string | null;
    publicReady: boolean;
    verifyTokenSaved: boolean;
  } | null>(null);
  async function request(data?: unknown, suffix = '') {
    const user = labClientAuth().currentUser;
    if (!user) throw new Error('Sign in with Google to manage your connection.');
    const response = await fetch('/api/whatsapp/integration' + suffix, {
      method: data === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${await user.getIdToken()}`,
        'Content-Type': 'application/json',
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      cache: 'no-store',
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to save connection details.');
    return result as {
      connection: ConnectionSummary | null;
      message?: string;
      webhook?: { callbackUrl: string | null; publicReady: boolean; verifyTokenSaved: boolean };
      verifyToken?: string;
    };
  }
  useEffect(() => {
    let active = true;
    request()
      .then((result) => {
        if (!active) return;
        setSaved(result.connection);
        setWebhook(result.webhook || null);
        if (result.connection) {
          const { phone, phoneNumberId, businessAccountId, appId } = result.connection;
          setValues({ ...empty, phone, phoneNumberId, businessAccountId, appId });
        }
        if (!result.connection) onConnectionChange?.(false);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : 'Unable to load your connection.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  const update = (key: keyof typeof empty, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
    setNotice('');
  };
  async function save(verify: boolean) {
    setBusy(verify ? 'verify' : 'save');
    setError('');
    setNotice('');
    try {
      const result = await request({
        ...values,
        phone: values.phone.replace(/[\s()-]/g, ''),
        verify,
      });
      setSaved(result.connection);
      setWebhook(result.webhook || null);
      setVerificationFailed(false);
      setValues((current) => ({ ...current, accessToken: '', appSecret: '', verifyToken: '' }));
      setNotice(result.message || 'Connection saved.');
      setVerificationFailed(false);
      onConnectionChange?.(!!result.connection?.verifiedAt);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to save connection.');
      if (verify) {
        setVerificationFailed(true);
        onConnectionChange?.(false);
      }
    } finally {
      setBusy('');
    }
  }
  async function copyWebhookValue(kind: 'url' | 'token') {
    setBusy('copy');
    setError('');
    setNotice('');
    try {
      const text =
        kind === 'url'
          ? webhook?.callbackUrl
          : (await request({}, '/verification-token')).verifyToken;
      if (!text) throw new Error('Save your callback verification token in account details first.');
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else
        throw new Error(
          'Clipboard access is unavailable. Open this page over HTTPS in your browser.',
        );
      setNotice(
        kind === 'url'
          ? 'Callback URL copied. Paste it into Meta’s callback URL field.'
          : 'Saved verification token copied. Paste it into Meta’s Verify token field.',
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to copy this value.');
    } finally {
      setBusy('');
    }
  }
  return (
    <div className="whatsapp-integration">
      <div className="integration-intro">
        <span className="integration-mark">
          <MessageCircle size={27} />
        </span>
        <div>
          <h2>Connect your WhatsApp Business</h2>
          <p>Add your Meta account details to manage your WhatsApp connection.</p>
        </div>
        <span className={`badge ${saved?.verifiedAt && !verificationFailed ? 'green' : 'muted'}`}>
          {verificationFailed
            ? 'Needs verification'
            : saved?.verifiedAt
              ? 'Verified at last check'
              : saved
                ? 'Saved · Not verified'
                : 'Not connected'}
        </span>
      </div>
      {saved?.verifiedAt && !verificationFailed && (
        <p className="connection-check-note">
          Last credential check:{' '}
          {new Date(saved.verifiedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}. This
          verifies saved API details; free-text replies still require a customer message within the
          last 24 hours.
        </p>
      )}
      {saved && metaTestSender(saved.phone, saved.verifiedName) && (
        <Notice>
          API sending number: {saved.phone} — Meta test number. Changing the phone field here does
          not register your lab number with Meta. Use supported Coexistence onboarding to keep using
          its WhatsApp Business mobile app.
        </Notice>
      )}
      <div className="integration-layout">
        <section className="panel integration-form">
          <div className="panel-heading">
            <div>
              <h2>WhatsApp account details</h2>
              <p>These details belong to your signed-in account.</p>
            </div>
            <LockKeyhole size={19} />
          </div>
          {loading ? (
            <div className="integration-loading">
              <LoaderCircle className="spin" size={20} />
              Loading your connection…
            </div>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void save(true);
              }}
            >
              {error && <Notice error>{error}</Notice>}
              {notice && <Notice>{notice}</Notice>}
              <div className="integration-fields">
                <Field
                  label="WhatsApp phone number"
                  hint="Include the country code, for example +916395951791."
                >
                  <input
                    required
                    type="tel"
                    autoComplete="tel"
                    placeholder="+91…"
                    value={values.phone}
                    onChange={(e) => update('phone', e.target.value)}
                  />
                </Field>
                <Field
                  label="Phone Number ID"
                  hint="Meta → WhatsApp → API Setup → Phone number ID."
                >
                  <input
                    required
                    inputMode="numeric"
                    pattern="[0-9]{5,30}"
                    value={values.phoneNumberId}
                    onChange={(e) => update('phoneNumberId', e.target.value)}
                    placeholder="Numeric messaging phone ID"
                  />
                </Field>
                <Field
                  label="WhatsApp Business Account ID"
                  hint="Use your WABA ID, separate from your Business portfolio ID."
                >
                  <input
                    required
                    inputMode="numeric"
                    pattern="[0-9]{5,30}"
                    value={values.businessAccountId}
                    onChange={(e) => update('businessAccountId', e.target.value)}
                    placeholder="WhatsApp account ID"
                  />
                </Field>
                <Field label="Meta App ID" hint="Meta for Developers → Your app → App settings.">
                  <input
                    required
                    inputMode="numeric"
                    pattern="[0-9]{5,30}"
                    value={values.appId}
                    onChange={(e) => update('appId', e.target.value)}
                    placeholder="Meta application ID"
                  />
                </Field>
                <Field
                  label="Access token"
                  hint={
                    saved?.accessTokenSaved
                      ? 'A token is saved. Leave blank to keep it, or paste a replacement.'
                      : 'Use a token with access to your WhatsApp account.'
                  }
                >
                  <input
                    required={!saved?.accessTokenSaved}
                    type="password"
                    autoComplete="new-password"
                    maxLength={4096}
                    value={values.accessToken}
                    onChange={(e) => update('accessToken', e.target.value)}
                    placeholder={
                      saved?.accessTokenSaved
                        ? 'Saved securely · enter to replace'
                        : 'Paste your Meta access token'
                    }
                  />
                </Field>
                <Field
                  label="Meta App Secret"
                  hint={
                    saved?.appSecretSaved
                      ? 'A secret is saved. Leave blank to keep it.'
                      : 'Meta → App settings → Basic → App secret.'
                  }
                >
                  <input
                    required={!saved?.appSecretSaved}
                    type="password"
                    autoComplete="new-password"
                    maxLength={256}
                    value={values.appSecret}
                    onChange={(e) => update('appSecret', e.target.value)}
                    placeholder={
                      saved?.appSecretSaved
                        ? 'Saved securely · enter to replace'
                        : 'Paste your app secret'
                    }
                  />
                </Field>
                <Field
                  label="Webhook verification token"
                  hint="Choose a verification token and Save details first. Then use Copy saved verify token below so Meta and the server use the same value."
                >
                  <input
                    type="password"
                    autoComplete="new-password"
                    maxLength={256}
                    value={values.verifyToken}
                    onChange={(e) => update('verifyToken', e.target.value)}
                    placeholder={
                      saved?.verifyTokenSaved
                        ? 'Saved securely · enter to replace'
                        : 'Your webhook verification token'
                    }
                  />
                </Field>
                <button
                  type="button"
                  className="text-button"
                  disabled={!!busy}
                  onClick={() => {
                    const random = crypto.getRandomValues(new Uint8Array(32));
                    update(
                      'verifyToken',
                      Array.from(random, (b) => b.toString(16).padStart(2, '0')).join(''),
                    );
                    setNotice(
                      'A new verification token is filled in. Choose Save details before copying it to Meta.',
                    );
                  }}
                >
                  Generate a verification token
                </button>
              </div>
              <div className="integration-privacy">
                <ShieldCheck size={16} />
                <span>
                  API access tokens and app secrets are encrypted and never returned to the browser.
                  Your saved callback verification token can be copied only through your
                  authenticated account.
                </span>
              </div>
              <div className="integration-actions">
                <button
                  type="button"
                  className="button secondary"
                  disabled={!!busy}
                  onClick={(event) => {
                    if (event.currentTarget.form?.reportValidity()) void save(false);
                  }}
                >
                  {busy === 'save' && <LoaderCircle className="spin" size={16} />}Save details
                </button>
                <button type="submit" className="button primary" disabled={!!busy}>
                  {busy === 'verify' ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <Check size={16} />
                  )}
                  Verify & save
                </button>
              </div>
            </form>
          )}
          {!loading && (
            <div className="callback-setup">
              <h3>Meta webhook callback</h3>
              <p>
                Choose Save details first. Copy both saved values below into Meta, then choose
                Verify and save there and subscribe to the messages field.
              </p>
              {webhook?.callbackUrl ? (
                <>
                  <Field
                    label="Callback URL"
                    hint="Use this exact address, including your account identifier."
                  >
                    <input
                      readOnly
                      value={webhook.callbackUrl}
                      onFocus={(e) => e.currentTarget.select()}
                    />
                  </Field>
                  <div className="inline-actions callback-copy-actions">
                    <button
                      className="button secondary small-button"
                      type="button"
                      disabled={!!busy}
                      onClick={() => void copyWebhookValue('url')}
                    >
                      Copy callback URL
                    </button>
                    <button
                      className="button secondary small-button"
                      type="button"
                      disabled={!!busy || !webhook.verifyTokenSaved || !!values.verifyToken}
                      onClick={() => void copyWebhookValue('token')}
                    >
                      Copy saved verify token
                    </button>
                  </div>
                  {!webhook.publicReady && (
                    <Notice>
                      The callback is not publicly activated yet. Meta cannot verify a private
                      callback.
                    </Notice>
                  )}
                </>
              ) : (
                <Notice>The callback URL is not configured yet.</Notice>
              )}
            </div>
          )}
        </section>
        <aside className="panel integration-help">
          <h2>Where to find your details</h2>
          <ol>
            <li>Open your app in Meta for Developers.</li>
            <li>Go to WhatsApp → API Setup for the phone number and account IDs.</li>
            <li>Copy your access token, App ID and App Secret into this form.</li>
            <li>Choose Verify & save to check the number and app with Meta.</li>
          </ol>
          <a
            className="button secondary"
            href="https://developers.facebook.com/apps/"
            target="_blank"
            rel="noreferrer"
          >
            Open Meta for Developers <ExternalLink size={15} />
          </a>
          <div className="integration-help-note">
            <strong>Keep using the same WhatsApp Business number</strong>
            <p>
              If you also use this number in the WhatsApp Business mobile app, use Meta’s supported
              Coexistence onboarding.
            </p>
          </div>
          <div className="integration-help-note">
            <strong>Before your first campaign</strong>
            <p>
              Sending also needs a subscribed webhook, approved marketing templates, billing where
              applicable, and customers who have opted in. Verifying credentials does not send any
              messages.
            </p>
          </div>
          <div className="integration-help-note meta-policy-links">
            <strong>Public URLs for Meta app settings</strong>
            <p>
              Use these public pages in your Meta app settings. Meta controls app review and Live
              mode. WhatsApp API access still requires a valid access token in Live mode.
            </p>
            {[
              ['Privacy policy', 'privacy-policy'],
              ['Terms of service', 'terms'],
              ['User data deletion instructions', 'data-deletion'],
              ['Contact', 'contact'],
            ].map(([label, path]) => (
              <div key={path}>
                <a href={`/${path}`} target="_blank" rel="noopener noreferrer">
                  {label} <ExternalLink size={11} />
                </a>
                <input
                  aria-label={`${label} URL`}
                  readOnly
                  value={siteOrigin ? `${siteOrigin}/${path}` : ''}
                  onFocus={(event) => event.currentTarget.select()}
                />
              </div>
            ))}
          </div>
          {saved?.verifiedAt && (
            <div className="integration-help-note">
              <strong>{saved.verifiedName || 'Meta verification complete'}</strong>
              <p>
                Checked{' '}
                {new Date(saved.verifiedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}.
              </p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
