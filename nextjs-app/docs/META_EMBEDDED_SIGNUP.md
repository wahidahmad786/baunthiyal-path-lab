# Connect WhatsApp for each Google account

The portal uses one portal-owned Meta app and Facebook Login for Business configuration. Each signed-in person authorizes their **own** Meta business and WhatsApp account. The shared configuration is not the lab’s WhatsApp identity. Individual access tokens, phone IDs, callback tokens and business account IDs remain separate for each Firebase UID.

## Implemented

- An authenticated quick-connect card, a real server-side connection check, renewal/expiry information and collapsed advanced manual settings.
- Official Facebook SDK popup with v4 configuration; no deprecated `sessionInfoVersion: 3` setting. SDK loads only after authenticated readiness succeeds.
- An encrypted business integration system user token, not a temporary SDK user token. Token issuance and expiry are controlled by Meta; non-expiring tokens can still be revoked.
- A one-use ten-minute session, HttpOnly Secure same-site browser cookie, Google owner binding, origin checks, encrypted candidates and compare-and-set database writes.
- Server-side code exchange, token/app/scope checks, WABA phone lookup, per-account callback verification/override and subscribed-app setup. The 30-second code is exchanged before account onboarding work. Tokens, secrets, PINs and raw provider errors are never returned to the browser.
- One portal owner per WABA, because Meta’s callback override applies to the WABA. Separate owners can connect separate accounts; an existing account cannot be silently redirected by another login. Manual verification enforces the same ownership index.
- Optional Coexistence: skip Cloud API registration for a number already using the Business app, initiate each contact/history synchronization once, ingest signed contact/history/app-echo events and detect offboarding. Imported contacts do not become marketing-opted-in customers. Historical messages and app-sent messages do not create a Cloud API reply window. Text is displayed; unsupported media is represented by a clear placeholder. Phone-less business-scoped identities are not turned into guessed phone recipients.
- Closing the browser or signing out does not remove the saved WhatsApp connection. No reconnect timer fabricates authorization; revocation still needs genuine Meta approval.

## One-time portal owner setup (still required)

This cannot be enabled with a lab’s WABA ID alone. Complete the portal business’s applicable Meta business/access verification, Tech Provider enrollment and App Review. WhatsApp Cloud API in Embedded Signup v4 requires advanced access to `whatsapp_business_management` and `whatsapp_business_messaging` for onboarding other businesses. App roles can test under Meta’s testing rules before public access approval.

1. In the portal-owned Meta app, enable **Facebook Login for Business**. Allow the real HTTPS portal domain and its OAuth redirect URL in Login settings; enable Login with the JavaScript SDK and strict redirect URI matching. Configure public privacy/deletion URLs from this portal.
2. Create a **WhatsApp Embedded Signup** configuration using the **Cloud API** product, with a business system user token and only the required WhatsApp permissions/assets. Use the v4 product-based configuration. Choose the actual token lifetime offered by Meta; the application displays the resulting expiry rather than promising permanence.
3. Subscribe the app to `messages`. For Coexistence, also configure `account_update`, `history`, `smb_app_state_sync` and `smb_message_echoes`, confirm eligibility, and support the mobile-app authorization step. Do not delete/deregister a user’s existing WhatsApp Business app account.
4. On an existing installation, run the migration below with the current server identity and encryption key. It preserves earlier verified manual connections and rejects ownership conflicts.
5. Configure server-only deployment settings:

   ```dotenv
   META_EMBEDDED_APP_ID=<portal app id>
   META_EMBEDDED_APP_SECRET=<portal app secret, stored as a secret>
   META_EMBEDDED_CONFIG_ID=<Facebook Login for Business configuration id>
   META_EMBEDDED_SIGNUP_ENABLED=true
   META_COEXISTENCE_ENABLED=false
   ```

   Set `META_COEXISTENCE_ENABLED=true` only after step 3 is complete and tested. Keep the existing stable `WHATSAPP_CONNECTION_ENCRYPTION_KEY`, service identity, public webhook base URL and origin settings. There is no per-user app-secret entry for the new flow.
6. Test with a real app-role user and number, then a separate eligible business after approvals. Successful automated fixtures do not prove that Meta has approved the portal. Do not enable public onboarding based only on an app’s Live mode or a marketing template’s approval.

Until these settings are ready, the UI explicitly says quick connect awaits the portal owner’s setup. It does not show a fake working connection button. Existing manual credentials and messaging continue to work.

### Existing-connection ownership migration

From `nextjs-app`, using server environment variables or a protected local env file:

```sh
node --env-file=/secure/server.env --import tsx scripts/seed-whatsapp-owners.ts
node --env-file=/secure/server.env --import tsx scripts/seed-whatsapp-owners.ts --apply
```

Dry-run is the default. The script prints counts only, rejects duplicate ownership, and never replaces another owner. `bpl_whatsappAccountOwners` and integration session/secret documents remain inaccessible to all client SDKs under the existing deny-by-default Firestore rules.

## Reliability and costs

Cloud API does not require an active WhatsApp Web browser session. System user authorization can outlive a portal login, but permissions can be revoked and a configured token may expire. Coexistence has additional Business app/device activity and eligibility requirements. A health check reports the current Meta token/phone authorization, not guaranteed message delivery or removal of the 24-hour reply rule.

The current free Render service can sleep after inactivity, delaying webhook handling. An always-running host is needed for CRM-like availability. This change does not upgrade hosting, enable billing, add a paid BSP, send customer messages, or automatically retry an ambiguous message send. Existing send idempotency and Meta delivery receipts remain in use.

For large Business app history imports, configure a durable callback ingestion queue and asynchronous processing before offering synchronization at high volume. The current bounded receiver stores supported events idempotently; Meta sync acceptance is not reported as completed import. If a one-time sync request is ambiguous, its recorded attempt requires administrator review rather than automatic replay. Meta requires synchronization initiation within 24 hours of Coexistence onboarding.

## Official references verified during implementation

- [Embedded Signup implementation](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation)
- [Embedded Signup v4 and advanced access](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-4)
- [Tech Provider onboarding and business-token exchange](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider)
- [WhatsApp Business app onboarding / Coexistence](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users)
- [Access token types](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens)
- [Render free hosting limitations](https://render.com/docs/free)
