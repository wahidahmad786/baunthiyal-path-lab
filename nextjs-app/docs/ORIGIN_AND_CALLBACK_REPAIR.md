# Render origin and Meta callback repair

The reported `Request origin is not allowed` error was reproduced on the live Render app for connection, customer, catalog and banner POSTs. Render terminates HTTPS before forwarding requests to the Node server, so comparing the browser's HTTPS Origin directly to the internal request URL rejected legitimate requests.

All account mutation handlers now check the configured public `APP_URL` through the same helper. Foreign origins, missing/null origins and misleading forwarded-host headers remain rejected. Firebase verified-user authentication and workspace ownership checks are unchanged. Worker deployments without a configured public origin continue checking the actual request URL.

The current Meta callback target is `https://baunthiyal-path-lab.onrender.com/webhook/<account-uid>`. This is a receiver only: GET challenges require the saved verification token; POST events require Meta's raw-body HMAC signature and the connected phone-number ID. It exposes no patient, conversation or message-read endpoint. The original separately hosted callback Site remains private.

The authenticated integration page returns the account's exact callback URL. An explicit same-origin POST can copy that owner's saved verification token; access tokens and app secrets are never returned. A newly generated/entered verification token must be saved before the copy button can be used, preventing Meta from receiving an unsaved value.

The existing application credentials allow inspection of the requested Meta app's webhook subscriptions with an application access token. This is separate from the WhatsApp user/system-user access token, which returned code 190 during the audit. Configuring an app callback does not repair an expired messaging token or prove a WABA subscription, campaign sender or customer delivery.

Validation includes 33 unit tests, 17 account/chat emulator tests and 10 HTTP integration tests. The HTTP regression sends an authenticated public-HTTPS-origin request through an internal HTTP server, persists account connection/customer/catalog records, copies the stored verification token, and checks that foreign origins and unsigned callbacks remain blocked. A headless Chromium fixture checks callback URL copying and save-before-copy behavior. Test providers/identities are isolated; no live customer message was sent.
