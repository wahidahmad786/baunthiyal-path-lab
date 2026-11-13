# Firebase setup status — 13 November 2026

Firebase Google authorization completed successfully. The existing project was resolved by its confirmed numeric project number; no new project or billing account was created.

| Setting                 | Verified value/status                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| Firebase project ID     | `automotive-web-application`                                                                                  |
| Firebase project number | `43361196855`                                                                                                 |
| Dedicated lab web app   | `Baunthiyal Path Lab`                                                                                         |
| App ID                  | `1:43361196855:web:acfdd21259464c19aed8b2`                                                                    |
| Lab WhatsApp contact    | `+916395951791`                                                                                               |
| Existing Firestore      | `(default)`, Standard edition, `asia-south1` (Mumbai)                                                         |
| Billing preference      | Keep Spark/free plan                                                                                          |
| Firestore connectivity  | Real server read and setup-record write verified                                                              |
| Authentication          | Google sign-in and email/password enabled; Google OAuth client and authorized domains verified                |
| Lab administrator       | Authorized Google email registered with scoped `bplAdmin: true` claim                                         |
| Admin password          | Not required for Google sign-in; user-initiated password setup/reset remains available for email login        |
| Firestore rules         | Existing project had no active Firestore release; server-only direct-client-deny rules validated and deployed |
| Public Next.js server   | Not deployed; Firebase App Hosting requires Blaze, which the owner declined                                   |
| Banner storage          | SDK bucket name exists in configuration, but the actual bucket is not provisioned/available                   |
| Meta WhatsApp API       | Not connected; phone number alone is not API authorization                                                    |

## What changed

A separate lab web app was added inside the confirmed existing project. The prior automotive web app and Hosting site were retained. No patient, campaign, payment, sample or report records were imported or modified. One genuine setup-status document was written under `bpl_integrationStatus/firebaseSetup`. A lab administrator identity was created under Firebase Auth without creating or sending a password.

The application uses a dedicated `bplAdmin` custom claim so unrelated apps' generic administrator roles do not grant access to lab records. Existing claims are preserved by the administrator provisioning helper. The login page offers Google sign-in and an explicit password setup/reset action; mail is sent only if the owner chooses that action. Google sign-in uses the existing authorized administrator email. The private preview domain and localhost were added to Firebase authorized domains, preserving both existing project domains.

The signed-out home shows the lab welcome page and sign-in. Authenticated users can open WhatsApp Integration from the sidebar. Any verified Google account may manage its own encrypted connection; the existing bplAdmin claim remains required for lab records and operational APIs. Google authentication is retained for the browser session. Signing out clears Firebase authentication and, on the full Next.js server, the server cookie. Admin sign-in also establishes the HttpOnly server session. Non-admin sign-in clears any prior lab server cookie before opening personal onboarding.

## Credentials

Actual public web app settings and the selected app ID are configured in git-ignored `.env.local`. Authorized local development credentials are stored outside the application/source bundle with mode `0600`. No authorization code, token, private credential file or `.env.local` is included in the downloadable source. Any future hosted server should use a managed service identity rather than copying development credentials.

## Running the prepared application on an existing Node.js host

```sh
npm ci
npm run setup
# Configure the existing project/app fields securely in the host environment.
# Use the values in deploy/connection-target.json for the known project and app IDs.
npm run setup:check
npm run setup:verify
npm run build
npm start
```

Client Firebase fields must be present at build time. Server credentials and Meta tokens remain runtime-only. Set `APP_URL` to the final canonical HTTPS origin. Register the real host domain under Firebase Auth authorized domains when needed. Use **Continue with Google** with the registered administrator Google account. Alternatively, set an application password using the explicit reset action before email/password sign-in.

## What remains under the free-plan decision

Spark supports the configured Authentication and Firestore usage within its quotas. This Next.js application still needs a Node.js-capable host for its authenticated APIs, receipts, bookings, campaign dispatch and webhooks. Firebase App Hosting, this project's Cloud Scheduler path and new Firebase Storage provisioning cannot be activated here under the chosen free-plan setup. No paid backend, scheduler, billing upgrade or storage bucket was created.

`Dockerfile` and `apphosting.yaml` remain deployment options, but no App Hosting rollout is active. The App Hosting option is not selected while the owner retains Spark. A separate existing or eligible free Node.js host can be connected later; none has been fabricated or assumed available.

