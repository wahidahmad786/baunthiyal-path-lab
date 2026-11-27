# Baunthiyal Path Lab — Complete Source

Source snapshot updated on 27 November 2026. Branding: **Baunthiyal Path Lab — Your Health, Our Priority**.

## Projects

| Directory | Purpose |
| --- | --- |
| `nextjs-app/` | Full Next.js application, Node API routes, campaign service, Firebase rules/indexes, tests, setup scripts and deployment files. |
| `hosted-portal/` | Source of the currently published private portal: Next.js static UI plus an HTTP Worker implementing account-scoped customer, catalog, offer, integration and inbox APIs. |
| `whatsapp-callback/` | Separate signed Meta webhook receiver. Its deployment remains private at the owner's request. |

The hosted portal corresponds to source commit `ae90432f52c08d6596632c9c5af5458a6ba9cdee`. The callback corresponds to `2e5516a15b0eb6204868a61b8ed615eb04e323ec`.

## Current operating state

- The existing Render app now includes Template Manager (drafts, real Meta submission/image upload/status refresh), persistent connection alerts with dashboard checks, and an invitation-based Team Inbox with roles, assignment, labels, notes and quick replies. See [`nextjs-app/docs/CRM_MODULES.md`](nextjs-app/docs/CRM_MODULES.md) for behavior and validation. These modules use real account-scoped records; provider operations require valid Meta credentials. No paid service or message campaign is automatically started.

- Public privacy policy, terms, data deletion instructions and contact pages are available on the Render app; see `nextjs-app/docs/META_PUBLIC_PAGES.md` for the exact Meta settings URLs.
- Campaign banners can be optimized and saved in the signed-in user's Firestore workspace, with image previews preserved across wizard steps. This does not require a paid Storage bucket.

- Google/Firebase sign-in and account-scoped customer/catalog/offer/integration APIs are implemented. The reference library contains 439 tests; reference entries have no invented prices.
- The inbox supports available individual phone-chat history and contact-name sync for QR-linked WhatsApp, new chats by number, earlier-message pagination and direct text replies. Official Meta connections retain their API/template rules. See `nextjs-app/docs/PERSONAL_WHATSAPP_INBOX.md`.
- The current Meta test sender and per-customer 24-hour reply restrictions are shown explicitly. The requested app's WABA event subscription was added after current token permissions were confirmed; see `nextjs-app/docs/WHATSAPP_REPLY_REQUIREMENTS.md` for the operational requirements.
- Account-scoped Embedded Signup, real connection checks, secure saved business authorization and optional Business app Coexistence support are implemented. **Public quick connect is not activated** until the portal owner's Meta login configuration and required approvals are complete. The shared portal app/configuration does not share one WhatsApp identity among users. See [`nextjs-app/docs/META_EMBEDDED_SIGNUP.md`](nextjs-app/docs/META_EMBEDDED_SIGNUP.md).
- The current callback receiver is the signed `/webhook/<account-uid>` route on the public Render app, enabled for the owner's callback repair request. It validates the saved verification token for challenges and the Meta HMAC signature for events. The original separate callback Site remains private. Meta subscription and valid API credentials are still required; public receiver readiness alone is not a claim that messaging is connected.
- Campaign dispatch, scheduling and other full Node backend operations in `nextjs-app` are not all deployed on the hosted Worker portal. The UI must continue to reflect actual backend availability.
- Firebase remains on Spark/free. No paid Firebase backend upgrade is included or enabled by this export.
- This repository contains the implementation built in this workspace. No original external diagnostic portal repository was available; existing external patient reports, staff and financial systems were not imported.

## Run the full Next.js app

For the existing Render web service, use the exact build and environment settings in [`nextjs-app/RENDER.md`](nextjs-app/RENDER.md). The Dockerfile supports both a repository-root and app-directory build context through `APP_SOURCE`.

For Netlify, the root `netlify.toml` publishes a temporary redirect to the existing Node-hosted portal; see [`nextjs-app/NETLIFY.md`](nextjs-app/NETLIFY.md). Netlify is an entry URL in this configuration, not another backend deployment.

For Railway, the root `Dockerfile` builds `nextjs-app` automatically. See [`nextjs-app/RAILWAY.md`](nextjs-app/RAILWAY.md) for service settings and required variables.

Use Node.js 24+ and npm. From `nextjs-app`:

```sh
npm ci
cp .env.example .env.local
# Fill the local environment file using your Firebase and Meta configuration.
npm run dev
```

For verification: `npm test`, `npm run typecheck`, and `npm run build`. The optional emulator integration suite requires Java 21+ and uses the isolated `demo-bpl` project: `npm run test:integration`.

See `nextjs-app/SETUP.md` and `nextjs-app/INTEGRATION.md` for setup and integration details. Earlier milestone documents may describe previous setup states; the operating state above describes this export.

## Build the currently hosted portal

From `hosted-portal`, run `npm ci`. Set the public build-time variables in `.env.example`, then:

```sh
npx next build --webpack
node scripts/build-account-host.mjs
```

The deployable Worker is `dist/server/index.js`. Configure server values from `.env.runtime.example` as runtime settings/secrets, not browser build variables. The included `.openai/hosting.json` retains the existing Site identity and does not grant access to it.

## Build the webhook receiver

From `whatsapp-callback`:

```sh
npm install
npm run build
```

Its runtime settings are listed in `.env.runtime.example`. Building or storing this source does not change the existing callback's private audience.

## Contents and credentials

All application source, source assets, test suites, package manifests/available lockfiles, Firebase rules and setup documentation are included. Installable dependencies, generated build output, Git internals, logs, database records, credentials, local `.env` files and service-account keys are excluded. Example environment files contain variable names/placeholders only. Existing secrets must be configured separately through a trusted secret manager.

`MANIFEST.sha256` records every exported source file. Check it with `sha256sum -c MANIFEST.sha256` from this directory before making changes.
