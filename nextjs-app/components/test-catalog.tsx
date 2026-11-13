'use client';

import { useMemo, useState } from 'react';
import {
  ArrowRight,
  Check,
  Download,
  FlaskConical,
  IndianRupee,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Tags,
  X,
} from 'lucide-react';
import type { CatalogEntry } from '@/lib/catalog-types';
import { money } from '@/lib/brand';
import { accountApi, Field, Modal, Notice, Submit } from './ui';
import styles from './test-catalog.module.css';

type Props = {
  tests: CatalogEntry[];
  totalTests: number;
  loading: boolean;
  error?: string;
  onRefresh: () => Promise<void>;
  onChanged: () => Promise<void>;
  accountMode: boolean;
  ready: boolean;
  onAdd: () => void;
};

export default function TestCatalog({
  tests,
  totalTests,
  loading,
  error,
  onRefresh,
  onChanged,
  accountMode,
  ready,
  onAdd,
}: Props) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [kind, setKind] = useState('all');
  const [rate, setRate] = useState('all');
  const [importing, setImporting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState('');
  const [localError, setLocalError] = useState('');
  const [editing, setEditing] = useState<CatalogEntry | null>(null);
  const categories = useMemo(
    () => [...new Set(tests.map((test) => test.category || 'General'))].sort(),
    [tests],
  );
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return tests.filter((test) => {
      const matchesQuery = `${test.name} ${test.id} ${(test.aliases || []).join(' ')}`
        .toLowerCase()
        .includes(needle);
      return (
        matchesQuery &&
        (category === 'all' || (test.category || 'General') === category) &&
        (kind === 'all' || test.type === kind) &&
        (rate === 'all' || (rate === 'pending' ? test.price === null : test.price !== null))
      );
    });
  }, [tests, query, category, kind, rate]);
  const priced = tests.filter((test) => test.price !== null).length;
  const pending = tests.length - priced;
  const busy = loading || importing || refreshing;
  const hasFilters = !!query || category !== 'all' || kind !== 'all' || rate !== 'all';
  const summaryValue = (value: number) => (loading && !tests.length ? '…' : value);

  async function refresh() {
    setRefreshing(true);
    setLocalError('');
    try {
      await onRefresh();
    } catch (caught) {
      setLocalError(caught instanceof Error ? caught.message : 'Unable to refresh the catalog.');
    } finally {
      setRefreshing(false);
    }
  }

  async function importReferences() {
    setImporting(true);
    setLocalError('');
    setNotice('');
    try {
      const result = await accountApi<{
        imported: number;
        skipped: number;
        totalReference: number;
        message?: string;
      }>('account/catalog/import-reference', {});
      await onChanged();
      setNotice(
        result.imported > 0
          ? `${result.imported} reference tests added. Existing catalog entries and rates were kept.`
          : result.totalReference > 0 && result.skipped >= result.totalReference
            ? 'The reference tests are already in your catalog. Existing rates were kept.'
            : result.message || 'Reference catalog import completed.',
      );
    } catch (caught) {
      setLocalError(
        caught instanceof Error ? caught.message : 'Unable to add the reference test catalog.',
      );
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className={styles.catalog}>
      <div className={styles.summary}>
        <div className={styles.summaryItem}>
          <span className={styles.summaryIcon}>
            <FlaskConical size={20} />
          </span>
          <div>
            <strong>{summaryValue(totalTests)}</strong>
            <span>Catalog entries</span>
          </div>
        </div>
        <div className={styles.summaryItem}>
          <span className={styles.summaryIcon}>
            <IndianRupee size={20} />
          </span>
          <div>
            <strong>{summaryValue(priced)}</strong>
            <span>Rates added{totalTests > tests.length ? ' · loaded entries' : ''}</span>
          </div>
        </div>
        <div className={styles.summaryItem}>
          <span className={`${styles.summaryIcon} ${styles.pendingIcon}`}>
            <Tags size={20} />
          </span>
          <div>
            <strong>{summaryValue(pending)}</strong>
            <span>Rates pending{totalTests > tests.length ? ' · loaded entries' : ''}</span>
          </div>
        </div>
      </div>

      {error && <Notice error>{error}</Notice>}
      {localError && <Notice error>{localError}</Notice>}
      {notice && <Notice>{notice}</Notice>}

      <section className="panel">
        <div className={`panel-heading ${styles.heading}`}>
          <div>
            <h2>Tests & health packages</h2>
            <p>Keep your test names, categories and actual lab rates together.</p>
          </div>
          <div className={styles.actions}>
            <button
              type="button"
              className="button secondary small-button"
              disabled={busy}
              onClick={() => void refresh()}
            >
              <RefreshCw size={14} className={refreshing || loading ? 'spin' : ''} />
              Refresh
            </button>
            {accountMode && (
              <button
                type="button"
                className="button secondary small-button"
                disabled={busy}
                onClick={() => void importReferences()}
              >
                {importing ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}
                {importing ? 'Adding tests…' : 'Add reference tests'}
              </button>
            )}
            <button type="button" className="button primary small-button" onClick={onAdd}>
              <Plus size={15} />
              Add test or package
            </button>
          </div>
        </div>

        <div className={styles.filters}>
          <label className={styles.search}>
            <Search size={16} />
            <span className="sr-only">Search tests, abbreviations or IDs</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search test, abbreviation or ID…"
              type="search"
            />
          </label>
          <label>
            <span className="sr-only">Category</span>
            <select
              aria-label="Filter by category"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
            >
              <option value="all">All categories</option>
              {categories.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="sr-only">Entry type</span>
            <select
              aria-label="Filter by test or package"
              value={kind}
              onChange={(event) => setKind(event.target.value)}
            >
              <option value="all">Tests & packages</option>
              <option value="test">Lab tests</option>
              <option value="package">Health packages</option>
            </select>
          </label>
          <label>
            <span className="sr-only">Rate status</span>
            <select
              aria-label="Filter by rate status"
              value={rate}
              onChange={(event) => setRate(event.target.value)}
            >
              <option value="all">All rates</option>
              <option value="pending">Rate pending</option>
              <option value="added">Rate added</option>
            </select>
          </label>
        </div>

        <div className={styles.referenceNote}>
          <FlaskConical size={16} />
          <span>
            Reference entries cover common diagnostic tests. Add your lab’s rate to use a test in an
            offer; custom tests and packages can be added at any time.
          </span>
        </div>

        {loading && !tests.length ? (
          <div className={styles.empty} role="status">
            <LoaderCircle size={25} className="spin" />
            <h3>Loading your catalog…</h3>
          </div>
        ) : visible.length ? (
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Test / package</th>
                  <th scope="col">Category</th>
                  <th scope="col">Lab rate</th>
                  <th scope="col">Rate status</th>
                  {accountMode && <th scope="col">Action</th>}
                </tr>
              </thead>
              <tbody>
                {visible.map((test) => (
                  <tr key={test.id}>
                    <td>
                      <strong>{test.name}</strong>
                      <small>
                        {test.id} · {test.type === 'package' ? 'Health package' : 'Lab test'}
                      </small>
                      {!!test.aliases?.length && (
                        <span className={styles.aliases}>{test.aliases.join(' · ')}</span>
                      )}
                    </td>
                    <td>
                      <span className={styles.category}>{test.category || 'General'}</span>
                    </td>
                    <td className={styles.rate}>
                      {test.price === null ? (
                        <span className={styles.pendingRate}>Rate pending</span>
                      ) : (
                        money(test.price)
                      )}
                    </td>
                    <td>
                      <span className={`badge ${test.price === null ? 'muted' : 'green'}`}>
                        {test.price === null ? (
                          'Set lab rate'
                        ) : (
                          <>
                            <Check size={11} />
                            Rate added
                          </>
                        )}
                      </span>
                    </td>
                    {accountMode && (
                      <td>
                        <button
                          type="button"
                          className={`text-button ${styles.editButton}`}
                          onClick={() => {
                            setLocalError('');
                            setNotice('');
                            setEditing(test);
                          }}
                          aria-label={`${test.price === null ? 'Set rate for' : 'Edit'} ${test.name}`}
                        >
                          <Pencil size={13} />
                          {test.price === null ? 'Set rate' : 'Edit details'}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className={styles.empty}>
            <FlaskConical size={29} />
            <h3>
              {hasFilters
                ? 'No matching tests or packages'
                : 'Your catalog is ready for its first entry'}
            </h3>
            <p>
              {hasFilters
                ? 'Try another name, abbreviation, category or rate filter.'
                : 'Add a lab test or package, or bring in the reference test library.'}
            </p>
            {hasFilters ? (
              <button
                type="button"
                className="button secondary small-button"
                onClick={() => {
                  setQuery('');
                  setCategory('all');
                  setKind('all');
                  setRate('all');
                }}
              >
                <X size={14} />
                Clear filters
              </button>
            ) : (
              <button type="button" className="button primary small-button" onClick={onAdd}>
                Add a test or package <ArrowRight size={14} />
              </button>
            )}
          </div>
        )}
        <div className={styles.footer}>
          <span>
            Showing {visible.length} of {tests.length} loaded entries
            {totalTests > tests.length ? ` · ${totalTests} total catalog entries` : ''}.
          </span>
          {ready && !accountMode && <span>Lab catalog</span>}
        </div>
      </section>
      {editing && (
        <EditCatalogEntry
          key={editing.id}
          entry={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            setNotice('Catalog entry saved.');
            await onChanged();
          }}
        />
      )}
    </div>
  );
}

function EditCatalogEntry({
  entry,
  onClose,
  onSaved,
}: {
  entry: CatalogEntry;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(entry.name);
  const [kind, setKind] = useState(entry.type);
  const [category, setCategory] = useState(entry.category || 'General');
  const [aliases, setAliases] = useState((entry.aliases || []).join(', '));
  const [rate, setRate] = useState(entry.price === null ? '' : String(entry.price / 100));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal
      title={entry.price === null ? 'Set your lab rate' : 'Edit catalog entry'}
      description={entry.name}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setError('');
          setBusy(true);
          try {
            const price = rate.trim() ? Math.round(Number(rate) * 100) : null;
            if (price !== null && (!Number.isSafeInteger(price) || price < 0 || price > 100000000))
              throw new Error('Enter a valid lab rate between ₹0 and ₹10,00,000.');
            const alternateNames = [
              ...new Set(
                aliases
                  .split(',')
                  .map((value) => value.trim())
                  .filter(Boolean),
              ),
            ];
            if (alternateNames.length > 8)
              throw new Error('Use up to 8 abbreviations or alternate names.');
            if (alternateNames.some((value) => value.length > 100))
              throw new Error('Keep each abbreviation or alternate name within 100 characters.');
            await accountApi('account/catalog', {
              id: entry.id,
              name: name.trim(),
              type: kind,
              price,
              category: category.trim(),
              aliases: alternateNames,
            });
            await onSaved();
          } catch (caught) {
            setError(
              caught instanceof Error ? caught.message : 'Unable to save this catalog entry.',
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="modal-body">
          {error && <Notice error>{error}</Notice>}
          <Field label="Test or package name">
            <input
              required
              minLength={2}
              maxLength={180}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <div className="form-grid">
            <Field label="Type">
              <select
                value={kind}
                onChange={(event) => setKind(event.target.value as CatalogEntry['type'])}
              >
                <option value="test">Lab test</option>
                <option value="package">Health package</option>
              </select>
            </Field>
            <Field
              label="Lab rate (₹)"
              hint="Leave blank to mark the rate as pending. Use a positive rate for offers."
            >
              <input
                type="number"
                inputMode="decimal"
                min="0"
                max="1000000"
                step="0.01"
                placeholder="Enter your actual lab rate"
                value={rate}
                onChange={(event) => setRate(event.target.value)}
              />
            </Field>
          </div>
          <Field label="Category">
            <input
              required
              minLength={1}
              maxLength={80}
              value={category}
              onChange={(event) => setCategory(event.target.value)}
            />
          </Field>
          <Field label="Abbreviations / alternate names" hint="Separate up to 8 names with commas.">
            <input
              value={aliases}
              onChange={(event) => setAliases(event.target.value)}
              placeholder="e.g. CBC, Complete blood count"
            />
          </Field>
        </div>
        <div className="modal-footer">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <Submit busy={busy}>Save changes</Submit>
        </div>
      </form>
    </Modal>
  );
}
