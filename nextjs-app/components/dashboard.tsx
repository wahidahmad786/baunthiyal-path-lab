'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  BarChart3,
  Bell,
  BookOpen,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Copy,
  FlaskConical,
  HelpCircle,
  LayoutDashboard,
  Link2,
  LoaderCircle,
  LogIn,
  LogOut,
  MailCheck,
  Menu,
  MessageCircle,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Tag,
  Target,
  TrendingUp,
  Users,
  Wallet,
  X,
  XCircle,
} from 'lucide-react';
import { BRAND, money } from '@/lib/brand';
import { onIdTokenChanged, signOut } from 'firebase/auth';
import { labClientAuth, clientAuthConfigured, previewOnly } from '@/lib/client-auth';
import { LegalLinks } from './legal-links';
import { hasLabAdminAccess } from '@/lib/access';
import type { FirebaseSetupSnapshot } from '@/lib/setup-types';
import WhatsAppConnectionOptions from './whatsapp-connection-options';
import PublicHome from './public-home';
import TestCatalog from './test-catalog';
import WhatsAppInbox from './whatsapp-inbox';
import LinkedCampaignForm from './linked-campaign-form';
import TemplateManager from './template-manager';
import { FileText } from 'lucide-react';
import TeamSettings from './team-settings';
import ConnectionAlerts from './connection-alerts';
import type { CatalogEntry } from '@/lib/catalog-types';
import { Campaign, Customer, Offer, Booking, calculateROI } from '@/lib/domain';
import { api, accountApi, Modal, Notice, Field, Submit, dateLabel } from './ui';
import {
  CampaignForm,
  OfferForm,
  CustomerForm,
  CatalogForm,
  BookingJobForm,
  PaymentForm,
} from './forms';
export type TestRecord = CatalogEntry;
export type State = {
  campaigns: Campaign[];
  customers: Customer[];
  offers: Offer[];
  bookings: Booking[];
  tests: TestRecord[];
  totalCustomers: number;
  optedIn: number;
  limits?: Record<string, number>;
};
export type Configuration = {
  cloudSetup?: FirebaseSetupSnapshot;
  projectNumber?: string;
  firebase: boolean;
  whatsapp: boolean;
  rate: number | null;
  labPhone: string;
  publicForms: boolean;
  cron: boolean;
  clientAuth: boolean;
  accountCustomers?: boolean;
  accountWhatsApp?: boolean;
  accountCatalog?: boolean;
  accountInbox?: boolean;
};
const empty: State = {
  campaigns: [],
  customers: [],
  offers: [],
  bookings: [],
  tests: [],
  totalCustomers: 0,
  optedIn: 0,
};
const nav = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'campaigns', label: 'All campaigns', icon: Send },
  { id: 'catalog', label: 'Tests & packages', icon: FlaskConical },
  { id: 'offers', label: 'Offers & packages', icon: Tag },
  { id: 'audience', label: 'Customer audience', icon: Users },
  { id: 'inbox', label: 'WhatsApp Inbox', icon: MessageCircle },
  { id: 'templates', label: 'Template Manager', icon: FileText },
  { id: 'team', label: 'Team & quick replies', icon: Users },
  { id: 'bookings', label: 'Booking requests', icon: CalendarDays },
  { id: 'analytics', label: 'Campaign analytics', icon: BarChart3 },
];
const titles: Record<string, string> = {
  overview: 'Marketing & campaigns',
  campaigns: 'All campaigns',
  offers: 'Offers & packages',
  audience: 'Customer audience',
  bookings: 'Booking requests',
  analytics: 'Campaign analytics',
  whatsapp: 'WhatsApp Integration',
  catalog: 'Tests & packages',
  inbox: 'WhatsApp Inbox',
  templates: 'Template Manager',
  team: 'Team & quick replies',
};
export default function Dashboard() {
  const [section, setSection] = useState('overview');
  const [serverData, setData] = useState<State>(empty);
  const [config, setConfig] = useState<Configuration | null>(null);
  const [ready, setReady] = useState(false);
  const [previewIdentity, setPreviewIdentity] = useState<{
    uid: string;
    name: string;
    email: string;
    admin: boolean;
  } | null>(null);
  const [accountCustomers, setAccountCustomers] = useState<{
    uid: string;
    customers: Customer[];
    totalCustomers: number;
    optedIn: number;
    truncated: boolean;
  } | null>(null);
  const [customerLoading, setCustomerLoading] = useState(false);
  const [accountCatalog, setAccountCatalog] = useState<{
    uid: string;
    tests: TestRecord[];
    offers: Offer[];
    totalTests: number;
    pricedTests: number;
  } | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const catalogRequest = useRef(0);
  const accountCatalogMode = !ready && !!config?.accountCatalog && !!previewIdentity;
  const ownCatalog = accountCatalog?.uid === previewIdentity?.uid ? accountCatalog : null;
  const [customerError, setCustomerError] = useState('');
  const customerRequest = useRef(0);
  const accountMode = !ready && !!config?.accountCustomers && !!previewIdentity;
  const ownCustomers = accountCustomers?.uid === previewIdentity?.uid ? accountCustomers : null;
  const data: State = ready
    ? serverData
    : {
        ...empty,
        customers: ownCustomers?.customers || [],
        totalCustomers: ownCustomers?.totalCustomers || 0,
        optedIn: ownCustomers?.optedIn || 0,
        tests: ownCatalog?.tests || [],
        offers: ownCatalog?.offers || [],
      };
  const customerReady = ready || accountMode;
  const catalogReady = ready || accountCatalogMode;
  const customerDataReady = ready || !!ownCustomers;
  const [loading, setLoading] = useState(true);
  const [authChecked, setAuthChecked] = useState(false);
  const [whatsappVerified, setWhatsappVerified] = useState(false);
  const [whatsappProvider, setWhatsappProvider] = useState<'meta' | 'personal' | null>(null);
  useEffect(() => {
    setWhatsappProvider(null);
    if (!previewIdentity) return;
    let active = true;
    void accountApi<{ mode: 'meta' | 'personal' | null }>('whatsapp/provider')
      .then((r) => {
        if (active) setWhatsappProvider(r.mode);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [previewIdentity?.uid]);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [mobile, setMobile] = useState(false);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [modal, setModal] = useState<string | null>(null);
  const [selected, setSelected] = useState<Campaign | null>(null);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [inboxWorkspaceId, setInboxWorkspaceId] = useState('');
  const [booking, setBooking] = useState<Booking | null>(null);
  const [messages, setMessages] = useState<Record<string, unknown>[]>([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const c = await api<Configuration>('configuration');
      setConfig(c);
      if (c.firebase) {
        try {
          const s = await api<State>('state');
          setData(s);
          setReady(true);
          setError('');
        } catch (e) {
          setReady(false);
          // Signed-out and personal onboarding accounts do not request lab records.
          setError('');
        }
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!clientAuthConfigured) {
      setAuthChecked(true);
      return;
    }
    let current = 0;
    const auth = labClientAuth();
    const unsubscribe = onIdTokenChanged(auth, async (user) => {
      const request = ++current;
      if (!user) {
        setPreviewIdentity(null);
        setAuthChecked(true);
        return;
      }
      try {
        const token = await user.getIdTokenResult();
        if (request !== current) return;
        setPreviewIdentity({
          uid: user.uid,
          name: user.displayName || 'Your account',
          email: user.email || '',
          admin: hasLabAdminAccess(token.claims),
        });
        setAuthChecked(true);
      } catch {
        if (request === current) {
          setPreviewIdentity(null);
          setAuthChecked(true);
        }
      }
    });
    return () => {
      current++;
      unsubscribe();
    };
  }, []);
  const loadCustomers = useCallback(async () => {
    const uid = previewIdentity?.uid;
    if (!accountMode || !uid) return;
    const request = ++customerRequest.current;
    setCustomerLoading(true);
    setCustomerError('');
    try {
      const result = await accountApi<{
        customers: Customer[];
        totalCustomers: number;
        optedIn: number;
        truncated: boolean;
      }>('account/customers');
      if (request === customerRequest.current) setAccountCustomers({ ...result, uid });
    } catch (e) {
      if (request === customerRequest.current)
        setCustomerError(e instanceof Error ? e.message : 'Unable to load customers.');
    } finally {
      if (request === customerRequest.current) setCustomerLoading(false);
    }
  }, [accountMode, previewIdentity?.uid]);
  useEffect(() => {
    setAccountCustomers(null);
    setModal(null);
    setCustomerError('');
    if (accountMode) void loadCustomers();
    return () => {
      customerRequest.current++;
    };
  }, [accountMode, loadCustomers]);
  const loadCatalog = useCallback(async () => {
    const uid = previewIdentity?.uid;
    if (!accountCatalogMode || !uid) return;
    const request = ++catalogRequest.current;
    setCatalogLoading(true);
    setCatalogError('');
    try {
      type Result = {
        tests: TestRecord[];
        offers: Offer[];
        totalTests: number;
        pricedTests: number;
      };
      let result = await accountApi<Result>('account/catalog');
      if (result.totalTests === 0) {
        if (request !== catalogRequest.current || labClientAuth().currentUser?.uid !== uid) return;
        await accountApi('account/catalog/import-reference', {});
        if (request !== catalogRequest.current || labClientAuth().currentUser?.uid !== uid) return;
        result = await accountApi<Result>('account/catalog');
      }
      if (request === catalogRequest.current) setAccountCatalog({ ...result, uid });
    } catch (e) {
      if (request === catalogRequest.current)
        setCatalogError(e instanceof Error ? e.message : 'Unable to load your test catalog.');
    } finally {
      if (request === catalogRequest.current) setCatalogLoading(false);
    }
  }, [accountCatalogMode, previewIdentity?.uid]);
  useEffect(() => {
    setAccountCatalog(null);
    setCatalogError('');
    setSelectedChatId(null);
    if (accountCatalogMode) void loadCatalog();
    return () => {
      catalogRequest.current++;
    };
  }, [accountCatalogMode, loadCatalog]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(''), 6000);
    return () => clearTimeout(id);
  }, [toast]);
  useEffect(() => {
    if (!ready) return;
    const id = setInterval(() => {
      void api<State>('state')
        .then(setData)
        .catch(() => {});
    }, 30000);
    return () => clearInterval(id);
  }, [ready]);
  const notify = (s: string) => setToast(s);
  const done = async (message = 'Saved successfully') => {
    const savedModal = modal;
    setModal(null);
    if (accountCatalogMode && (savedModal === 'offer' || savedModal === 'catalog'))
      await loadCatalog();
    else if (accountMode) await loadCustomers();
    else await load();
    notify(message);
  };
  async function action(c: Campaign, type: string) {
    setBusy(true);
    try {
      const result = await api<{ count?: number }>(`campaigns/${c.id}/${type}`, {});
      notify(
        type === 'launch'
          ? 'Campaign scheduled. The configured worker will send eligible messages.'
          : type === 'retry'
            ? `${result.count || 0} transient failures requeued. Resume when ready.`
            : type === 'pause'
              ? 'Campaign paused. Messages already submitted to Meta may still deliver.'
              : 'Campaign resumed',
      );
      await load();
      setSelected(null);
      setModal(null);
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }
  function navigate(id: string) {
    setSection(id);
    setQuery('');
    setStatus('all');
    setMobile(false);
  }
  const total = data.campaigns.reduce(
    (v, c) => ({
      sent: v.sent + c.sent,
      delivered: v.delivered + c.delivered,
      read: v.read + c.read,
      failed: v.failed + c.failed,
      revenue: v.revenue + c.revenue,
      spend: v.spend + c.spend,
      responses: v.responses + c.responses,
      bookings: v.bookings + c.bookings,
      confirmed: v.confirmed + c.confirmed,
    }),
    {
      sent: 0,
      delivered: 0,
      read: 0,
      failed: 0,
      revenue: 0,
      spend: 0,
      responses: 0,
      bookings: 0,
      confirmed: 0,
    },
  );
  const active = data.campaigns.filter((c) =>
    ['running', 'scheduled', 'preparing'].includes(c.status),
  ).length;
  const requests = data.bookings.filter((b) => b.status === 'requested').length;
  const display = (n: number | string) => (ready ? n : '—');
  const displayCustomers = (n: number) => (customerDataReady ? n : customerLoading ? '…' : '—');
  const campaigns = data.campaigns.filter(
    (c) =>
      (status === 'all' || c.status === status) &&
      `${c.name} ${c.id}`.toLowerCase().includes(query.toLowerCase()),
  );
  function openCampaign(c?: Campaign) {
    setSelected(c || null);
    setModal('campaign');
  }
  const consentCustomer = modal?.startsWith('consent:')
    ? data.customers.find((c) => c.id === modal.split(':')[1])
    : undefined;
  if (!authChecked || loading)
    return (
      <div className="workspace-loading" role="status">
        <img src="/logo.svg" width={48} height={48} alt="Baunthiyal Path Lab" />
        <span>Opening your workspace…</span>
      </div>
    );
  if (!ready && !previewIdentity) return <PublicHome />;
  return (
    <div className="app-shell">
      <aside
        className={`sidebar ${mobile ? 'open' : ''}`}
        aria-label="Workspace sidebar"
        tabIndex={0}
      >
        <Link href="/" className="brand">
          <img src="/logo.svg" alt="Baunthiyal Path Lab logo" width="45" height="45" />
          <span>
            <strong>
              Baunthiyal<span>Path Lab</span>
            </strong>
            <small>{BRAND.tagline}</small>
          </span>
        </Link>
        <div className="workspace-tag">
          <span className="tiny-cross">+</span> LAB MANAGEMENT <span className="version">v1.0</span>
        </div>
        <div className="side-label">WORKSPACE</div>
        <button className="side-item dashboard-link" onClick={() => navigate('overview')}>
          <Activity size={18} />
          Admin dashboard
          <ChevronRight size={14} />
        </button>
        <div className="side-label section-label">MARKETING & CAMPAIGNS</div>
        <nav aria-label="Marketing & Campaigns">
          {nav
            .filter((n) => whatsappProvider !== 'personal' || n.id !== 'templates')
            .map((n) => (
              <button
                key={n.id}
                className={`side-item ${section === n.id ? 'active' : ''}`}
                onClick={() => navigate(n.id)}
              >
                <n.icon size={18} />
                {n.label}
                {n.id === 'bookings' && requests > 0 ? (
                  <span className="count">{requests}</span>
                ) : null}
              </button>
            ))}
        </nav>
        <div className="side-label section-label">MANAGE</div>
        <button
          className={`side-item ${section === 'whatsapp' ? 'active' : ''}`}
          onClick={() => navigate('whatsapp')}
        >
          <Settings2 size={18} />
          WhatsApp Integration
        </button>
        {process.env.NEXT_PUBLIC_EXISTING_PORTAL_URL && (
          <a className="side-item" href={process.env.NEXT_PUBLIC_EXISTING_PORTAL_URL}>
            <ClipboardList size={18} />
            Open lab operations
            <ArrowRight size={14} />
          </a>
        )}
        <div className="sidebar-bottom">
          <LegalLinks />
          <div className="consent-card">
            <div className="consent-icon">
              <ShieldCheck size={20} />
            </div>
            <strong>Care begins with consent</strong>
            <p>Reach the right people, with their permission. Every time.</p>
            <button onClick={() => navigate('audience')}>
              Manage preferences <ArrowRight size={14} />
            </button>
          </div>
          <div className="side-user">
            <div className="avatar">{ready || previewIdentity ? 'AD' : 'BL'}</div>
            <span>
              <strong title={previewIdentity?.email}>
                {ready
                  ? 'Administrator'
                  : previewIdentity
                    ? previewIdentity.name
                    : 'Baunthiyal Path Lab'}
              </strong>
              <small>
                {ready
                  ? 'Marketing workspace'
                  : previewIdentity
                    ? 'Your workspace'
                    : 'Secure workspace'}
              </small>
            </span>
            {ready || previewIdentity ? (
              <button
                className="icon-button"
                title="Sign out"
                onClick={async () => {
                  if (!previewOnly) await api('logout', {});
                  await signOut(labClientAuth());
                  window.location.assign('/login');
                }}
              >
                <LogOut size={17} />
              </button>
            ) : (
              <Link href="/login" className="icon-button" title="Sign in">
                <LogIn size={18} />
              </Link>
            )}
          </div>
        </div>
      </aside>
      {mobile && (
        <button
          className="sidebar-overlay"
          aria-label="Close navigation"
          onClick={() => setMobile(false)}
        />
      )}
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              onClick={() => setMobile(true)}
              aria-label="Open navigation"
            >
              <Menu size={20} />
            </button>
            <span>Workspace</span>
            <ChevronRight size={13} />
            <strong>Marketing & campaigns</strong>
          </div>
          <div className="topbar-actions">
            <span
              className={`integration-dot ${(ready && config?.whatsapp) || whatsappVerified ? 'connected' : ''}`}
            />
            <span className="top-status">
              {ready && config?.whatsapp
                ? 'WhatsApp API configured'
                : whatsappVerified
                  ? 'API credentials checked'
                  : 'WhatsApp Business'}
            </span>
            <div className="top-divider" />
            {previewIdentity ? (
              <ConnectionAlerts
                key={previewIdentity.uid}
                bookings={requests}
                onOpenBookings={() => navigate('bookings')}
                onOpenIntegration={() => navigate('whatsapp')}
                onHealthy={setWhatsappVerified}
              />
            ) : (
              <button
                className="icon-button notification-button"
                aria-label={`${requests} pending booking requests`}
                onClick={() => navigate('bookings')}
              >
                <Bell size={19} />
                {requests > 0 && <i />}
              </button>
            )}
            <div className="avatar small">BL</div>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                <span /> BAUNTHIYAL PATH LAB
              </div>
              <h1>{titles[section]}</h1>
              <p>
                {section === 'overview'
                  ? 'Meaningful connections. Healthier communities.'
                  : section === 'campaigns'
                    ? 'Create, manage, and measure every patient outreach campaign.'
                    : section === 'catalog'
                      ? 'Your tests, packages and current laboratory rates.'
                      : section === 'inbox'
                        ? 'Customer conversations and recorded WhatsApp message statuses.'
                        : section === 'audience'
                          ? 'Your customers. Their choices. A trusted connection.'
                          : section === 'offers'
                            ? 'Make preventive care more accessible with thoughtful offers.'
                            : section === 'bookings'
                              ? 'Turn a conversation into a step toward better health.'
                              : section === 'analytics'
                                ? 'Understand the impact of every conversation.'
                                : section === 'templates'
                                  ? 'Create templates and follow their approval status in Meta.'
                                  : section === 'team'
                                    ? 'Share your inbox with authorized staff and prepare quick replies.'
                                    : 'Manage your WhatsApp Business connection in one place.'}
              </p>
            </div>
            {!['whatsapp', 'inbox', 'catalog', 'templates', 'team'].includes(section) && (
              <div className="heading-actions">
                <button
                  className="button secondary"
                  onClick={() => {
                    setModal('export');
                  }}
                >
                  <ArrowDownToLine size={16} />
                  <span>Export report</span>
                </button>
                <button className="button primary" onClick={() => openCampaign()}>
                  <Plus size={18} />
                  New campaign
                </button>
              </div>
            )}
          </div>
          {error && (
            <Notice error>
              {error} {!ready && config?.firebase && <Link href="/login">Sign in →</Link>}
            </Notice>
          )}
          {section === 'overview' && (
            <>
              <section className="hero-card">
                <div className="hero-content">
                  <div className="hero-kicker">
                    <Sparkles size={14} /> A LITTLE OUTREACH. A LASTING IMPACT.
                  </div>
                  <h2>
                    Better health starts
                    <br />
                    with a conversation.
                  </h2>
                  <p>
                    Bring your community closer to preventive care.
                    <br />
                    Create offers that matter, and reach customers who want to hear from you.
                  </p>
                  <button onClick={() => openCampaign()} className="button hero-button">
                    Create your next campaign <ArrowRight size={17} />
                  </button>
                  <span className="hero-footnote">
                    <ShieldCheck size={13} /> Consent-first messaging, always.
                  </span>
                </div>
                <div className="hero-visual" aria-hidden="true">
                  <div className="orbit orbit-one" />
                  <div className="orbit orbit-two" />
                  <div className="decor-plus p1">+</div>
                  <div className="decor-plus p2">+</div>
                  <div className="message-illustration">
                    <div className="illustration-head">
                      <div className="illustration-logo">
                        <img src="/logo.svg" alt="" width="33" height="33" />
                      </div>
                      <div>
                        <strong>Baunthiyal Path Lab</strong>
                        <span>Your Health, Our Priority</span>
                      </div>
                      <MessageCircle size={18} />
                    </div>
                    <div className="illustration-body">
                      <div className="illustration-tag">YOUR NEXT HEALTH CAMPAIGN</div>
                      <strong>
                        A healthier tomorrow,
                        <br />
                        starts with you.
                      </strong>
                      <div className="health-line">
                        <Activity size={46} />
                        <span>
                          Thoughtful offers.
                          <br />
                          Personal connections.
                        </span>
                      </div>
                      <div className="illustration-cta">
                        Explore health packages <ArrowRight size={13} />
                      </div>
                      <div className="illustration-time">
                        An example of care in every message <CheckCheck size={13} />
                      </div>
                    </div>
                  </div>
                  <div className="floating-pill">
                    <span>
                      <Check size={13} />
                    </span>{' '}
                    Permission. Connection. Care.
                  </div>
                </div>
              </section>
              <div className="section-heading">
                <h2>Your outreach at a glance</h2>
                <span>
                  <span className="live-dot" />
                  {ready ? 'Live records · all time' : 'Your workspace at a glance'}
                </span>
              </div>
              <div className="stats-grid">
                <Metric
                  icon={Users}
                  label="Total customers"
                  value={displayCustomers(data.totalCustomers)}
                  sub="Your growing community"
                />
                <Metric
                  icon={ShieldCheck}
                  label="Marketing opted in"
                  value={displayCustomers(data.optedIn)}
                  sub={
                    customerDataReady && data.totalCustomers
                      ? `${Math.round((data.optedIn / data.totalCustomers) * 100)}% of all customers`
                      : 'Permission to connect'
                  }
                  accent
                />
                <Metric
                  icon={Send}
                  label="Active campaigns"
                  value={display(active)}
                  sub="Running & scheduled"
                />
                <Metric
                  icon={Wallet}
                  label="Campaign revenue"
                  value={display(money(total.revenue))}
                  sub="From recorded payments"
                />
              </div>
              <div className="delivery-strip">
                <MiniMetric icon={Send} title="Messages sent" value={display(total.sent)} />
                <MiniMetric icon={CheckCheck} title="Delivered" value={display(total.delivered)} />
                <MiniMetric icon={MailCheck} title="Read" value={display(total.read)} />
                <MiniMetric icon={XCircle} title="Failed" value={display(total.failed)} />
                <MiniMetric
                  icon={Target}
                  title="Conversion rate"
                  value={display(
                    total.delivered
                      ? `${((total.confirmed / total.delivered) * 100).toFixed(1)}%`
                      : '0%',
                  )}
                />
              </div>
              <div className="overview-lower">
                <div className="panel performance-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Campaign performance</h2>
                      <p>From delivered messages to confirmed bookings</p>
                    </div>
                    <button className="text-button" onClick={() => navigate('analytics')}>
                      View analytics <ArrowRight size={14} />
                    </button>
                  </div>
                  <div className="chart-legend">
                    <span>
                      <i className="teal" />
                      Delivered
                    </span>
                    <span>
                      <i className="blue" />
                      Booking requests
                    </span>
                    <span>
                      <i className="light" />
                      Confirmed
                    </span>
                  </div>
                  <PerformanceChart campaigns={data.campaigns} />
                </div>
                <div className="panel quick-panel">
                  <div className="panel-heading">
                    <h2>A healthy start</h2>
                    <span className="badge muted">QUICK ACCESS</span>
                  </div>
                  <QuickAction
                    icon={Tag}
                    title="Create a special offer"
                    description="A little care, a better value."
                    onClick={() => setModal('offer')}
                  />
                  <QuickAction
                    icon={Users}
                    title="Grow your audience"
                    description="Add customers with their consent."
                    onClick={() => setModal('customer')}
                  />
                  <QuickAction
                    icon={CalendarDays}
                    title="Review booking requests"
                    description={
                      requests
                        ? `${requests} requests need your attention.`
                        : 'Your next patient visit starts here.'
                    }
                    onClick={() => navigate('bookings')}
                  />
                  <div className="quick-tip">
                    <Sparkles size={17} />
                    <p>
                      <strong>A thoughtful reminder</strong>Clear offers and a personal greeting
                      help build lasting trust.
                    </p>
                  </div>
                </div>
              </div>
              <div className="panel campaigns-panel">
                <div className="panel-heading">
                  <div className="inline-heading">
                    <h2>Recent campaigns</h2>
                    <span className="number-badge">{data.campaigns.length}</span>
                  </div>
                  <button className="text-button" onClick={() => navigate('campaigns')}>
                    View all campaigns <ArrowRight size={14} />
                  </button>
                </div>
                <CampaignTable
                  campaigns={data.campaigns.slice(0, 5)}
                  ready={ready}
                  onOpen={(c) => {
                    setSelected(c);
                    setModal('detail');
                  }}
                  onCreate={() => openCampaign()}
                />
              </div>
            </>
          )}
          {section === 'campaigns' && (
            <>
              <div className="compact-stats">
                <span>
                  <strong>{display(data.campaigns.length)}</strong> Total campaigns
                </span>
                <span>
                  <strong>{display(active)}</strong> Active
                </span>
                <span>
                  <strong>
                    {display(data.campaigns.filter((c) => c.status === 'draft').length)}
                  </strong>{' '}
                  Drafts
                </span>
                <span>
                  <strong>{display(total.delivered)}</strong> Messages delivered
                </span>
              </div>
              <div className="panel">
                <div className="table-toolbar">
                  <div className="tabs">
                    {['all', 'draft', 'scheduled', 'running', 'paused', 'completed'].map((s) => (
                      <button
                        key={s}
                        onClick={() => setStatus(s)}
                        className={status === s ? 'selected' : ''}
                      >
                        {s === 'all' ? 'All campaigns' : s}
                      </button>
                    ))}
                  </div>
                  <SearchInput value={query} onChange={setQuery} placeholder="Search campaigns…" />
                </div>
                <CampaignTable
                  campaigns={campaigns}
                  ready={ready}
                  onOpen={(c) => {
                    setSelected(c);
                    setModal('detail');
                  }}
                  onCreate={() => openCampaign()}
                />
                <div className="table-footer">
                  Showing {campaigns.length} of up to 100 recent campaigns
                  <button className="text-button" onClick={() => void load()}>
                    <RefreshCw size={13} />
                    Refresh
                  </button>
                </div>
              </div>
            </>
          )}
          {section === 'offers' && (
            <>
              {catalogError && <Notice error>{catalogError}</Notice>}
              <div className="section-toolbar">
                <div className="tabs">
                  <button className="selected">All offers ({data.offers.length})</button>
                </div>
                <div className="inline-actions">
                  <button className="button secondary" onClick={() => setModal('catalog')}>
                    <FlaskConical size={16} />
                    Add test / package
                  </button>
                  <button className="button primary" onClick={() => setModal('offer')}>
                    <Plus size={16} />
                    Create offer
                  </button>
                </div>
              </div>
              {data.offers.length ? (
                <div className="offer-grid">
                  {data.offers.map((o) => (
                    <article className="panel offer-card" key={o.id}>
                      <div className="offer-card-top">
                        <div className="offer-icon">
                          <Tag size={22} />
                        </div>
                        <span
                          className={`badge ${Date.parse(o.expiresAt) > Date.now() ? 'green' : 'muted'}`}
                        >
                          {Date.parse(o.expiresAt) > Date.now() ? 'Available' : 'Expired'}
                        </span>
                      </div>
                      <small>
                        {o.id} · {o.type}
                      </small>
                      <h2>{o.title}</h2>
                      <p>{o.description}</p>
                      <div className="offer-prices">
                        <strong>{money(o.offerPrice)}</strong>
                        <s>{money(o.originalPrice)}</s>
                        <span>
                          {o.discountType === 'percentage'
                            ? `${o.discountValue}% off`
                            : `${money(o.discountValue)} off`}
                        </span>
                      </div>
                      <div className="offer-valid">
                        <CalendarDays size={14} /> {dateLabel(o.startsAt)} –{' '}
                        {dateLabel(o.expiresAt)}
                      </div>
                      <button className="button secondary" onClick={() => openCampaign()}>
                        Create campaign with an offer <ArrowRight size={15} />
                      </button>
                    </article>
                  ))}
                </div>
              ) : (
                <Empty
                  icon={Tag}
                  title="Make wellness a little more accessible"
                  description="Create your first offer, choose the tests, and let the discount take care of itself."
                  action="Create an offer"
                  onAction={() => setModal('offer')}
                />
              )}
            </>
          )}
          {section === 'audience' && (
            <>
              {customerError && (
                <Notice error>
                  {customerError}{' '}
                  <button className="text-button" onClick={() => void loadCustomers()}>
                    Retry loading customers
                  </button>
                </Notice>
              )}
              <div className="stats-grid audience-stats">
                <Metric
                  icon={Users}
                  label="Total customers"
                  value={displayCustomers(data.totalCustomers)}
                  sub="Registered in the connected database"
                />
                <Metric
                  icon={ShieldCheck}
                  label="Marketing opted in"
                  value={displayCustomers(data.optedIn)}
                  sub="Eligible for promotional messages"
                  accent
                />
                <Metric
                  icon={MessageCircle}
                  label="Consent is separate"
                  value="Always"
                  sub="Booking and report alerts stay independent"
                />
              </div>
              <div className="panel">
                <div className="table-toolbar">
                  <SearchInput
                    value={query}
                    onChange={setQuery}
                    placeholder="Search name or phone…"
                  />
                  {accountMode && (
                    <button
                      className="button secondary"
                      disabled={customerLoading}
                      onClick={() => void loadCustomers()}
                    >
                      <RefreshCw size={15} className={customerLoading ? 'spin' : ''} />
                      Refresh
                    </button>
                  )}
                  <button className="button primary" onClick={() => setModal('customer')}>
                    <Plus size={16} />
                    Add customer
                  </button>
                </div>
                {customerLoading && !customerDataReady ? (
                  <div className="integration-loading" role="status">
                    <LoaderCircle className="spin" size={18} />
                    Loading your customers…
                  </div>
                ) : data.customers.length ? (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Customer</th>
                          <th>Phone</th>
                          <th>Marketing preference</th>
                          <th>Consent source / date</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.customers
                          .filter((c) =>
                            `${c.name} ${c.phone}`.toLowerCase().includes(query.toLowerCase()),
                          )
                          .map((c) => (
                            <tr key={c.id}>
                              <td>
                                <button
                                  type="button"
                                  className="text-button customer-chat-link"
                                  onClick={() => {
                                    setSelectedChatId(c.id);
                                    setInboxWorkspaceId('');
                                    navigate('inbox');
                                  }}
                                >
                                  <MessageCircle size={14} />
                                  {c.name}
                                </button>
                                <small>{c.visits || 0} visits</small>
                              </td>
                              <td>
                                <a
                                  className="whatsapp-contact-link"
                                  href={`https://wa.me/${c.phone.replace(/\D/g, '')}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  +{c.phone}
                                </a>
                              </td>
                              <td>
                                <span
                                  className={`badge ${c.marketing.status === 'opted_in' ? 'green' : 'muted'}`}
                                >
                                  {c.marketing.status.replaceAll('_', ' ')}
                                </span>
                              </td>
                              <td>
                                {c.marketing.source}
                                <small>{dateLabel(c.marketing.at)}</small>
                              </td>
                              <td>
                                <button
                                  type="button"
                                  className="text-button"
                                  onClick={() => {
                                    setSelectedChatId(c.id);
                                    setInboxWorkspaceId('');
                                    navigate('inbox');
                                  }}
                                >
                                  <MessageCircle size={14} />
                                  Open chat
                                </button>
                                <button
                                  className="text-button"
                                  onClick={() => {
                                    setModal(`consent:${c.id}`);
                                  }}
                                >
                                  Update preference
                                </button>
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty
                    icon={Users}
                    title="Good relationships start with permission"
                    description="Add a customer and record their marketing preference. Consent is optional and never preselected."
                    action="Add your first customer"
                    onAction={() => setModal('customer')}
                  />
                )}
                <div className="table-footer">
                  Up to 1,000 most recently registered customers. Totals include all records.
                  <ShieldCheck size={14} />
                </div>
              </div>
            </>
          )}
          {section === 'bookings' && (
            <div className="panel">
              <div className="panel-heading">
                <h2>Campaign booking requests</h2>
                <span className="badge green">{requests} awaiting review</span>
              </div>
              {data.bookings.length ? (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Customer</th>
                        <th>Source campaign</th>
                        <th>Requested on</th>
                        <th>Status</th>
                        <th>Next step</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.bookings.map((b) => (
                        <tr key={b.id}>
                          <td>
                            <strong>{b.name}</strong>
                            <small>+{b.phone}</small>
                          </td>
                          <td>
                            {data.campaigns.find((c) => c.id === b.campaignId)?.name ||
                              b.campaignId}
                            <small>{b.offerId}</small>
                          </td>
                          <td>{dateLabel(b.createdAt)}</td>
                          <td>
                            <span
                              className={`badge ${b.status === 'confirmed' ? 'green' : 'amber'}`}
                            >
                              {b.status}
                            </span>
                          </td>
                          <td>
                            {b.jobId ? (
                              <div className="inline-actions">
                                <a
                                  className="text-button"
                                  href={`/api/jobs/${b.jobId}/receipt`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  Receipt <ArrowDownToLine size={13} />
                                </a>
                                <button
                                  className="text-button"
                                  onClick={() => {
                                    setBooking(b);
                                    setModal('payment');
                                  }}
                                >
                                  Record payment
                                </button>
                              </div>
                            ) : (
                              <button
                                className="button secondary small-button"
                                onClick={() => {
                                  setBooking(b);
                                  setModal('job');
                                }}
                              >
                                Create job card <ArrowRight size={14} />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty
                  icon={CalendarDays}
                  title="The next step toward better health"
                  description="Booking requests from campaign links will appear here. Confirm a customer to create a job card with the eligible discount."
                />
              )}
            </div>
          )}
          {section === 'analytics' && (
            <>
              <div className="stats-grid">
                <Metric
                  icon={Wallet}
                  label="Estimated campaign spend"
                  value={display(money(total.spend))}
                  sub="Delivered messages × configured rate"
                />
                <Metric
                  icon={MessageCircle}
                  label="Customer responses"
                  value={display(total.responses)}
                  sub="Attributed inbound WhatsApp replies"
                />
                <Metric
                  icon={CalendarDays}
                  label="Booking requests"
                  value={display(total.bookings)}
                  sub={`${total.confirmed} confirmed bookings`}
                />
                <Metric
                  icon={TrendingUp}
                  label="Estimated campaign ROI"
                  value={display(
                    calculateROI(total.revenue, total.spend) === null
                      ? '—'
                      : `${calculateROI(total.revenue, total.spend)}%`,
                  )}
                  sub="Based on recorded payments"
                  accent
                />
              </div>
              <div className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>From conversation to care</h2>
                    <p>Campaign results across the most recent 100 campaigns</p>
                  </div>
                  <span className="badge muted">ALL TIME</span>
                </div>
                <PerformanceChart campaigns={data.campaigns} />
                <div className="funnel">
                  {[
                    ['Sent', total.sent],
                    ['Delivered', total.delivered],
                    ['Responses', total.responses],
                    ['Booking requests', total.bookings],
                    ['Confirmed', total.confirmed],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <strong>{display(value)}</strong>
                      <span>{label}</span>
                    </div>
                  ))}
                </div>
              </div>
              <Notice>
                Read receipts depend on customer settings. Spend and ROI are estimates; actual
                charges come from Meta invoices. Revenue includes recorded campaign payments.
                Replies are attributed to the latest campaign outreach within 30 days.
              </Notice>
              <div className="panel">
                <CampaignTable
                  campaigns={data.campaigns}
                  ready={ready}
                  onOpen={(c) => {
                    setSelected(c);
                    setModal('detail');
                  }}
                  onCreate={() => openCampaign()}
                />
              </div>
            </>
          )}
          {section === 'whatsapp' && previewIdentity && (
            <WhatsAppConnectionOptions
              key={previewIdentity.uid}
              onConnectionChange={setWhatsappVerified}
              onProviderChange={setWhatsappProvider}
              onOpenInbox={() => navigate('inbox')}
            />
          )}
          {section === 'templates' && previewIdentity && whatsappProvider !== 'personal' && (
            <TemplateManager
              key={previewIdentity.uid}
              onOpenIntegration={() => navigate('whatsapp')}
            />
          )}
          {section === 'team' && previewIdentity && (
            <TeamSettings
              key={previewIdentity.uid}
              onOpenInbox={(workspace) => {
                setInboxWorkspaceId(workspace);
                setSelectedChatId(null);
                navigate('inbox');
              }}
            />
          )}
          {section === 'catalog' && (
            <TestCatalog
              tests={data.tests}
              totalTests={ready ? data.tests.length : (ownCatalog?.totalTests ?? 0)}
              loading={catalogLoading}
              error={catalogError}
              onRefresh={accountCatalogMode ? loadCatalog : load}
              onChanged={accountCatalogMode ? loadCatalog : load}
              accountMode={accountCatalogMode}
              ready={catalogReady}
              onAdd={() => setModal('catalog')}
            />
          )}
          {section === 'inbox' && previewIdentity && (
            <WhatsAppInbox
              key={previewIdentity.uid}
              customers={data.customers}
              initialWorkspaceId={inboxWorkspaceId}
              selectedCustomerId={selectedChatId}
              onSelect={setSelectedChatId}
              onOpenIntegration={() => navigate('whatsapp')}
            />
          )}
          <footer className="footer">
            <span>
              © {new Date().getFullYear()} {BRAND.name}
              <i />
              Your Health, Our Priority
            </span>
            <span>
              <ShieldCheck size={13} />
              Built on trust. Powered by consent.
            </span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <Check size={18} />
          {toast}
          <button
            className="icon-button"
            onClick={() => setToast('')}
            aria-label="Dismiss notification"
          >
            <X size={16} />
          </button>
        </div>
      )}
      {loading && (
        <div className="loading-indicator" aria-label="Loading records">
          <LoaderCircle className="spin" size={17} />
        </div>
      )}
      {modal === 'campaign' && !selected && whatsappProvider === 'personal' && (
        <LinkedCampaignForm
          offers={data.offers}
          serverWorkspace={ready}
          onClose={() => setModal(null)}
          onOpenAudience={() => {
            setModal(null);
            navigate('audience');
          }}
        />
      )}
      {modal === 'campaign' && (selected || whatsappProvider !== 'personal') && (
        <CampaignForm
          existing={selected}
          data={data}
          config={config}
          ready={ready}
          accountWhatsApp={!ready && !!previewIdentity && !!config?.accountWhatsApp}
          onConnectionCheck={setWhatsappVerified}
          onOpenIntegration={() => {
            setModal(null);
            navigate('whatsapp');
          }}
          onClose={() => setModal(null)}
          onDone={done}
        />
      )}
      {modal === 'offer' && (
        <OfferForm
          tests={data.tests}
          ready={catalogReady}
          accountMode={accountCatalogMode}
          onClose={() => setModal(null)}
          onDone={done}
          onCatalog={() => {
            setModal(null);
            navigate('catalog');
          }}
        />
      )}
      {modal === 'customer' && (
        <CustomerForm
          ready={customerReady}
          accountMode={accountMode}
          onClose={() => setModal(null)}
          onDone={done}
        />
      )}
      {modal === 'catalog' && (
        <CatalogForm
          ready={catalogReady}
          accountMode={accountCatalogMode}
          onClose={() => setModal(null)}
          onDone={done}
        />
      )}
      {modal === 'job' && booking && (
        <BookingJobForm
          booking={booking}
          customers={data.customers}
          onClose={() => setModal(null)}
          onDone={done}
        />
      )}
      {modal === 'payment' && booking?.jobId && (
        <PaymentForm jobId={booking.jobId} onClose={() => setModal(null)} onDone={done} />
      )}
      {modal?.startsWith('consent:') && consentCustomer && (
        <ConsentForm
          accountMode={accountMode}
          customer={consentCustomer}
          onClose={() => setModal(null)}
          onDone={done}
        />
      )}
      {modal === 'export' && (
        <Modal
          title="Export campaign results"
          description="A branded report of up to 100 recent campaigns and their recorded performance."
          onClose={() => setModal(null)}
        >
          <div className="modal-body">
            <Notice>
              Exports include aggregate campaign results. Private patient records are excluded.
            </Notice>
            <div className="export-options">
              <a
                className={`export-option ${!ready ? 'disabled' : ''}`}
                aria-disabled={!ready}
                href={ready ? '/api/export?format=xlsx' : undefined}
              >
                <BookOpen size={28} />
                <strong>Excel workbook</strong>
                <span>Compare, filter, and analyze results.</span>
                <ArrowDownToLine size={18} />
              </a>
              <a
                className={`export-option ${!ready ? 'disabled' : ''}`}
                aria-disabled={!ready}
                href={ready ? '/api/export?format=pdf' : undefined}
              >
                <ClipboardList size={28} />
                <strong>PDF report</strong>
                <span>A branded performance overview.</span>
                <ArrowDownToLine size={18} />
              </a>
            </div>
            {!ready && (
              <p className="muted-text">
                Connect Firebase and sign in to export real campaign records.
              </p>
            )}
          </div>
        </Modal>
      )}
      {modal === 'detail' && selected && (
        <Modal
          wide
          title={selected.name}
          description={`${selected.id} · Created ${dateLabel(selected.createdAt)}`}
          onClose={() => setModal(null)}
        >
          <div className="modal-body">
            <div className="detail-top">
              <span className={`badge ${selected.status === 'running' ? 'green' : 'muted'}`}>
                {selected.status}
              </span>
              <span>{selected.type}</span>
            </div>
            <div className="detail-stats">
              {[
                ['Sent', selected.sent],
                ['Delivered', selected.delivered],
                ['Read', selected.read],
                ['Failed', selected.failed],
                ['Unknown', selected.unknown],
                ['Bookings', selected.bookings],
              ].map(([k, v]) => (
                <div key={k}>
                  <strong>{v}</strong>
                  <span>{k}</span>
                </div>
              ))}
            </div>
            <div className="campaign-progress">
              <div>
                <span>Campaign progress</span>
                <strong>
                  {selected.audienceSize
                    ? Math.min(
                        100,
                        Math.round(((selected.processed || 0) / selected.audienceSize) * 100),
                      )
                    : 0}
                  %
                </strong>
              </div>
              <progress value={selected.processed || 0} max={selected.audienceSize || 1} />
            </div>
            {selected.lastError && <Notice error>{selected.lastError}</Notice>}
            <div className="detail-link">
              <Link2 size={18} />
              <span>{`${typeof window !== 'undefined' ? window.location.origin : ''}/book/${selected.trackingToken}`}</span>
              <button
                className="icon-button"
                aria-label="Copy booking link"
                onClick={() => {
                  void navigator.clipboard.writeText(
                    `${window.location.origin}/book/${selected.trackingToken}`,
                  );
                  notify('Booking link copied');
                }}
              >
                <Copy size={16} />
              </button>
            </div>
            {selected.status === 'draft' && (
              <p className="muted-text">
                The booking link becomes available when this campaign is launched.
              </p>
            )}
            <div className="detail-actions">
              {selected.status === 'draft' && (
                <>
                  <button className="button secondary" onClick={() => openCampaign(selected)}>
                    Edit draft
                  </button>
                  <button className="button secondary" onClick={() => setModal('test')}>
                    Send test message
                  </button>
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() => void action(selected, 'launch')}
                  >
                    <Send size={16} />
                    Launch campaign
                  </button>
                </>
              )}
              {['scheduled', 'running', 'preparing'].includes(selected.status) && (
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void action(selected, 'pause')}
                >
                  <Pause size={16} />
                  Pause campaign
                </button>
              )}
              {selected.status === 'paused' && (
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => void action(selected, 'resume')}
                >
                  <Play size={16} />
                  Resume campaign
                </button>
              )}
              {selected.failed > 0 && (
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void action(selected, 'retry')}
                >
                  <RefreshCw size={16} />
                  Retry transient failures
                </button>
              )}
              <button
                className="button secondary"
                onClick={async () => {
                  try {
                    const d = await api<{ messages: Record<string, unknown>[] }>(
                      `campaigns/${selected.id}/messages`,
                    );
                    setMessages(d.messages);
                    setModal('delivery');
                  } catch (e) {
                    notify(String(e));
                  }
                }}
              >
                Delivery report <ArrowRight size={15} />
              </button>
            </div>
            <Notice>
              Messages are sent by your scheduled worker. Unknown send outcomes require
              reconciliation with Meta before any resend.
            </Notice>
          </div>
        </Modal>
      )}
      {modal === 'test' && selected && (
        <TestForm
          campaign={selected}
          customers={data.customers}
          rate={config?.rate || null}
          onClose={() => setModal(null)}
          onDone={done}
        />
      )}
      {modal === 'delivery' && (
        <Modal
          wide
          title="Delivery report"
          description={selected?.name}
          onClose={() => setModal(null)}
        >
          <div className="modal-body">
            {messages.length ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Customer</th>
                      <th>Status</th>
                      <th>Attempts</th>
                      <th>Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {messages.map((m) => (
                      <tr key={String(m.id)}>
                        <td>
                          {data.customers.find((c) => c.id === m.customerId)?.name ||
                            String(m.customerId)}
                        </td>
                        <td>
                          <span className="badge muted">{String(m.status)}</span>
                        </td>
                        <td>{String(m.attempts || 0)}</td>
                        <td>{String(m.error || m.reason || '—')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Notice>No messages have been queued for this campaign yet.</Notice>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
function Metric({
  icon: Icon,
  label,
  value,
  sub,
  accent = false,
}: {
  icon: typeof Users;
  label: string;
  value: string | number;
  sub: string;
  accent?: boolean;
}) {
  return (
    <div className={`metric ${accent ? 'accent' : ''}`}>
      <div className="metric-top">
        <span>{label}</span>
        <div className="metric-icon">
          <Icon size={18} />
        </div>
      </div>
      <strong>{value}</strong>
      <small>{sub}</small>
    </div>
  );
}
function MiniMetric({
  icon: Icon,
  title,
  value,
}: {
  icon: typeof Users;
  title: string;
  value: string | number;
}) {
  return (
    <div>
      <Icon size={17} />
      <span>{title}</span>
      <strong>{value}</strong>
    </div>
  );
}
function QuickAction({
  icon: Icon,
  title,
  description,
  onClick,
}: {
  icon: typeof Users;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button className="quick-action" onClick={onClick}>
      <span>
        <Icon size={19} />
      </span>
      <div>
        <strong>{title}</strong>
        <small>{description}</small>
      </div>
      <ChevronRight size={17} />
    </button>
  );
}
function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (s: string) => void;
  placeholder: string;
}) {
  return (
    <div className="search-input">
      <Search size={16} />
      <input
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
export function Empty({
  icon: Icon,
  title,
  description,
  action,
  onAction,
}: {
  icon: typeof Users;
  title: string;
  description: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon size={27} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action && (
        <button className="button secondary" onClick={onAction}>
          <Plus size={16} />
          {action}
        </button>
      )}
    </div>
  );
}
function CampaignTable({
  campaigns,
  ready,
  onOpen,
  onCreate,
}: {
  campaigns: Campaign[];
  ready: boolean;
  onOpen: (c: Campaign) => void;
  onCreate: () => void;
}) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Campaign name</th>
            <th>Status</th>
            <th>Audience</th>
            <th>Delivered</th>
            <th>Bookings</th>
            <th>Revenue</th>
            <th>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {campaigns.map((c) => (
            <tr key={c.id} onClick={() => onOpen(c)}>
              <td>
                <button
                  className="campaign-name"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpen(c);
                  }}
                >
                  <span className="campaign-icon">
                    <Send size={16} />
                  </span>
                  <span>
                    <strong>{c.name}</strong>
                    <small>
                      {c.id} · {c.type}
                    </small>
                  </span>
                </button>
              </td>
              <td>
                <span
                  className={`badge ${c.status === 'running' ? 'green' : c.status === 'scheduled' ? 'blue' : c.status === 'paused' ? 'amber' : 'muted'}`}
                >
                  <i />
                  {c.status}
                </span>
              </td>
              <td>{c.audienceSize.toLocaleString('en-IN')}</td>
              <td>{c.delivered.toLocaleString('en-IN')}</td>
              <td>{c.bookings}</td>
              <td className="revenue-cell">{money(c.revenue)}</td>
              <td>
                <button
                  className="icon-button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpen(c);
                  }}
                  aria-label={`Manage ${c.name}`}
                >
                  <MoreHorizontal size={18} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!campaigns.length && (
        <Empty
          icon={Send}
          title="Your next conversation starts here"
          description={
            ready
              ? 'No campaigns to show yet. Create a thoughtful offer and connect with customers who opted in.'
              : 'Connect your database to view campaigns, or explore the campaign builder to plan your first outreach.'
          }
          action="Create your first campaign"
          onAction={onCreate}
        />
      )}
    </div>
  );
}
function PerformanceChart({ campaigns }: { campaigns: Campaign[] }) {
  const rows = campaigns.slice(0, 6).reverse();
  const max = Math.max(1, ...rows.map((c) => Math.max(c.delivered, c.bookings, c.confirmed)));
  return (
    <div className="performance-chart">
      {!rows.length ? (
        <div className="chart-empty">
          <div className="grid-lines">
            {[0, 1, 2, 3].map((n) => (
              <span key={n} />
            ))}
          </div>
          <div className="chart-empty-label">
            <BarChart3 size={22} />
            <strong>A clearer picture with every campaign</strong>
            <span>Your delivery and booking results will appear here.</span>
          </div>
          <div className="chart-axis">
            <span>Delivered</span>
            <span>Booking requests</span>
            <span>Confirmed bookings</span>
          </div>
        </div>
      ) : (
        <div className="bar-chart">
          {rows.map((c) => (
            <div className="bar-group" key={c.id}>
              <div className="bars">
                {[c.delivered, c.bookings, c.confirmed].map((n, i) => (
                  <div
                    key={i}
                    className={['teal', 'blue', 'light'][i]}
                    style={{ height: `${Math.max(1, (n / max) * 100)}%` }}
                    title={`${['Delivered', 'Requests', 'Confirmed'][i]}: ${n}`}
                  >
                    <span>{n}</span>
                  </div>
                ))}
              </div>
              <span>{c.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
function ConsentForm({
  customer,
  accountMode = false,
  onClose,
  onDone,
}: {
  customer: Customer;
  accountMode?: boolean;
  onClose: () => void;
  onDone: (s?: string) => Promise<void>;
}) {
  const [status, setStatus] = useState(
    customer.marketing.status === 'opted_in' ? 'opted_out' : 'opted_in',
  );
  const [source, setSource] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal title="Update marketing preference" description={customer.name} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await (accountMode ? accountApi : api)(
              `${accountMode ? 'account/' : ''}customers/${customer.id}/consent`,
              { status, source, confirmed },
            );
            await onDone('Marketing preference updated');
          } catch (e) {
            setError(String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="modal-body">
          {error && <Notice error>{error}</Notice>}
          <Field label="Promotional WhatsApp messages">
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="opted_in">Opt in</option>
              <option value="opted_out">Opt out</option>
            </select>
          </Field>
          <Field label="Consent source / evidence">
            <input
              required
              minLength={5}
              maxLength={200}
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="e.g. Signed registration form, verified in person"
            />
          </Field>
          <label className="check-label">
            <input
              type="checkbox"
              required
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>
              I verified this preference with the customer and can provide the recorded consent
              evidence.
            </span>
          </label>
          <Notice>
            Essential booking and report notifications are separate from this preference.
          </Notice>
        </div>
        <div className="modal-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <Submit busy={busy}>Save preference</Submit>
        </div>
      </form>
    </Modal>
  );
}
function TestForm({
  campaign,
  customers,
  rate,
  onClose,
  onDone,
}: {
  campaign: Campaign;
  customers: Customer[];
  rate: number | null;
  onClose: () => void;
  onDone: (s?: string) => Promise<void>;
}) {
  const [id, setId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal
      title="Send a real test message"
      description="Uses the saved approved template and the official WhatsApp API."
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api(`campaigns/${campaign.id}/test`, { customerId: id });
            await onDone('Meta accepted the test message. This does not confirm delivery.');
          } catch (e) {
            setError(String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="modal-body">
          {error && <Notice error>{error}</Notice>}
          <Field label="Opted-in test recipient">
            <select required value={id} onChange={(e) => setId(e.target.value)}>
              <option value="">Select a customer</option>
              {customers
                .filter((c) => c.marketing.status === 'opted_in')
                .map((c) => (
                  <option value={c.id} key={c.id}>
                    {c.name} · +{c.phone}
                  </option>
                ))}
            </select>
          </Field>
          <Notice>
            This sends an actual promotional message.{' '}
            {rate
              ? `Estimated cost: ${money(rate)}.`
              : 'Configure the estimated marketing rate first.'}{' '}
            The recipient must have opted in. A draft campaign’s booking link activates on launch.
          </Notice>
        </div>
        <div className="modal-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <Submit busy={busy} disabled={!id || !rate}>
            Send test message
          </Submit>
        </div>
      </form>
    </Modal>
  );
}