The original diagnostic portal source/repository is still missing. Its patient/report/finance/staff workflows have not been merged or regression tested. Use INTEGRATION.md before replacing any existing production pages.

## WhatsApp prerequisites

Actual promotional sending still requires the existing Meta app's WABA ID, phone-number ID, access token and app secret via secure server configuration; an approved branded marketing template; a reachable HTTPS callback/booking origin; consented recipients; and the actual account's message rate/allowance. Meta messaging charges are separate from the Firebase free plan. No marketing message was sent during setup.

## Account-only WhatsApp Integration — 13 November 2026

The private Sites host now runs a small HTTP Worker alongside the exported Next.js UI. The live account endpoint is `/api/whatsapp/integration`; it verifies Firebase ID tokens with Firebase, reads/writes the caller’s `bpl_whatsappConnections/{uid}` document using their token, and encrypts every stored connection using AES-256-GCM. The encryption binds records to the UID. The stable `WHATSAPP_CONNECTION_ENCRYPTION_KEY` is a secret runtime variable and is excluded from source and browser builds. The same handler is available in the full Next.js app. No Firebase billing upgrade or development ADC credential was deployed.

The form accepts the phone number, Phone Number ID, WABA ID, Meta App ID, access token, App Secret and optional webhook verification token. Existing secrets are retained when left blank and are never returned in API responses. Save details stores an unverified connection. Verify & save calls the official Meta Graph API to verify WABA/phone ownership, the entered phone number and the app identity before recording successful verification. Editing/saving clears previous verification. No message is sent by either action. Secrets for different users cannot configure the lab-wide sender or grant lab admin access.

Account onboarding and customer registration are live on the account host. The full campaign API, dispatch worker, patient records, campaign webhooks and scheduler are still separate deployment work. Saving an account connection does not activate those services or replace their existing server environment credentials. The UI does not claim otherwise. Home-page setup banners, connection diagnostics and the setup-package download were removed. No public source archive is served.

The prototype Firestore rules allow only verified owners to get/create/update/delete their encrypted connection. Listing is denied. Required fields, size/type limits, ownership and immutable creation timestamps are checked on creates and updates. All other client access remains denied. Emulator tests reject cross-account reads, list queries, owner changes, extra role/plaintext fields, required-field deletion, type corruption, oversized ciphertext and timestamp changes. Encryption tests reject cross-owner replay and tampering.

I've set up prototype Security Rules to keep the data in Firestore safe. They are designed to be secure for owner-only encrypted WhatsApp connections while keeping patient and campaign records inaccessible to clients. However, you should review and verify them before broadly sharing your app. If you'd like, I can help you harden these rules.

## Customer registration fix — 13 November 2026

The account host now exposes real `GET/POST /api/account/customers` and `POST /api/account/customers/{id}/consent` endpoints. The customer form previously inherited the unavailable campaign-server readiness flag, which disabled Save even after Google authentication. Customer readiness is now independent; requests use the current Firebase ID token, and successful saves refresh both the customer list and actual database count aggregations. The list remains capped at 1,000 rows and reports truncation; displayed totals come from count queries rather than the row cap.

Account customers are stored under `bpl_customerWorkspaces/{uid}/customers/{phoneHash}`, with verified-owner-only access. Duplicate phone numbers return an actionable conflict without overwriting consent. Each recorded opt-in or opt-out atomically writes a new immutable `consentEvents/{eventId}` record; Security Rules require both sides of that relationship to match. The not-asked default remains separate from promotional opt-in. Account changes clear visible account data and close customer forms; stale requests cannot populate a different account’s rows.

The existing full-server lab admin path continues to use its original `bpl_customers` collection and session-protected routes when that server is active. Account-host customers are separate workspace records; a future campaign deployment must select the same workspace storage or explicitly migrate these records before switching the operational backend. This fix does not send WhatsApp messages or activate the campaign dispatcher.

Validation: customer API persistence/reload, true counts, duplicate handling, cross-account isolation and consent changes passed isolated demo-bpl emulator tests. Rule tests cover public/cross-account/unverified access, strict schemas and group bounds, immutable customer fields, missing/mismatched/replayed audit events and role injection. The unchanged lab operations remain protected by bplAdmin.

## Campaign launch diagnostics — 13 November 2026

A read-only live inspection confirmed one saved, previously verified encrypted WhatsApp connection. The official Meta templates request using those credentials failed with HTTP 401 and Meta error code 190. No provider response body or credential value was logged, and no message was sent. The stored access token must be replaced and verified through the integration page before Meta templates can be read. Existing successful verification timestamps describe a past check, not an unexpired token.

