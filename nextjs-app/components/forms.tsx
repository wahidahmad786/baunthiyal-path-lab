'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  CheckCheck,
  ImagePlus,
  Info,
  LoaderCircle,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  Users,
} from 'lucide-react';
import {
  Campaign,
  CampaignInput,
  Offer,
  Customer,
  Booking,
  Template,
  offerTypes,
  finalPrice,
  templateParameters,
  renderTemplate,
} from '@/lib/domain';
import { money } from '@/lib/brand';
import { api, accountApi, Modal, Field, Notice, Submit, dateLabel } from './ui';
import type { Configuration, State, TestRecord } from './dashboard';
import type { SetupReport } from '@/lib/setup-types';
import { CampaignBanner } from './campaign-banner';
const localDate = (offset = 0) => {
  const d = new Date(Date.now() + offset * 86400000);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const toISO = (value: string) => new Date(value).toISOString();
const optionFields = [
  'customer_name',
  'offer_title',
  'original_price',
  'offer_price',
  'expiry_date',
  'lab_phone',
  'booking_link',
  'preferences_link',
] as const;
export function CampaignForm({
  existing,
  data,
  config,
  ready,
  accountWhatsApp = false,
  linkedInbox = false,
  onOpenIntegration,
  onConnectionCheck,
  onClose,
  onDone,
}: {
  existing: Campaign | null;
  data: State;
  config: Configuration | null;
  ready: boolean;
  accountWhatsApp?: boolean;
  linkedInbox?: boolean;
  onOpenIntegration?: () => void;
  onConnectionCheck?: (valid: boolean) => void;
  onClose: () => void;
  onDone: (s?: string) => Promise<void>;
}) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateError, setTemplateError] = useState('');
  const [bannerPreview, setBannerPreview] = useState('');
  useEffect(
    () => () => {
      if (bannerPreview) URL.revokeObjectURL(bannerPreview);
    },
    [bannerPreview],
  );
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesChecked, setTemplatesChecked] = useState(false);
  const [templateReasons, setTemplateReasons] = useState<string[]>([]);
  const [unavailableTemplates, setUnavailableTemplates] = useState<
    { id: string; name: string; language: string; reasons: string[] }[]
  >([]);
  const [pendingMarketing, setPendingMarketing] = useState(0);
  const [rejectedMarketing, setRejectedMarketing] = useState(0);
  const [approvedMarketing, setApprovedMarketing] = useState(0);
  const [senderVerified, setSenderVerified] = useState(false);
  const [senderDetail, setSenderDetail] = useState('');
  const templateRequest = useRef(0);
  const [estimating, setEstimating] = useState(false);
  const [estimate, setEstimate] = useState<{ count: number; estimatedCost: number | null } | null>(
    null,
  );
  const [scheduled, setScheduled] = useState(
    existing?.scheduledAt
      ? new Date(Date.parse(existing.scheduledAt) - new Date().getTimezoneOffset() * 60000)
          .toISOString()
          .slice(0, 16)
      : '',
  );
  const [input, setInput] = useState<CampaignInput>(
    existing
      ? {
          name: existing.name,
          type: existing.type,
          offerId: existing.offerId,
          templateId: existing.templateId,
          variables: existing.variables,
          audience: existing.audience,
          scheduledAt: existing.scheduledAt,
          bannerPath: existing.bannerPath,
        }
      : {
          name: '',
          type: 'Health package',
          offerId: '',
          templateId: '',
          variables: {},
          audience: { type: 'all', testIds: [], groups: [], customerIds: [] },
          scheduledAt: null,
          bannerPath: '',
        },
  );
  const update = (v: Partial<CampaignInput>) => {
    setInput((old) => ({ ...old, ...v }));
    if (v.offerId !== undefined || v.audience !== undefined) setEstimate(null);
  };
  const audience = (v: Partial<CampaignInput['audience']>) =>
    update({ audience: { ...input.audience, ...v } });
  const offer = data.offers.find((o) => o.id === input.offerId);
  const template = templates.find((t) => t.id === input.templateId);
  const opted = data.customers.filter((c) => c.marketing.status === 'opted_in');
  const loadTemplates = useCallback(async () => {
    if (!accountWhatsApp && (!ready || !config?.whatsapp)) return;
    const request = ++templateRequest.current;
    setTemplatesLoading(true);
    setTemplateError('');
    setTemplatesChecked(false);
    setTemplates([]);
    setTemplateReasons([]);
    setUnavailableTemplates([]);
    setPendingMarketing(0);
    setRejectedMarketing(0);
    try {
      const result = await (accountWhatsApp ? accountApi : api)<{
        templates: Template[];
        approvedMarketing?: number;
        reasons?: string[];
        unavailableTemplates?: { id: string; name: string; language: string; reasons: string[] }[];
        pendingMarketing?: number;
        rejectedMarketing?: number;
      }>(accountWhatsApp ? 'whatsapp/integration/templates' : 'templates');
      if (request !== templateRequest.current) return;
      setTemplates(result.templates);
      setApprovedMarketing(result.approvedMarketing ?? result.templates.length);
      setTemplateReasons(result.reasons || []);
      setUnavailableTemplates(result.unavailableTemplates || []);
      setPendingMarketing(result.pendingMarketing || 0);
      setRejectedMarketing(result.rejectedMarketing || 0);
      setTemplatesChecked(true);
      onConnectionCheck?.(true);
    } catch (e) {
      if (request !== templateRequest.current) return;
      setTemplateError(e instanceof Error ? e.message : 'Unable to load approved templates.');
      onConnectionCheck?.(false);
    } finally {
      if (request === templateRequest.current) setTemplatesLoading(false);
    }
  }, [accountWhatsApp, ready, config?.whatsapp, onConnectionCheck]);
  useEffect(() => {
    void loadTemplates();
    return () => {
      templateRequest.current++;
    };
  }, [loadTemplates]);
  useEffect(() => {
    setSenderVerified(false);
    setSenderDetail('');
    if (!ready || !config?.whatsapp || !config?.cron) return;
    let active = true;
    void api<SetupReport>('setup')
      .then((report) => {
        const worker = report.checks.find((check) => check.name === 'Scheduled worker activity');
        const webhook = report.checks.find((check) => check.name === 'Signed Meta webhook');
        if (!active) return;
        setSenderVerified(worker?.status === 'verified' && webhook?.status === 'verified');
        setSenderDetail(
          [
            webhook?.status !== 'verified' && 'Meta delivery updates are not verified yet.',
            worker?.status !== 'verified' && 'No recent campaign worker run is verified.',
          ]
            .filter(Boolean)
            .join(' '),
        );
      })
      .catch(() => {
        if (active) setSenderDetail('Could not check campaign sending. Reopen the draft to retry.');
      });
    return () => {
      active = false;
    };
  }, [ready, config?.whatsapp, config?.cron]);
  const requiredParameters = template ? templateParameters(template.body) : [];
  const mapped =
    !!template &&
    requiredParameters.every((key) => !!input.variables[key]) &&
    Object.values(input.variables).includes('booking_link');
  const checks = [
    {
      ready: ready && !!config?.whatsapp && !!config?.cron && senderVerified,
      title: 'Campaign sending activated',
      detail:
        !ready && linkedInbox
          ? 'Your QR number is connected for inbox chats. Campaigns need a separate Meta sender enabled in the campaign workspace. Keep the QR inbox connected.'
          : !ready
            ? 'Campaigns are sent from the configured lab admin workspace.'
            : !config?.whatsapp || !config?.cron
              ? 'Set up the Meta campaign sender and campaign scheduler in the lab admin workspace.'
              : senderDetail || 'Checking Meta delivery updates and the campaign worker…',
    },
    {
      ready: !!offer,
      title: 'Saved offer selected',
      detail: 'Choose a saved, valid health offer in Campaign details.',
    },
    {
      ready: templatesChecked && !templateError,
      title: 'WhatsApp connection accepted by Meta',
      detail:
        templateError ||
        (!ready && linkedInbox
          ? 'Marketing templates belong to the separate Meta sender, not the QR inbox.'
          : 'Check the saved access token and retrieve your approved templates.'),
    },
    {
      ready: !!template,
      title: 'Approved marketing template selected',
      detail: 'The illustrative example is a preview. Select your actual approved template.',
    },
    {
      ready: mapped,
      title: 'Message fields mapped',
      detail: 'Map every template variable, including a campaign booking link.',
    },
    {
      ready: !!estimate?.count,
      title: 'Eligible audience checked',
      detail: 'Estimate the audience to confirm at least one customer with marketing consent.',
    },
    ...(template?.header === 'IMAGE'
      ? [
          {
            ready: !!input.bannerPath,
            title: 'Promotional banner uploaded',
            detail: 'This approved template requires an image header.',
          },
        ]
      : []),
  ];
  const canLaunch = checks.every((check) => check.ready) && input.name.trim().length >= 3;
  const completedSteps = [input.name.trim().length >= 3 && !!offer, !!estimate?.count, canLaunch];
  const values: Record<string, string> = {
    customer_name: 'Customer',
    offer_title: offer?.title || 'Your health package',
    original_price: money(offer?.originalPrice || 0),
    offer_price: money(offer?.offerPrice || 0),
    expiry_date: offer ? dateLabel(offer.expiresAt) : 'Offer expiry date',
    lab_phone: config?.labPhone || 'Lab phone',
    booking_link: `${typeof window !== 'undefined' ? window.location.origin : ''}/book/[campaign-link]`,
    preferences_link: '[secure preference link]',
  };
  const preview = template
    ? renderTemplate(
        template.body,
        Object.fromEntries(Object.entries(input.variables).map(([k, v]) => [k, values[v]])),
      )
    : 'Hello {{customer_name}} 👋\n\n🩺 Special Health Checkup Offer!\n\nGreetings from Baunthiyal Path Lab.\n\n🎉 Get a special discount on our health checkup packages.\n\n🧪 Package: Full Body Health Checkup\n💰 Regular Price: ₹1,499\n🔥 Offer Price: ₹999\n\n📅 Offer Valid Until: {{expiry_date}}\n📍 Visit Baunthiyal Path Lab\n📞 Contact: {{lab_phone}}\n\nBook Now: {{booking_link}}\n\nBaunthiyal Path Lab\nYour Health, Our Priority\n\nReply STOP to opt out of promotional messages.';
  async function save(launch = false) {
    setError('');
    setBusy(true);
    try {
      if (!ready)
        throw new Error('Campaign saving and sending are not activated for this workspace yet.');
      const payload = { ...input, scheduledAt: scheduled ? toISO(scheduled) : null };
      const c = await api<{ id: string }>(
        existing ? `campaigns/${existing.id}` : 'campaigns',
        payload,
      );
      const id = existing?.id || c.id;
      if (launch) await api(`campaigns/${id}/launch`, {});
      await onDone(
        launch ? 'Campaign scheduled for the sending worker.' : 'Campaign saved as a draft',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to save');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      wide
      title={existing ? 'Edit campaign' : 'Create a new campaign'}
      description="A thoughtful offer. The right audience. A meaningful connection."
      onClose={onClose}
    >
      <div className="wizard-steps">
        {['Campaign details', 'Audience & schedule', 'Message & launch'].map((label, i) => (
          <button
            key={label}
            className={step === i ? 'current' : completedSteps[i] ? 'complete' : ''}
            onClick={() => setStep(i)}
          >
            <span>{step !== i && completedSteps[i] ? <Check size={14} /> : i + 1}</span>
            {label}
          </button>
        ))}
      </div>
      <div className="modal-body">
        {error && <Notice error>{error}</Notice>}
        {!ready && (
          <Notice>
            Campaign saving and sending are not activated for this workspace yet. You can check your
            WhatsApp connection and approved templates below.
          </Notice>
        )}
        {step === 0 && (
          <>
            <div className="form-grid">
              <Field label="Campaign name">
                <input
                  required
                  placeholder="e.g. A healthier start — Full body checkup"
                  maxLength={120}
                  value={input.name}
                  onChange={(e) => update({ name: e.target.value })}
                />
              </Field>
              <Field label="Campaign type">
                <select
                  value={input.type}
                  onChange={(e) => update({ type: e.target.value as CampaignInput['type'] })}
                >
                  {[
                    'Health package',
                    'Festival',
                    'Seasonal',
                    'Retention',
                    'Referral',
                    'Custom',
                  ].map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </Field>
            </div>
            <Field
              label="Select an offer"
              hint="Offers include the title, description, prices, dates, selected tests, and eligibility rules."
            >
              <select value={input.offerId} onChange={(e) => update({ offerId: e.target.value })}>
                <option value="">Choose a saved offer</option>
                {data.offers.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.title} · {o.id} · {money(o.offerPrice)}
                  </option>
                ))}
              </select>
            </Field>
            {!data.offers.length && (
              <Notice>
                Create a test or package and an offer under “Offers & packages” before saving a
                campaign.
              </Notice>
            )}
            {offer && (
              <div className="selected-offer">
                <div>
                  <span className="badge green">{offer.id}</span>
                  <h3>{offer.title}</h3>
                  <p>{offer.description}</p>
                </div>
                <div className="selected-offer-price">
                  <s>{money(offer.originalPrice)}</s>
                  <strong>{money(offer.offerPrice)}</strong>
                  <small>Valid until {dateLabel(offer.expiresAt)}</small>
                </div>
              </div>
            )}
            <div className="field">
              <span>Promotional banner</span>
              <CampaignBanner
                path={input.bannerPath}
                enabled={(ready || accountWhatsApp) && !busy}
                onChange={(path) => update({ bannerPath: path })}
                onPreview={setBannerPreview}
                onBusyChange={setBusy}
              />
              <small>
                Use an approved template with an image header to include the banner in WhatsApp.
              </small>
            </div>
          </>
        )}
        {step === 1 && (
          <>
            <div className="consent-notice">
              <ShieldCheck size={22} />
              <div>
                <strong>Only customers who said yes.</strong>
                <p>
                  Every audience is filtered by recorded marketing consent and checked again before
                  each send.
                </p>
              </div>
            </div>
            <Field label="Target audience">
              <select
                value={input.audience.type}
                onChange={(e) =>
                  audience({ type: e.target.value as CampaignInput['audience']['type'] })
                }
              >
                <option value="all">All marketing-opted-in customers</option>
                <option value="existing">Existing customers with a visit</option>
                <option value="last_visit">Customers by last visit date</option>
                <option value="test_history">Customers by test history</option>
                <option value="groups">Custom customer groups</option>
                <option value="manual">Manually selected customers</option>
              </select>
            </Field>
            {input.audience.type === 'last_visit' && (
              <div className="form-grid">
                <Field label="Last visit from">
                  <input
                    type="date"
                    value={input.audience.from || ''}
                    onChange={(e) => audience({ from: e.target.value })}
                  />
                </Field>
                <Field label="Last visit to">
                  <input
                    type="date"
                    value={input.audience.to || ''}
                    onChange={(e) => audience({ to: e.target.value })}
                  />
                </Field>
              </div>
            )}
            {input.audience.type === 'test_history' && (
              <Field label="Match any of these tests or packages">
                <div className="checkbox-list">
                  {data.tests.map((t) => (
                    <label className="check-label" key={t.id}>
                      <input
                        type="checkbox"
                        checked={input.audience.testIds.includes(t.id)}
                        onChange={(e) =>
                          audience({
                            testIds: e.target.checked
                              ? [...input.audience.testIds, t.id]
                              : input.audience.testIds.filter((id) => id !== t.id),
                          })
                        }
                      />
                      {t.name}
                    </label>
                  ))}
                </div>
              </Field>
            )}
            {input.audience.type === 'groups' && (
              <Field label="Customer groups" hint="Comma-separated, exact group names.">
                <input
                  value={input.audience.groups.join(', ')}
                  onChange={(e) =>
                    audience({ groups: e.target.value.split(',').map((g) => g.trim()) })
                  }
                  placeholder="e.g. Wellness members, Community camp"
                />
              </Field>
            )}
            {input.audience.type === 'manual' && (
              <>
                <div className="section-heading">
                  <strong>Select opted-in customers</strong>
                  <button
                    className="text-button"
                    onClick={() =>
                      audience({
                        customerIds:
                          input.audience.customerIds.length === opted.length
                            ? []
                            : opted.map((c) => c.id),
                      })
                    }
                  >
                    {input.audience.customerIds.length === opted.length && opted.length
                      ? 'Clear selection'
                      : 'Select all eligible customers'}
                  </button>
                </div>
                <div className="checkbox-list">
                  {opted.length ? (
                    opted.map((c) => (
                      <label className="check-label" key={c.id}>
                        <input
                          type="checkbox"
                          checked={input.audience.customerIds.includes(c.id)}
                          onChange={(e) =>
                            audience({
                              customerIds: e.target.checked
                                ? [...input.audience.customerIds, c.id]
                                : input.audience.customerIds.filter((id) => id !== c.id),
                            })
                          }
                        />
                        <span>
                          {c.name}
                          <small>+{c.phone}</small>
                        </span>
                      </label>
                    ))
                  ) : (
                    <p className="muted-text">No opted-in customers are loaded.</p>
                  )}
                </div>
              </>
            )}
            <div className="estimate-box">
              <div>
                <Users size={20} />
                <span>
                  <strong>
                    {estimate
                      ? `${estimate.count} eligible customers`
                      : 'Know your reach before you send'}
                  </strong>
                  <small>
                    {estimate
                      ? `Estimated message cost: ${estimate.estimatedCost !== null ? money(estimate.estimatedCost) : 'Rate not configured'}`
                      : 'Offer eligibility and consent are both applied.'}
                  </small>
                </span>
              </div>
              <button
                className="button secondary small-button"
                disabled={!ready || !input.offerId || estimating}
                onClick={async () => {
                  setEstimating(true);
                  setError('');
                  try {
                    setEstimate(await api('audience', input));
                  } catch (e) {
                    setError(String(e));
                  } finally {
                    setEstimating(false);
                  }
                }}
              >
                {estimating ? <LoaderCircle className="spin" size={14} /> : null}Estimate audience
              </button>
            </div>
            <Field
              label="Schedule campaign"
              hint="Leave empty to make it available to the next scheduled worker run."
            >
              <input
                type="datetime-local"
                min={localDate()}
                value={scheduled}
                onChange={(e) => setScheduled(e.target.value)}
              />
            </Field>
            <p className="muted-text">
              Times follow your browser’s time zone. Campaigns run only within the offer validity
              dates. The current sending queue supports up to 1,000 recipients per campaign.
            </p>
          </>
        )}
        {step === 2 && (
          <>
            <div className="launch-checklist" id="launch-requirements">
              <div className="section-heading">
                <h3>What’s needed to launch</h3>
                <span>
                  {checks.filter((check) => check.ready).length} of {checks.length} ready
                </span>
              </div>
              <ul>
                {checks.map((check) => (
                  <li key={check.title} className={check.ready ? 'complete' : ''}>
                    <span>{check.ready ? <Check size={15} /> : <Info size={15} />}</span>
                    <div>
                      <strong>{check.title}</strong>
                      {!check.ready && <p>{check.detail}</p>}
                    </div>
                  </li>
                ))}
              </ul>
              {onOpenIntegration && (
                <button
                  type="button"
                  className="button secondary small-button"
                  onClick={onOpenIntegration}
                >
                  Open WhatsApp Integration <ArrowRight size={14} />
                </button>
              )}
            </div>
            <div className="message-builder">
              <div>
                <Field label="Meta-approved marketing template">
                  <select
                    disabled={templatesLoading}
                    value={input.templateId}
                    onChange={(e) => {
                      const t = templates.find((t) => t.id === e.target.value);
                      const variables: Record<string, CampaignInput['variables'][string]> = {};
                      t &&
                        templateParameters(t.body).forEach((k) => {
                          if (optionFields.includes(k as (typeof optionFields)[number]))
                            variables[k] = k as (typeof optionFields)[number];
                        });
                      update({ templateId: e.target.value, variables });
                    }}
                  >
                    <option value="">
                      {templatesLoading
                        ? 'Checking templates with Meta…'
                        : 'Select an approved template'}
                    </option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} · {t.language}
                      </option>
                    ))}
                    {unavailableTemplates.map((t) => (
                      <option key={t.id} value={`unavailable-${t.id}`} disabled>
                        {t.name} · {t.language} — needs changes
                      </option>
                    ))}
                  </select>
                </Field>
                {templateError && (
                  <Notice error>
                    {templateError}{' '}
                    {templateError.includes('190') &&
                      'Live apps still require a valid WhatsApp access token. Update the token in WhatsApp Integration; do not remove authentication.'}
                  </Notice>
                )}
                {(accountWhatsApp || config?.whatsapp) && (
                  <button
                    type="button"
                    className="text-button"
                    disabled={templatesLoading}
                    onClick={() => void loadTemplates()}
                  >
                    <RefreshCw size={14} className={templatesLoading ? 'spin' : ''} />
                    Refresh approved templates
                  </button>
                )}
                {!accountWhatsApp && !config?.whatsapp && (
                  <Notice>
                    Connect the official WhatsApp Business API to load approved templates. The
                    example preview cannot be sent.
                  </Notice>
                )}
                {templatesChecked && !templates.length && !templateError && (
                  <Notice>
                    {approvedMarketing
                      ? `${approvedMarketing} approved marketing template(s) were found, but none support this campaign format.`
                      : 'Meta returned no approved marketing templates for this WhatsApp account.'}
                    {templateReasons.length > 0 && (
                      <ul>
                        {templateReasons.slice(0, 4).map((reason) => (
                          <li key={reason}>{reason}</li>
                        ))}
                      </ul>
                    )}
                    <a
                      href="https://business.facebook.com/wa/manage/message-templates/"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Manage templates in Meta
                    </a>
                  </Notice>
                )}
                {templatesChecked && (pendingMarketing > 0 || rejectedMarketing > 0) && (
                  <Notice>
                    Meta reports {pendingMarketing} pending and {rejectedMarketing} rejected
                    marketing template(s). These become available only after Meta approval.
                  </Notice>
                )}
                {unavailableTemplates.length > 0 && (
                  <details className="template-diagnostics">
                    <summary>
                      Why some approved templates cannot be sent ({unavailableTemplates.length})
                    </summary>
                    {unavailableTemplates.map((t) => (
                      <div key={t.id}>
                        <strong>
                          {t.name} · {t.language}
                        </strong>
                        <ul>
                          {t.reasons.map((reason) => (
                            <li key={reason}>{reason}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </details>
                )}
                {template && (
                  <>
                    <div className="section-heading">
                      <h3>Personalize your message</h3>
                    </div>
                    {templateParameters(template.body).map((key) => (
                      <Field key={key} label={`{{${key}}}`}>
                        <select
                          value={input.variables[key] || ''}
                          onChange={(e) =>
                            update({
                              variables: {
                                ...input.variables,
                                [key]: e.target.value as CampaignInput['variables'][string],
                              },
                            })
                          }
                        >
                          <option value="">Map to a field</option>
                          {optionFields.map((f) => (
                            <option value={f} key={f}>
                              {f.replaceAll('_', ' ')}
                            </option>
                          ))}
                        </select>
                      </Field>
                    ))}
                  </>
                )}
                {bannerPreview && template && template.header !== 'IMAGE' && (
                  <Notice>
                    This template has no image header. Choose an image-header template to send your
                    banner with the message.
                  </Notice>
                )}
                <div className="consent-notice small-consent">
                  <ShieldCheck size={19} />
                  <p>
                    Include a booking link for attribution and “Reply STOP” for easy opt-out. Meta
                    approval is required for changes to template wording.
                  </p>
                </div>
              </div>
              <div className="phone-preview">
                <div className="phone-preview-head">
                  <img src="/logo.svg" alt="" width={32} height={32} />
                  <div>
                    <strong>Baunthiyal Path Lab</strong>
                    <small>WhatsApp message preview</small>
                  </div>
                </div>
                <div className="phone-preview-body">
                  <span className="preview-date">
                    {template ? 'TEMPLATE PREVIEW' : 'ILLUSTRATIVE EXAMPLE'}
                  </span>
                  <div className="preview-bubble">
                    {(!template || template.header === 'IMAGE') && bannerPreview && (
                      <img
                        className="message-banner"
                        src={bannerPreview}
                        alt="Campaign banner in WhatsApp preview"
                      />
                    )}
                    {template?.headerText && (
                      <strong className="message-template-header">{template.headerText}</strong>
                    )}
                    {preview}
                    {template?.footer && (
                      <small className="message-template-footer">{template.footer}</small>
                    )}
                    <div className="bubble-meta">
                      Preview <CheckCheck size={12} />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
      <div className="modal-footer wizard-footer">
        <button
          type="button"
          className="text-button"
          onClick={() => void save()}
          disabled={busy || !ready}
        >
          Save as draft
        </button>
        <div className="inline-actions">
          {step > 0 && (
            <button className="button secondary" disabled={busy} onClick={() => setStep(step - 1)}>
              <ArrowLeft size={15} />
              Back
            </button>
          )}
          {step < 2 ? (
            <button className="button primary" disabled={busy} onClick={() => setStep(step + 1)}>
              Continue <ArrowRight size={15} />
            </button>
          ) : (
            <button
              className="button primary"
              disabled={busy || !canLaunch}
              aria-describedby="launch-requirements"
              onClick={() => void save(true)}
            >
              {busy ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}Launch
              campaign
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
export function OfferForm({
  tests,
  ready,
  accountMode = false,
  onClose,
  onDone,
  onCatalog,
}: {
  tests: TestRecord[];
  ready: boolean;
  accountMode?: boolean;
  onClose: () => void;
  onDone: (s?: string) => Promise<void>;
  onCatalog: () => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<string>(offerTypes[0]);
  const [kind, setKind] = useState<'percentage' | 'fixed'>('percentage');
  const [discount, setDiscount] = useState('');
  const [original, setOriginal] = useState('');
  const [start, setStart] = useState(localDate());
  const [end, setEnd] = useState(localDate(30));
  const [ids, setIds] = useState<string[]>([]);
  const [rule, setRule] = useState('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const pricedTests = tests.filter((test) => typeof test.price === 'number' && test.price > 0);
  const selectedTests = tests.filter((test) => ids.includes(test.id));
  const selectedTotal = selectedTests.reduce((sum, test) => sum + (test.price ?? 0), 0);
  const validSelection =
    ids.length > 0 &&
    ids.length <= 20 &&
    ids.every((id) => pricedTests.some((test) => test.id === id));
  const total = accountMode ? selectedTotal : Math.round(Number(original) * 100);
  const shownTests = tests.filter((test) =>
    `${test.name} ${test.id}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const value = kind === 'fixed' ? Math.round(Number(discount) * 100) : Number(discount);
  return (
    <Modal
      wide
      title="Create a health offer"
      description="One clear offer. Automatically calculated discounts. A unique BPL Offer ID."
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            if (!validSelection)
              throw new Error(
                'Select between 1 and 20 tests or packages with a positive lab rate.',
              );
            if (!Number.isSafeInteger(total) || total <= 0 || total > 100000000)
              throw new Error('The original price must be between ₹0.01 and ₹10,00,000.');
            if (Date.parse(end) <= Date.parse(start))
              throw new Error('The expiry date must follow the start date.');
            await (accountMode ? accountApi : api)(accountMode ? 'account/offers' : 'offers', {
              title,
              description,
              type,
              discountType: kind,
              discountValue: value,
              originalPrice: total,
              startsAt: toISO(start),
              expiresAt: toISO(end),
              testIds: ids,
              eligibility: rule,
            });
            await onDone('Offer created with a unique Offer ID');
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Unable to save this offer.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="modal-body">
          {error && <Notice error>{error}</Notice>}
          <div className="form-grid">
            <Field label="Offer title">
              <input
                required
                minLength={3}
                maxLength={120}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Complete wellness checkup"
              />
            </Field>
            <Field label="Offer type">
              <select
                value={type}
                onChange={(e) => {
                  setType(e.target.value);
                  const mapping: Record<string, string> = {
                    'Senior Citizen Offer': 'senior',
                    'New Customer Offer': 'new',
                    'Repeat Customer Offer': 'repeat',
                    'Referral Offer': 'referral',
                  };
                  setRule(mapping[e.target.value] || 'all');
                }}
              >
                {offerTypes.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Offer description">
            <textarea
              required
              minLength={5}
              maxLength={1500}
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is included, and why is this the right checkup?"
            />
          </Field>
          <div className="form-grid three">
            <Field
              label="Original price (₹)"
              hint={
                accountMode
                  ? 'Calculated from the current saved rates of the selected tests.'
                  : undefined
              }
            >
              <input
                type="number"
                required
                min="0.01"
                step="0.01"
                max="1000000"
                value={
                  accountMode ? (selectedTotal > 0 ? String(selectedTotal / 100) : '') : original
                }
                readOnly={accountMode}
                onChange={(e) => setOriginal(e.target.value)}
              />
            </Field>
            <Field label="Discount type">
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as 'percentage' | 'fixed')}
              >
                <option value="percentage">Percentage (%)</option>
                <option value="fixed">Fixed amount (₹)</option>
              </select>
            </Field>
            <Field label={kind === 'percentage' ? 'Discount percentage' : 'Discount amount (₹)'}>
              <input
                type="number"
                required
                min="0.01"
                max={kind === 'percentage' ? 100 : total / 100 || undefined}
                step="0.01"
                value={discount}
                onChange={(e) => setDiscount(e.target.value)}
              />
            </Field>
          </div>
          <div className="price-summary">
            <span>Final offer price</span>
            <strong>{money(finalPrice(total, kind, value))}</strong>
            <small>Automatically applied to eligible job cards</small>
          </div>
          <div className="form-grid">
            <Field label="Start date">
              <input
                type="datetime-local"
                required
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </Field>
            <Field label="Expiry date">
              <input
                type="datetime-local"
                required
                min={start}
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </Field>
          </div>
          <Field
            label="Find a test or health package"
            hint="Search the saved catalog by name or test ID."
          >
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="e.g. CBC, thyroid, BPL-REF…"
            />
          </Field>
          <div className="field">
            <span id="offer-test-selection">
              Tests or health packages · {ids.length} of 20 selected
            </span>
            {!pricedTests.length && (
              <Notice>
                Set lab rates in Tests & packages before creating an offer.{' '}
                <button type="button" className="text-button" onClick={onCatalog}>
                  Open Tests & packages <ArrowRight size={13} />
                </button>
              </Notice>
            )}
            <div className="checkbox-list" role="group" aria-labelledby="offer-test-selection">
              {shownTests.length ? (
                shownTests.map((t) => (
                  <label className="check-label" key={t.id}>
                    <input
                      type="checkbox"
                      checked={ids.includes(t.id)}
                      disabled={
                        !ids.includes(t.id) &&
                        (t.price === null || t.price <= 0 || ids.length >= 20)
                      }
                      onChange={(e) =>
                        setIds(
                          e.target.checked
                            ? [...ids, t.id].slice(0, 20)
                            : ids.filter((id) => id !== t.id),
                        )
                      }
                    />
                    <span>
                      {t.name}{' '}
                      <small>
                        {t.type === 'package' ? 'Health package' : 'Lab test'} ·{' '}
                        {t.price === null
                          ? 'Rate pending'
                          : `${money(t.price)}${t.price <= 0 ? ' · Positive rate required for offers' : ''}`}
                      </small>
                    </span>
                  </label>
                ))
              ) : (
                <div>
                  <p className="muted-text">
                    {tests.length
                      ? 'No tests match this search.'
                      : 'Add a test or package to your catalog first.'}
                  </p>
                  <button type="button" className="text-button" onClick={onCatalog}>
                    <Plus size={14} />
                    Open Tests & packages
                  </button>
                </div>
              )}
            </div>
            <small>
              Only entries with a positive saved lab rate can be selected. Choose up to 20 tests or
              packages.
            </small>
          </div>
          <Field label="Eligibility">
            <select value={rule} onChange={(e) => setRule(e.target.value)}>
              <option value="all">All customers</option>
              <option value="senior">Senior citizens (60+)</option>
              <option value="new">New customers (no previous visits)</option>
              <option value="repeat">Repeat customers (1+ visits)</option>
              <option value="referral">Customers with a verified referral</option>
            </select>
          </Field>
        </div>
        <div className="modal-footer">
          {!validSelection && (
            <span className="muted-text" style={{ marginRight: 'auto' }}>
              Select at least one priced test or package to create the offer.
            </span>
          )}
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <Submit busy={busy} disabled={!ready || !validSelection}>
            Create offer
          </Submit>
        </div>
      </form>
    </Modal>
  );
}
export function CustomerForm({
  ready,
  accountMode = false,
  onClose,
  onDone,
}: {
  ready: boolean;
  accountMode?: boolean;
  onClose: () => void;
  onDone: (s?: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [age, setAge] = useState('');
  const [groups, setGroups] = useState('');
  const [consent, setConsent] = useState(false);
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal
      title="Register a customer"
      description="Keep marketing preferences separate from essential lab notifications."
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await (accountMode ? accountApi : api)(
              accountMode ? 'account/customers' : 'customers',
              {
                name,
                phone,
                marketingConsent: consent,
                consentSource: source,
                groups: groups
                  .split(',')
                  .map((g) => g.trim())
                  .filter(Boolean),
                ...(age ? { age: Number(age) } : {}),
              },
            );
            await onDone('Customer and consent record saved');
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Unable to save customer.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="modal-body">
          {error && <Notice error>{error}</Notice>}
          <Field label="Full name">
            <input
              required
              minLength={2}
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <div className="form-grid">
            <Field label="WhatsApp phone number" hint="Include country code, e.g. +91.">
              <input required type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </Field>
            <Field label="Age (optional)">
              <input
                type="number"
                min={0}
                max={130}
                value={age}
                onChange={(e) => setAge(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Customer groups (optional)">
            <input
              value={groups}
              onChange={(e) => setGroups(e.target.value)}
              placeholder="Separate groups with commas"
            />
          </Field>
          <div className="consent-notice">
            <ShieldCheck size={23} />
            <div>
              <strong>A choice that belongs to the customer</strong>
              <p>
                Verify the phone number and record their choice. Leaving this unchecked will exclude
                them from promotional campaigns.
              </p>
            </div>
          </div>
          <label className="check-label consent-checkbox">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            <span>
              The customer explicitly agrees to receive promotional WhatsApp messages from
              Baunthiyal Path Lab and understands they can opt out at any time.
            </span>
          </label>
          <Field label="Preference source / evidence">
            <input
              required
              minLength={3}
              maxLength={200}
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="e.g. In-person registration form, verified by staff"
            />
          </Field>
        </div>
        <div className="modal-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <Submit busy={busy} disabled={!ready}>
            Save customer
          </Submit>
        </div>
      </form>
    </Modal>
  );
}
export function CatalogForm({
  ready,
  accountMode = false,
  onClose,
  onDone,
}: {
  ready: boolean;
  accountMode?: boolean;
  onClose: () => void;
  onDone: (s?: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [type, setType] = useState('test');
  const [category, setCategory] = useState('General');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal
      title="Add a test or health package"
      description="Save a real catalog record to use in offers."
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            const rate = price.trim() ? Math.round(Number(price) * 100) : null;
            if (rate !== null && (!Number.isSafeInteger(rate) || rate < 0 || rate > 100000000))
              throw new Error('Enter a valid lab rate between ₹0 and ₹10,00,000.');
            if (!accountMode && (rate === null || rate <= 0))
              throw new Error('Enter a positive lab rate.');
            await (accountMode ? accountApi : api)(accountMode ? 'account/catalog' : 'tests', {
              name: name.trim(),
              price: rate,
              type,
              ...(accountMode ? { category: category.trim(), aliases: [] } : {}),
            });
            await onDone('Catalog record saved');
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Unable to save this catalog entry.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="modal-body">
          {error && <Notice error>{error}</Notice>}
          <Field label="Name">
            <input
              required
              value={name}
              minLength={2}
              maxLength={180}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <div className="form-grid">
            <Field label="Type">
              <select value={type} onChange={(e) => setType(e.target.value)}>
                <option value="test">Lab test</option>
                <option value="package">Health package</option>
              </select>
            </Field>
            <Field
              label="Price (₹)"
              hint={
                accountMode
                  ? 'Leave blank to save with the rate pending. Enter a positive rate before using it in an offer.'
                  : undefined
              }
            >
              <input
                required={!accountMode}
                type="number"
                min={accountMode ? '0' : '0.01'}
                max="1000000"
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
            </Field>
          </div>
          {accountMode && (
            <Field label="Category">
              <input
                required
                maxLength={80}
                value={category}
                onChange={(event) => setCategory(event.target.value)}
              />
            </Field>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <Submit busy={busy} disabled={!ready}>
            Save to catalog
          </Submit>
        </div>
      </form>
    </Modal>
  );
}
export function BookingJobForm({
  booking,
  customers,
  onClose,
  onDone,
}: {
  booking: Booking;
  customers: Customer[];
  onClose: () => void;
  onDone: (s?: string) => Promise<void>;
}) {
  const matching = customers.filter((c) => c.phone === booking.phone);
  const [id, setId] = useState(matching[0]?.id || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal
      title="Create a campaign job card"
      description={`${booking.name} · +${booking.phone}`}
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const d = await api<{ jobId: string }>(`bookings/${booking.id}/job`, {
              customerId: id,
            });
            await onDone(`Job card ${d.jobId} created with the eligible discount`);
          } catch (e) {
            setError(String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="modal-body">
          {error && <Notice error>{error}</Notice>}
          <Field label="Registered customer with matching phone">
            <select required value={id} onChange={(e) => setId(e.target.value)}>
              <option value="">Select registered customer</option>
              {matching.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · +{c.phone}
                </option>
              ))}
            </select>
          </Field>
          {!matching.length && (
            <Notice>
              Register this customer under Customer audience, verify phone ownership and
              preferences, then return to create the job card.
            </Notice>
          )}
          <Notice>
            The server rechecks offer dates and eligibility, locks in the price and discount, and
            links the job card to {booking.campaignId}. No payment is assumed.
          </Notice>
        </div>
        <div className="modal-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <Submit busy={busy} disabled={!id}>
            Create job card
          </Submit>
        </div>
      </form>
    </Modal>
  );
}
export function PaymentForm({
  jobId,
  onClose,
  onDone,
}: {
  jobId: string;
  onClose: () => void;
  onDone: (s?: string) => Promise<void>;
}) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal title="Record a received payment" description={jobId} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api(`jobs/${jobId}/payments`, {
              amount: Math.round(Number(amount) * 100),
              method,
              reference,
            });
            await onDone('Payment recorded and campaign revenue updated');
          } catch (e) {
            setError(String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="modal-body">
          {error && <Notice error>{error}</Notice>}
          <div className="form-grid">
            <Field label="Amount received (₹)">
              <input
                type="number"
                required
                min="0.01"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
            <Field label="Payment method">
              <select value={method} onChange={(e) => setMethod(e.target.value)}>
                {['cash', 'upi', 'card', 'bank'].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Unique payment reference">
            <input
              required
              minLength={3}
              maxLength={150}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="e.g. UPI transaction ID or cash receipt number"
            />
          </Field>
          <Notice>
            Only record payments actually received. Duplicate references and amounts above the
            outstanding balance are rejected.
          </Notice>
        </div>
        <div className="modal-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <Submit busy={busy}>Record payment</Submit>
        </div>
      </form>
    </Modal>
  );
}
