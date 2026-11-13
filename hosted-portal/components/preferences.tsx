'use client';
import { useState, useEffect } from 'react';
import { ShieldCheck, CheckCircle2 } from 'lucide-react';
import { api, Notice, Submit } from './ui';
export default function Preferences({ token }: { token: string }) {
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState('opted_out');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  useEffect(() => {
    void api<{ status: string }>(`public/preferences/${token}`)
      .then((d) => {
        setStatus(d.status);
        setSelected(d.status === 'opted_in' ? 'opted_in' : 'opted_out');
      })
      .catch((e) => setError(e.message));
  }, [token]);
  return (
    <div className="public-shell">
      <div className="public-brand">
        <img src="/logo.svg" alt="" width={48} height={48} />
        <div>
          <strong>Baunthiyal Path Lab</strong>
          <span>Your Health, Our Priority</span>
        </div>
      </div>
      <div className="public-card">
        <div className="login-icon">
          <ShieldCheck size={25} />
        </div>
        <h1>Your messages. Your choice.</h1>
        <p>
          Choose whether to receive promotional WhatsApp offers from Baunthiyal Path Lab. Essential
          booking and report notifications are managed separately.
        </p>
        {error && <Notice error>{error}</Notice>}
        {success && (
          <Notice>
            <CheckCircle2 size={16} /> Your marketing preference has been updated.
          </Notice>
        )}
        {status && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              try {
                await api(`public/preferences/${token}`, { status: selected, consent });
                setStatus(selected);
                setSuccess(true);
                setConsent(false);
              } catch (e) {
                setError(String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="checkbox-list" style={{ marginBottom: 20 }}>
              <label className="check-label">
                <input
                  type="radio"
                  name="preference"
                  value="opted_in"
                  checked={selected === 'opted_in'}
                  onChange={(e) => {
                    setSelected(e.target.value);
                    setSuccess(false);
                  }}
                />
                Yes, send me promotional health offers on WhatsApp.
              </label>
              <label className="check-label">
                <input
                  type="radio"
                  name="preference"
                  value="opted_out"
                  checked={selected === 'opted_out'}
                  onChange={(e) => {
                    setSelected(e.target.value);
                    setSuccess(false);
                  }}
                />
                No promotional WhatsApp messages, please.
              </label>
            </div>
            <label className="check-label consent-checkbox">
              <input
                type="checkbox"
                required
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              I confirm this is my preference and understand that I can change it at any time.
            </label>
            <Submit busy={busy}>Save my preference</Submit>
          </form>
        )}
      </div>
      <div className="public-footer">
        You can also reply STOP to any promotional WhatsApp message.
        <span>Baunthiyal Path Lab · Your Health, Our Priority</span>
      </div>
    </div>
  );
}
