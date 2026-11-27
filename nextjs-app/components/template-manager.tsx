'use client';
import { useEffect, useState } from 'react';
import { Copy, FileText, LoaderCircle, Plus, RefreshCw, Send } from 'lucide-react';
import { accountApi, Field, Notice } from './ui';
import { CampaignBanner } from './campaign-banner';
import {
  newTemplateDraft,
  positionalVariables,
  type TemplateDraft,
  type TemplateDraftInput,
  type ManagedTemplate,
} from '@/lib/template-manager';

type Result = {
  drafts: TemplateDraft[];
  templates: ManagedTemplate[];
  connected: boolean;
  lastSyncedAt: string | null;
  truncated: boolean;
};
export default function TemplateManager({ onOpenIntegration }: { onOpenIntegration: () => void }) {
  const [data, setData] = useState<Result | null>(null),
    [input, setInput] = useState<TemplateDraftInput>(newTemplateDraft);
  const [editing, setEditing] = useState<TemplateDraft | null>(null),
    [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [preview, setPreview] = useState(''),
    [uploading, setUploading] = useState(false),
    [formKey, setFormKey] = useState(0);
  const [query, setQuery] = useState(''),
    [status, setStatus] = useState('ALL');
  async function load() {
    try {
      const result = await accountApi<Result>('account/templates');
      setData(result);
      return result;
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );
  const update = (values: Partial<TemplateDraftInput>) =>
    setInput((current) => ({ ...current, ...values }));
  let variables: number[] = [],
    variableError = '';
  try {
    variables = positionalVariables(input.body);
  } catch (e) {
    variableError = (e as Error).message;
  }
  async function save() {
    const result = await accountApi<{ draft: TemplateDraft }>(
      'account/templates/drafts' + (editing ? '/' + editing.id : ''),
      { draft: input, ...(editing ? { expectedRevision: editing.revision } : {}) },
    );
    setEditing(result.draft);
    return result.draft;
  }
  async function act(kind: 'save' | 'submit' | 'sync', draft?: TemplateDraft) {
    setBusy(kind);
    setError('');
    setNotice('');
    let activeDraft = draft;
    try {
      if (kind === 'sync') {
        const result = await accountApi<{ message: string }>('account/templates/sync', {});
        setNotice(result.message);
      } else {
        const saved = draft || (await save());
        activeDraft = saved;
        if (kind === 'submit') {
          const result = await accountApi<{ message: string; draft: TemplateDraft }>(
            `account/templates/drafts/${saved.id}/submit`,
            {},
          );
          setNotice(result.message);
          if (!draft) setEditing(result.draft);
        } else setNotice('Template draft saved in your workspace.');
      }
      const refreshed = await load();
      if (kind === 'sync' && editing) {
        const current = refreshed?.drafts.find((d) => d.id === editing.id);
        if (current) setEditing(current);
      }
    } catch (e) {
      setError((e as Error).message);
      const latest = await load();
      if (!draft && activeDraft) {
        const current = latest?.drafts.find((d) => d.id === activeDraft!.id);
        if (current) setEditing(current);
      }
    } finally {
      setBusy('');
    }
  }
  function choose(draft?: TemplateDraft) {
    setEditing(draft || null);
    setInput(
      draft
        ? (Object.fromEntries(
            Object.keys(newTemplateDraft()).map((k) => [k, draft[k as keyof TemplateDraftInput]]),
          ) as TemplateDraftInput)
        : newTemplateDraft(),
    );
    setPreview('');
    setFormKey((k) => k + 1);
    setError('');
    setNotice('');
  }
  function duplicate(draft: TemplateDraft) {
    choose();
    setInput({
      ...Object.fromEntries(
        Object.keys(newTemplateDraft()).map((k) => [k, draft[k as keyof TemplateDraftInput]]),
      ),
      name: draft.name.slice(0, 90) + '_copy',
    } as TemplateDraftInput);
  }
  const readOnly = !!editing && editing.state !== 'DRAFT';
  const previewBody = input.body.replace(
    /\{\{(\d+)\}\}/g,
    (m, n) => input.examples[Number(n) - 1] || m,
  );
  const templates = (data?.templates || []).filter(
    (t) =>
      (status === 'ALL' || t.status === status) &&
      `${t.name} ${t.language}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="crm-module">
      <div className="crm-heading">
        <div>
          <h2>
            <FileText size={21} /> WhatsApp Template Manager
          </h2>
          <p>
            Save drafts, submit text or image templates to Meta, and check the real approval status.
          </p>
        </div>
        <button
          type="button"
          className="button secondary"
          disabled={!!busy || !data?.connected}
          onClick={() => void act('sync')}
        >
          <RefreshCw size={16} />
          Refresh Meta status
        </button>
      </div>
      {error && <Notice error>{error}</Notice>}
      {notice && <Notice>{notice}</Notice>}
      {data && !data.connected && (
        <Notice>
          Drafts can be saved now.{' '}
          <button className="text-button" onClick={onOpenIntegration}>
            Connect WhatsApp
          </button>{' '}
          to submit templates or refresh Meta status.
        </Notice>
      )}
      <div className="crm-grid">
        <section className="panel crm-card">
          <div className="crm-heading">
            <h3>{editing ? editing.name : 'Create a template draft'}</h3>
            <button
              type="button"
              className="text-button"
              disabled={!!busy || uploading}
              onClick={() => choose()}
            >
              <Plus size={15} />
              New draft
            </button>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void act('save');
            }}
          >
            <fieldset disabled={!!busy || uploading || readOnly} className="crm-fieldset">
              <Field label="Template name" hint="Lowercase letters, numbers and underscores.">
                <input
                  required
                  maxLength={100}
                  value={input.name}
                  onChange={(e) => update({ name: e.target.value })}
                  placeholder="bpl_health_checkup_offer"
                />
              </Field>
              <div className="crm-two-fields">
                <Field label="Language">
                  <select
                    value={input.language}
                    onChange={(e) =>
                      update({ language: e.target.value as TemplateDraftInput['language'] })
                    }
                  >
                    <option value="en_US">English (US)</option>
                    <option value="en_GB">English (UK)</option>
                    <option value="en">English</option>
                    <option value="hi">Hindi</option>
                  </select>
                </Field>
                <Field label="Category">
                  <select
                    value={input.category}
                    onChange={(e) =>
                      update({ category: e.target.value as TemplateDraftInput['category'] })
                    }
                  >
                    <option value="MARKETING">Marketing</option>
                    <option value="UTILITY">Utility · booking/report updates</option>
                  </select>
                </Field>
              </div>
              <Field label="Header">
                <select
                  value={input.headerType}
                  onChange={(e) =>
                    update({ headerType: e.target.value as TemplateDraftInput['headerType'] })
                  }
                >
                  <option value="NONE">No header</option>
                  <option value="TEXT">Fixed text</option>
                  <option value="IMAGE">Image</option>
                </select>
              </Field>
              {input.headerType === 'TEXT' && (
                <Field label="Header text">
                  <input
                    maxLength={60}
                    required
                    value={input.headerText}
                    onChange={(e) => update({ headerText: e.target.value })}
                  />
                </Field>
              )}
              {input.headerType === 'IMAGE' && (
                <CampaignBanner
                  key={formKey}
                  path={input.bannerPath}
                  enabled={!readOnly && !busy}
                  onChange={(bannerPath) => update({ bannerPath })}
                  onPreview={setPreview}
                  onBusyChange={setUploading}
                />
              )}
              <Field
                label="Message body"
                hint="Use {{1}}, {{2}} and consecutive numbered variables. Maximum 1,024 characters."
              >
                <textarea
                  required
                  rows={7}
                  maxLength={1024}
                  value={input.body}
                  onChange={(e) => update({ body: e.target.value })}
                />
              </Field>
              {variableError && <Notice error>{variableError}</Notice>}
              {variables.map((v, i) => (
                <Field
                  key={v}
                  label={`Example for {{${v}}}`}
                  hint="Use an illustrative value for Meta review."
                >
                  <input
                    maxLength={160}
                    value={input.examples[i] || ''}
                    onChange={(e) => {
                      const examples = [...input.examples];
                      examples[i] = e.target.value;
                      update({ examples });
                    }}
                  />
                </Field>
              ))}
              <Field label="Footer">
                <input
                  maxLength={60}
                  value={input.footer}
                  onChange={(e) => update({ footer: e.target.value })}
                />
              </Field>
            </fieldset>
            <p className="crm-muted">
              Meta can change the category and decides approval. Submitting a template does not send
              a customer message.
            </p>
            <div className="inline-actions">
              {!readOnly && (
                <>
                  <button type="submit" className="button secondary" disabled={!!busy || uploading}>
                    {busy === 'save' && <LoaderCircle className="spin" size={15} />}Save draft
                  </button>
                  <button
                    type="button"
                    className="button primary"
                    disabled={
                      !!busy || uploading || !data?.connected || !!variableError || !input.name
                    }
                    onClick={() => void act('submit')}
                  >
                    <Send size={15} />
                    Submit to Meta
                  </button>
                </>
              )}
              {editing && (
                <span className="badge muted">
                  {editing.state.replaceAll('_', ' ')}
                  {editing.providerStatus ? ' · ' + editing.providerStatus : ''}
                </span>
              )}
            </div>
            {editing?.lastError && <Notice error>{editing.lastError}</Notice>}
          </form>
        </section>
        <aside className="panel crm-card">
          <h3>Message preview</h3>
          <div className="crm-message-preview">
            <strong>Baunthiyal Path Lab</strong>
            {input.headerType === 'IMAGE' && preview && (
              <img src={preview} alt="Template header preview" />
            )}
            {input.headerType === 'TEXT' && <h4>{input.headerText}</h4>}
            <p>{previewBody}</p>
            <small>{input.footer}</small>
          </div>
          <p className="crm-muted">
            An illustrative preview. Only an approved Meta template can be used for a campaign.
          </p>
          <h3 className="crm-section-title">Saved drafts and submissions</h3>
          {!data ? (
            <p>Loading templates…</p>
          ) : !data.drafts.length ? (
            <p className="crm-muted">Your saved drafts will appear here.</p>
          ) : (
            data.drafts.map((d) => (
              <article className="crm-list-item" key={d.id}>
                <strong>{d.name}</strong>
                <span>
                  {d.language} · {d.state.replaceAll('_', ' ')}
                  {d.providerStatus ? ' · ' + d.providerStatus : ''}
                </span>
                <div className="inline-actions">
                  <button
                    type="button"
                    className="text-button"
                    disabled={!!busy || uploading}
                    onClick={() => choose(d)}
                  >
                    {d.state === 'DRAFT' ? 'Edit draft' : 'View submission'}
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    disabled={!!busy || uploading}
                    onClick={() => duplicate(d)}
                  >
                    <Copy size={13} />
                    Duplicate
                  </button>
                  {d.state === 'DRAFT' && (
                    <button
                      type="button"
                      className="text-button"
                      disabled={!!busy || !data.connected}
                      onClick={() => void act('submit', d)}
                    >
                      Submit to Meta
                    </button>
                  )}
                </div>
              </article>
            ))
          )}
        </aside>
      </div>
      <section className="panel crm-card">
        <div className="crm-heading">
          <div>
            <h3>Templates returned by Meta</h3>
            <p className="crm-muted">
              Last sync:{' '}
              {data?.lastSyncedAt
                ? new Date(data.lastSyncedAt).toLocaleString('en-IN')
                : 'Not refreshed yet'}
            </p>
          </div>
          <div className="crm-template-filters">
            <input
              aria-label="Search Meta templates"
              placeholder="Search name or language"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select
              aria-label="Template approval status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              {[
                'ALL',
                'APPROVED',
                'PENDING',
                'REJECTED',
                'PAUSED',
                'DISABLED',
                'DELETED',
                'UNKNOWN',
              ].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        </div>
        {data?.truncated && (
          <Notice>
            Only part of the template list is loaded. Refine the account in Meta to review the full
            list.
          </Notice>
        )}
        {!templates.length ? (
          <p className="crm-muted">
            No matching Meta templates are cached. Choose Refresh Meta status to fetch your
            account’s real templates.
          </p>
        ) : (
          <div className="crm-template-list">
            {templates.map((t) => (
              <article className="crm-list-item" key={t.id}>
                <div className="crm-heading">
                  <strong>{t.name}</strong>
                  <span className={`badge ${t.status === 'APPROVED' ? 'green' : 'muted'}`}>
                    {t.status}
                  </span>
                </div>
                <span>
                  {t.language} · {t.category} · {t.headerType === 'IMAGE' ? 'Image header' : 'Text'}
                </span>
                <p className="crm-template-body">{t.body}</p>
                {t.status === 'REJECTED' && (
                  <p className="crm-muted">
                    {t.rejectedReason ||
                      'Meta rejected this template. Review its details in WhatsApp Manager.'}
                  </p>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
