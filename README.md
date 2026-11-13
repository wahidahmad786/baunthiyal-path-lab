# Baunthiyal Path Lab — Complete Source

Source snapshot exported on 13 November 2026. Branding: **Baunthiyal Path Lab — Your Health, Our Priority**.

## Projects

| Directory | Purpose |
| --- | --- |
| `nextjs-app/` | Full Next.js application, Node API routes, campaign service, Firebase rules/indexes, tests, setup scripts and deployment files. |
| `hosted-portal/` | Source of the currently published private portal: Next.js static UI plus an HTTP Worker implementing account-scoped customer, catalog, offer, integration and inbox APIs. |
| `whatsapp-callback/` | Separate signed Meta webhook receiver. Its deployment remains private at the owner's request. |

The hosted portal corresponds to source commit `ae90432f52c08d6596632c9c5af5458a6ba9cdee`. The callback corresponds to `2e5516a15b0eb6204868a61b8ed615eb04e323ec`.

## Current operating state

- Google/Firebase sign-in and account-scoped customer/catalog/offer/integration APIs are implemented. The reference library contains 439 tests; reference entries have no invented prices.
- The inbox shows records received by the API and provides customer WhatsApp links. It does not import historical mobile WhatsApp chats.
- The callback is private and `WHATSAPP_WEBHOOK_PUBLIC_READY=false`. New Meta callbacks and live inbox replies are inactive until the owner explicitly enables public callback access, completes Meta subscription and supplies valid runtime credentials.
- Campaign dispatch, scheduling and other full Node backend operations in `nextjs-app` are not all deployed on the hosted Worker portal. The UI must continue to reflect actual backend availability.
- Firebase remains on Spark/free. No paid Firebase backend upgrade is included or enabled by this export.
- This repository contains the implementation built in this workspace. No original external diagnostic portal repository was available; existing external patient reports, staff and financial systems were not imported.

## Run the full Next.js app

Use Node.js 22+ and npm. From `nextjs-app`:

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
