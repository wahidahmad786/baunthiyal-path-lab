# Integration into the existing diagnostic collection center portal

This module is namespaced because the original source/schema was not supplied. It must not be deployed over the existing app as if it were a completed migration.

## Merge sequence

1. Obtain the existing repository, AGENTS.md/project instructions, runtime versions, Firebase schema, security rules and current WhatsApp webhook/queue implementation. Work on a branch and back up rules and schema before migration.
2. Reuse existing Firebase initialization and existing authorization checks. The prepared module requires the scoped `bplAdmin` claim; map the portal's actual owner/admin identities deliberately and preserve existing claims; do not broaden staff access to patient or campaign data. Keep origin checks and HttpOnly session handling or adapt to the established equivalent.
3. Mount the dashboard under the existing administrator layout (for example `/admin/marketing`). Add the **Marketing & Campaigns** sidebar entry. Resolve root route, login and catch-all API collisions by mounting under an isolated prefix and updating client URLs. Preserve existing pages and public tracking routes.
4. Apply `lib/brand.ts` and `public/logo.svg` to the existing login, dashboard, job cards, PDFs, receipts, notifications, patient tracking, reports, website header/footer and financial exports. Search original source for obsolete brand strings and confirm output snapshots; this could not be done without that source.
5. Map the original customer/test collections to `Customer` and `TestRecord` at the server adapter. Preserve original document IDs, normalized phone numbers, visit histories and group references. Do not copy medical reports or clinical details into campaign collections. Historical patients without verifiable promotional consent must default to `not_asked`; never infer consent from a previous visit.
6. Add the separate, optional, unchecked marketing checkbox to the original registration form. Write the marketing status/date/source and append a consent event in the same registration transaction. Booking/report notification consent remains separate. Only verified phone ownership and explicit evidence may activate public booking consent requests.
7. Adapt booking-to-job creation to the **original job card transaction and ID allocator**. This module currently creates `bpl_jobs` records. Reuse the server eligibility and paise price helpers, check bundle/test scope and validity, and store immutable campaign and offer attribution. Do not create a second patient or job database in production.
8. Connect the existing payment/refund ledger to campaign revenue. Payment references must be unique, balances validated transactionally, refunds deducted, and posted receipts immutable under your established accounting flow. This module's standalone ledger is intentionally not advertised as net financial reporting.
9. Multiplex the Meta webhook: validate the raw-body signature once, forward existing owner report alerts, patient notifications and report tracking events to the original handler, and send campaign events to `applyDelivery`/STOP consent handling. Essential notifications must never be blocked by a promotional opt-out. The new module's unrecognized receipts are retained, not treated as failed patient messages.
10. Reuse the existing trusted scheduler/queue, or deploy the authenticated worker. Merge rather than replace Firestore/Storage rules; check existing broad grants do not expose `bpl_` collections. Deploy TTL policies, configure rate limits, supported Meta version, least-privilege service account, public URL and privacy/contact information.

## Acceptance checks against the original application

Before deployment, run the existing regression suite for every original feature: admin dashboard, patient registration, unique job cards, test catalog, samples, uploads, owner report alerts, patient notifications, report tracking, expenses, income/payments, returns/refunds, partners, financial reports, and staff access. Confirm every original route still resolves and every old job/report link remains valid.

Then use a consented test recipient and a small real campaign to verify approved templates, actual Meta IDs, webhook delivery/read/failure states, STOP, preference updates, schedule/pause/resume, duplicate webhooks and public booking conversion. Verify reports against actual invoices and original finance ledger. Do not claim production messaging is operational based solely on unit tests or emulator success.

## Main integration points

| File                                               | Responsibility                                                                     |
| -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `lib/brand.ts`, `public/logo.svg`                  | Name, tagline, original medical logo                                               |
| `lib/domain.ts`                                    | Types, validated inputs, targeting, eligibility, discount calculations             |
| `lib/server/firebase.ts`                           | Firebase initialization and canonical public origin                                |
| `lib/server/auth.ts`                               | Admin access, server session, origin enforcement                                   |
| `lib/server/service.ts`                            | Real records, consent, audience, worker, webhook status reconciliation             |
| `lib/server/whatsapp.ts`                           | Approved-template discovery and actual Meta API submission                         |
| `app/api/[...path]/route.ts`                       | Authenticated admin API, public booking/preferences, signed webhook, cron endpoint |
| `components/dashboard.tsx`, `components/forms.tsx` | Sidebar/dashboard, builders, analytics, administration                             |
| `lib/server/export.ts`                             | Branded aggregate Excel/PDF exports and private job receipts                       |

Firebase authorization, dedicated web-app configuration, Authentication, private rules and server connectivity have since been verified. Original portal source/migration, public server hosting, scheduler deployment and live Meta messaging remain outstanding.
