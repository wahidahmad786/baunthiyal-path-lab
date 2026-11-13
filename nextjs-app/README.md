# Baunthiyal Path Lab — Marketing & Campaigns

Next.js / Firebase / official WhatsApp Business Cloud API module, branded **Baunthiyal Path Lab — Your Health, Our Priority**.

## Delivery status

The initial workspace contained **no existing application or repository**. Firebase was subsequently connected to the confirmed existing project; see SETUP.md for actual cloud setup and the owner’s free-plan decision. Meta credentials and the original diagnostic portal source remain unavailable. This is a separate implementation, not a verified modification of the existing diagnostic center system. Only a genuine Firebase setup-status record and the lab admin identity were added; no patient/finance data was changed and no real WhatsApp message was sent. Receive the original source and follow [INTEGRATION.md](INTEGRATION.md) before merging or deploying into the existing portal. Existing report delivery, tracking, finance, refunds, partners, sample collection, and staff workflows could not be inspected or regression tested.

The app never substitutes mock customers, simulated delivery, or browser storage for Firebase records. Without configuration it shows an honest connection state and permits exploring the builder; persistent actions require authenticated Firebase access.

## Implemented

- Original blue/teal SVG logo, shared brand definition, responsive admin workspace, branded login, public offer and preference pages, branded PDF receipts and campaign exports.
- Campaign drafts and editing; targeting by consent, visits, dates, tests, groups, and manual selection; price/offer selection; image banner upload; live Meta-approved templates; positional and named parameter mappings; preview; test messages; schedule, launch, pause, resume, progress, per-recipient delivery reports and safe transient retry.
- Percentage/fixed discounts, nine offer categories, unique `BPL-OFFER-0001` IDs, catalog records, validity and customer eligibility rules.
- Separate marketing consent, unchecked registration checkbox, source/date/status, append-only server consent history, signed preference links, STOP webhook handling. Public booking consent requests remain pending until staff verify the phone.
- Opaque campaign booking links, public offer details without patient data, idempotent booking requests and in-app admin notifications, matching registered customers to job cards, automatic offer discounts, payment ledger and branded receipts.
- Analytics from stored messages, responses, bookings and collected payments; aggregate Excel/PDF exports. No delivery is assumed from API acceptance.

## Setup automation

See [SETUP.md](SETUP.md) for the confirmed project number/contact, completed local setup, private credential handling, Firebase discovery, managed hosting, OIDC scheduler and remaining account authorization.

## Local development

Requires Node.js 22+ and npm. Java 21+ is needed only for Firebase emulator integration tests.

```sh
npm ci
cp .env.example .env.local
# Configure credentials via your local secret manager / environment settings.
npm run dev
```

Environment values are documented in `.env.example`. Never paste real secrets into chat or commit them. `APP_URL` must exactly match the browser origin; production requires HTTPS. Server Firebase credentials may use service-account variables or Application Default Credentials. Enable Firebase Email/Password authentication and create an account; grant the account the `bplAdmin: true` custom claim using a trusted Admin SDK process (example: `scripts/grant-admin.mjs`). No public administrator signup exists. Client Firebase configuration is public by design; Admin SDK and Meta keys remain server-only.

## Meta configuration

1. Configure a verified WhatsApp Business account, a registered phone number, appropriate business permissions and a suitable system-user token.
2. Set the WABA ID, phone-number ID, token, app secret and a randomly generated webhook verification token.
3. Pin a supported Graph API version in `WHATSAPP_GRAPH_VERSION` after checking your Meta application. The example default is `v23.0`.
4. Register `https://your-domain/api/webhook` as the webhook URL, verify the challenge and subscribe to message events. Webhook requests are verified against the raw-body `X-Hub-Signature-256` HMAC.
5. Create and get Meta approval for a **MARKETING** template containing the lab branding, a booking-link placeholder and a **Reply STOP** instruction. Optional parameters include a signed preferences link. The provided example in the builder is illustrative and is never sent as an unapproved free-text message.
6. Supported templates: BODY parameters (named or positional), optional IMAGE header, static URL/quick-reply buttons. Text/video/document headers and dynamic URL buttons are excluded from the selector until those component types are implemented.
7. Configure `LAB_PHONE`, the current estimated message rate in **paise**, and a rolling 24-hour allowance at or below your actual Meta account allowance. The local counter conservatively counts all send reservations in a rolling 24-hour window (configuration is capped at 10,000). Meta remains the authority on its own limits. Provider limit errors pause the campaign and activate a one-hour account-wide cooldown; review Meta account health before resuming.
8. Send a test only to an explicitly opted-in registered recipient. A test uses the real API, incurs possible Meta charges, is stored separately, and does not inflate campaign performance.

