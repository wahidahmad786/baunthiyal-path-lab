'use client';
import { useState, useEffect } from 'react';
import { CalendarDays, CheckCircle2, LoaderCircle, ShieldCheck } from 'lucide-react';
import { Offer } from '@/lib/domain';
import { money } from '@/lib/brand';
import { api, Field, Notice, Submit, dateLabel } from './ui';
export default function PublicOffer({ token }: { token: string }) {
  const [data, setData] = useState<{ offer: Offer; labPhone: string } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState('');
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(false);
  useEffect(() => {
    void api<{ offer: Offer; labPhone: string }>(`public/offer/${token}`)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
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
        {loading ? (
          <LoaderCircle className="spin" />
        ) : success ? (
          <div className="success-state">
            <CheckCircle2 size={49} />
            <h2>A healthier tomorrow starts here.</h2>
            <p>
              We received your booking request. Our team will contact you to confirm your
              appointment and eligibility for the offer.
            </p>
            {data?.labPhone && (
              <a className="button secondary" href={`tel:${data.labPhone}`}>
                Call the lab
              </a>
            )}
          </div>
        ) : (
          <>
            {error && <Notice error>{error}</Notice>}
            {data && (
              <>
                <span className="badge green">A SPECIAL HEALTH OFFER</span>
                <h1>{data.offer.title}</h1>
                <p className="public-description">{data.offer.description}</p>
                <div className="price-summary">
                  <span>Your offer price</span>
                  <strong>{money(data.offer.offerPrice)}</strong>
                  <s>{money(data.offer.originalPrice)}</s>
                </div>
                <div className="offer-valid">
                  <CalendarDays size={15} />
                  Valid until {dateLabel(data.offer.expiresAt)} · Eligibility verified by our team
                </div>
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    setBusy(true);
                    setError('');
                    try {
                      await api(`public/book/${token}`, {
                        name,
                        phone,
                        marketingConsent: consent,
                        website,
                      });
                      setSuccess(true);
                    } catch (e) {
                      setError(e instanceof Error ? e.message : 'Unable to request booking');
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <Field label="Your full name">
                    <input
                      required
                      minLength={2}
                      maxLength={120}
                      autoComplete="name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </Field>
                  <Field
                    label="Phone number"
                    hint="Our team will contact you to confirm your booking."
                  >
                    <input
                      required
                      type="tel"
                      autoComplete="tel"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="+91"
                    />
                  </Field>
                  <label className="honey" aria-hidden="true">
                    Website
                    <input
                      tabIndex={-1}
                      autoComplete="off"
                      value={website}
                      onChange={(e) => setWebsite(e.target.value)}
                    />
                  </label>
                  <label className="check-label consent-checkbox">
                    <input
                      type="checkbox"
                      checked={consent}
                      onChange={(e) => setConsent(e.target.checked)}
                    />
                    <span>
                      I would also like promotional WhatsApp updates from Baunthiyal Path Lab. This
                      is optional and I can opt out at any time. The lab will verify my number
                      before activating this preference.
                    </span>
                  </label>
                  <Submit busy={busy}>Request a booking</Submit>
                </form>
                <p className="muted-text" style={{ marginTop: 14 }}>
                  By submitting, you ask our staff to contact you about this booking. Your details
                  are used to process the request. Promotional consent is optional. Please do not
                  include medical records here.
                </p>
              </>
            )}
          </>
        )}
      </div>
      <div className="public-footer">
        <ShieldCheck size={13} /> Your health information stays private.
        <span>Baunthiyal Path Lab · Your Health, Our Priority</span>
      </div>
    </div>
  );
}
