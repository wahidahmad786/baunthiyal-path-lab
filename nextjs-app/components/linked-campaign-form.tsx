'use client';

import { useState } from 'react';
import { money } from '@/lib/brand';
import {
  activeLinkedOffer,
  linkedCampaignAudience,
  linkedCampaignChat,
} from '@/lib/linked-campaign';
import type { Customer, Offer } from '@/lib/domain';
import { accountApi, api, dateLabel, Field, Modal, Notice } from './ui';

export default function LinkedCampaignForm({
  offers,
  serverWorkspace,
  onClose,
  onOpenAudience,
}: {
  offers: Offer[];
  serverWorkspace: boolean;
  onClose: () => void;
  onOpenAudience: () => void;
}) {
  const [offerId, setOfferId] = useState('');
  const [message, setMessage] = useState('');
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [limited, setLimited] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [review, setReview] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const offer = offers.find((item) => item.id === offerId);
  const audience = offer ? linkedCampaignAudience(customers || [], offer, Date.now()) : [];
  const chosen = audience.filter((customer) => selected.includes(customer.id));
  const visible = audience.filter((customer) =>
    (customer.name + ' ' + customer.phone).toLowerCase().includes(query.trim().toLowerCase()),
  );

  async function refresh(next: 'select' | 'review') {
    if (!offer || !activeLinkedOffer(offer, Date.now())) return;
    setBusy(true);
    setError('');
    try {
      type Records = { customers: Customer[]; totalCustomers: number };
      const data = serverWorkspace
        ? await api<Records>('state')
        : await accountApi<Records>('account/customers');
      const eligibleNow = linkedCampaignAudience(data.customers, offer, Date.now());
      const prior = selected.filter((id) => eligibleNow.some((customer) => customer.id === id));
      setCustomers(data.customers);
      setLimited(data.totalCustomers > data.customers.length);
      setSelected(prior);
      setReview(next === 'review' && prior.length > 0);
      if (next === 'review' && !prior.length)
        setError('No selected contacts are still eligible. Review the refreshed audience.');
    } catch (cause) {
      setReview(false);
      setCustomers(null);
      setSelected([]);
      setError(cause instanceof Error ? cause.message : 'Unable to check customer consent.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      wide
      title="Create a linked WhatsApp campaign"
      description="Prepare an offer for opted-in customers and send it manually in WhatsApp."
      onClose={onClose}
    >
      <div className="modal-body">
        {error && <Notice error>{error}</Notice>}
        <Notice>
          Linked WhatsApp can open a chat with a draft. It cannot launch a bulk campaign from this
          portal. Check your WhatsApp account and press Send yourself in each chat. No messages are
          sent or tracked here.
        </Notice>
        {!review ? (
          <>
            <Field label="Saved offer">
              <select
                value={offerId}
                disabled={busy}
                onChange={(event) => {
                  const next = offers.find((item) => item.id === event.target.value);
                  setOfferId(event.target.value);
                  setMessage(
                    next
                      ? `Hello from Baunthiyal Path Lab!\n\n${next.title}\nOffer price: ${money(next.offerPrice)}\nValid until: ${dateLabel(next.expiresAt)}\n\nReply to book or ask us about the offer.`
                      : '',
                  );
                  setCustomers(null);
                  setSelected([]);
                  setQuery('');
                  setError('');
                }}
              >
                <option value="">Choose an active offer</option>
                {offers
                  .filter((item) => activeLinkedOffer(item, Date.now()))
                  .map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.title}
                    </option>
                  ))}
              </select>
            </Field>
            {!offers.some((item) => activeLinkedOffer(item, Date.now())) && (
              <Notice>Create an active offer in Offers &amp; packages first.</Notice>
            )}
            <Field label="WhatsApp message" hint="An opt-out line is added to every draft.">
              <textarea
                rows={7}
                maxLength={1200}
                value={message}
                disabled={!offer || busy}
                onChange={(event) => setMessage(event.target.value)}
              />
            </Field>
            {!customers ? (
              <button
                className="button secondary"
                disabled={!offer || !activeLinkedOffer(offer, Date.now()) || busy}
                onClick={() => void refresh('select')}
              >
                {busy ? 'Checking consent…' : 'Load eligible contacts'}
              </button>
            ) : (
              <>
                <div className="section-heading">
                  <h3>Customer audience</h3>
                  <span>
                    {chosen.length} selected · {audience.length} eligible{limited ? ' loaded' : ''}
                  </span>
                </div>
                {limited && (
                  <Notice>Only the loaded customer records are included in this selection.</Notice>
                )}
                {audience.length > 0 ? (
                  <>
                    <Field label="Search eligible contacts">
                      <input
                        type="search"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                      />
                    </Field>
                    <div className="section-heading">
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() =>
                          setSelected(
                            chosen.length === audience.length
                              ? []
                              : audience.map((customer) => customer.id),
                          )
                        }
                      >
                        {chosen.length === audience.length
                          ? 'Clear selection'
                          : 'Select all eligible contacts'}
                      </button>
                    </div>
                    <div className="checkbox-list">
                      {visible.map((customer) => (
                        <label key={customer.id} className="check-label">
                          <input
                            type="checkbox"
                            disabled={busy}
                            checked={selected.includes(customer.id)}
                            onChange={(event) => {
                              const checked = event.target.checked;
                              setSelected((old) =>
                                checked
                                  ? [...old, customer.id]
                                  : old.filter((id) => id !== customer.id),
                              );
                            }}
                          />
                          <span>
                            {customer.name}
                            <small>+{customer.phone}</small>
                          </span>
                        </label>
                      ))}
                      {!visible.length && <p>No contacts match your search.</p>}
                    </div>
                  </>
                ) : (
                  <Notice>No customers with marketing consent match this offer.</Notice>
                )}
              </>
            )}
            <button type="button" className="text-button" onClick={onOpenAudience}>
              Manage marketing consent in Customer audience
            </button>
          </>
        ) : (
          <>
            <h3>Open drafts for {chosen.length} selected contacts</h3>
            <div className="field">
              <label htmlFor="linked-campaign-preview">Final message preview</label>
              <textarea
                id="linked-campaign-preview"
                rows={7}
                readOnly
                value={message.trim() + '\n\nReply STOP to opt out.'}
              />
            </div>
            <div className="checkbox-list">
              {chosen.map((customer) => (
                <div key={customer.id} className="section-heading">
                  <span>
                    {customer.name} · +{customer.phone}
                  </span>
                  <a
                    className="button secondary small-button"
                    aria-label={`Open WhatsApp draft for ${customer.name} (+${customer.phone})`}
                    href={linkedCampaignChat(customer.phone, message)}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(event) => {
                      if (!offer || !activeLinkedOffer(offer, Date.now())) {
                        event.preventDefault();
                        setReview(false);
                        setError('This offer is no longer active.');
                      }
                    }}
                  >
                    Open WhatsApp draft
                  </a>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      <div className="modal-footer">
        <button className="button secondary" onClick={review ? () => setReview(false) : onClose}>
          {review ? 'Back to audience' : 'Cancel'}
        </button>
        {!review && (
          <button
            className="button primary"
            disabled={busy || !chosen.length || !message.trim()}
            onClick={() => void refresh('review')}
          >
            {busy ? 'Checking consent…' : 'Review recipients and message'}
          </button>
        )}
      </div>
    </Modal>
  );
}