The account host now exposes authenticated `GET /api/whatsapp/integration/templates`. It decrypts only the caller’s saved connection, verifies the existing account, and reads actual Meta-approved marketing templates. Supported templates require lab identity, tagline, STOP, an attribution variable and supported components; unsupported templates are counted with explicit safe reasons. Missing/unverified connections produce actionable conflicts. Expired/invalid provider tokens produce 409 `META_ACCESS_TOKEN_INVALID`, separate from an expired Firebase user login. No template fallback is presented as approved.

The campaign builder now checks templates through the account endpoint independently of the unavailable campaign server. It includes a refresh action, a direct route to WhatsApp Integration, and an explicit launch checklist for the active sender, saved offer, provider connection, approved template, field mappings, eligible estimated audience and any required banner. Wizard checkmarks reflect actual completed prerequisites. Stale template responses cannot update a later request or unmounted form.

The campaign dispatcher, scheduling and campaign delivery/STOP webhook backend remain inactive on this host. Existing account credentials are not silently copied into global server variables. Launch and draft saving remain unavailable until those services and scoped campaign storage are implemented/deployed. This change fixes template wiring and explains the blockers; it does not claim that campaign sending is now live.

Validation: 21 unit tests, targeted Auth/Firestore emulator integration tests for connection/template isolation, safe provider errors and real stored credentials, plus production builds. Meta reads alone are mocked in emulator tests. The actual provider read above independently returned code 190.

## Tests, offers and WhatsApp Inbox — 13 November 2026

The portal now has a searchable Tests & packages section with a curated439-entry reference library across27categories. Sources and finite scope are documented in docs/TEST_CATALOG_SOURCES.md. These are actual assay/panel names; no vendor prices or laboratory availability were invented. Reference rates are null until the lab supplies its own rate. Existing customnames/rates are preserved on import.439missing entries were added to the one existing workspace using the authorized administrative setup; no customer records were changed. New emptyworkspaces import the library through the authenticated scopedAPI.

GET/POST /api/account/catalog, POST /api/account/catalog/import-reference and POST /api/account/offers are live-capable HTTP endpoints backed by actual Firestore records. The catalog list uses a bounded structuredquery to retrieve allreference rows, avoiding an emulator ListDocuments pagination/orderBy limitation. Counts use actual aggregations. Offers use upto20current owned priced selections, calculated original totals/discounts and unique BPL-OFFER identifiers. Unknownrates cannot be quoted in offers. Customer/catalog/offer readiness is independent of the inactive campaigndispatcher.

WhatsApp Inbox merges registered customers with actual APIconversations, polls stored history/statuses, and provides customer-name/phone links to WhatsApp. Manual wa.me navigation is never counted as an API send. Old app-onlychat history is not fabricated or automatically imported. Text replies require the trusted same-phone inbound24hour window, verified account setup and an activecallback. Meta acceptance, sending, delivery, read and failure states are separate and depend on actual provider receipts. Request IDs prevent duplicate APIcalls; uncertain submissions are not automatically retried. Signed STOP events update the existing customer preference with an audit event.

A dedicated bpl-whatsapp-backend service identity with roles/datastore.user was provisioned. Its key is outside source and available to hosted servers only as a secret runtime value. No development ADC credentials were deployed. OAuth signing and a real Firestore read were verified with the dedicated identity. The callback handler verifies raw HMAC signatures and phone-number scope before recording any event; connection changes cannot reuse a different sender’s callback readiness or reply window. Client chat writes are denied; record reads remain verified-owner-only.

The separate callback endpoint is deployed at https://baunthiyal-whatsapp-callback.resolutedingo9.chatgpt.site . The user explicitly chose to keep it private. WHATSAPP_WEBHOOK_PUBLIC_READY is false, so incoming Meta callbacks/live deliveryupdates and portal API replies remain inactive; ordinary WhatsApp chat links work. The main dashboard remains at its existing owner-private portalURL, and no access audiences were broadened. This callback is a technical service, not a replacement dashboard.

Validation:28unit tests, actual Auth/Firestore emulator catalog/import/edit/offer and inbox/HMAC/idempotency/receipt/STOP tests, explicit cross-account/rule attack tests, successful productionbuilds, actual439-entry database setup and dedicated identity read. Provider sends were mocked only in isolated demo-bpl tests; no customer message was sent by setup tools.