### Sending worker

Schedule an external trusted scheduler to POST `/api/worker` every minute with:

```text
Authorization: Bearer <CRON_SECRET>
```

Use a randomly generated secret of at least 32 characters. The scheduler must support authenticated POST. A configured key does **not** prove a scheduler has been deployed. Provision the scheduler in your actual hosting environment; there is no in-browser timer masquerading as a scheduler. The route requires Node.js and a runtime request timeout of at least 300 seconds. Overlapping workers are fenced by a Firestore lease. Each invocation handles at most 25 recipients (20 by default), with a bounded lease. Worker execution history is stored in `bpl_workerStatus/latest`.

An audience is evaluated at dispatch, frozen during preparation, and checked again per message. Pausing prevents future dispatch after the next status check; submissions already accepted by Meta can still deliver. A tiny race between the final consent check and the external API submission is inherent in any non-transactional provider call; consent changes prevent subsequent sends.

Network timeouts and interrupted sends become **unknown**, not “delivered” and not automatically retried. Reconcile unknown sends against Meta before manual intervention. Explicit transient Meta failures can be requeued up to three attempts; permanent validation/recipient failures cannot. Out-of-order receipts cannot demote delivered/read messages. Receipts from an earlier retried attempt cannot overwrite a newer attempt. Early/unmatched receipts are retained for reconciliation; unrelated existing portal messages must also be forwarded to the original webhook handler during integration.

## Database and privacy

All new collections use a `bpl_` prefix. All app data access runs through authenticated server endpoints. Firebase Admin SDK bypasses Firestore rules; use a least-privilege service identity. Supplied rules deny direct browser access and are **standalone examples**, not a replacement for existing portal rules. Merge and review rules in the original project.

Public pages expose offer information only. Booking requests are keyed by campaign + normalized phone to prevent duplicates. They create a notification and require staff verification; they do not reveal whether a patient exists or show medical records. Signed preference tokens expire after 90 days and are stored hashed. Public form throttling requires `PUBLIC_RATE_LIMIT_SECRET` (32+ random characters). Configure your trusted ingress to overwrite `X-Forwarded-For`, enforce upstream body/rate limits, and prevent direct access that could spoof that header. Add your lab's real privacy/contact policy before a public launch.

Prices and ledger amounts are integer **paise**. Percentage discounts round to the nearest paise. Payments are transactionally checked against the balance and deduplicated by reference. Public pages cannot write job cards or payments. Campaign exports contain aggregates, not patient records.

## Validation

```sh
npm test
npm run typecheck
npm run build
npm run test:integration
```

The integration suite uses **only** the isolated `demo-bpl` Firestore/Auth emulators and rejects production project IDs. External Meta boundaries are mocked inside tests only; the application always uses Meta's real endpoint. Emulator testing proves local database behavior, not production credential validity or delivery. Browser QA requires the managed browser tool; it was unavailable in this environment.

## Explicit operating bounds and reporting semantics

- Maximum 1,000 recipients per campaign and 10,000 opted-in records for current audience evaluation; larger installations need indexed audience pagination and a durable task queue. The UI reports these bounds.
- Dashboard/exports analyze the **100 most recent campaigns**. Lists include up to 1,000 recent customers, 200 offers and 200 booking requests; customer totals use Firestore count aggregates across all customers.
- Spend = configured estimated rate × delivered messages. Actual Meta invoices, free/discounted rates and country-specific pricing are not reconciled. ROI is an estimate, undefined at zero spend.
- Revenue reflects **gross collected payments in this module's ledger**, not billed amounts. Connect original refunds/returns and finance records before relying on it for net financial reporting.
- Responses are idempotent inbound events attributed to the last campaign outreach within 30 days (including opt-out replies), not a claim of causal conversion. Read receipts may be unavailable. Individual link-open tracking is deliberately omitted; unique links attribute booking requests without identifying page viewers.
- The consent preference affects promotional sends only. Essential booking/report notification code is not modified.
