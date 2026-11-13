# Connected API versus available replies

On 13 November 2026 the current saved token was confirmed valid, with both `whatsapp_business_messaging` and `whatsapp_business_management` permissions. The Meta app callback was active, but the WhatsApp Business Account had subscribed only the default Meta DevX consumer. The requested application was added to the WABA subscriptions; provider readback confirmed it was present and the existing DevX subscription was preserved. No customer message was sent by this repair.

The API phone is a Meta **Test Number**, separate from the lab's mobile WhatsApp number. Test numbers support the recipients added and verified in Meta's test setup. Changing a phone field in the portal does not register a different number with Meta. To use the lab's real number while retaining its WhatsApp Business mobile app, complete supported Coexistence onboarding and then save its actual Meta IDs.

## Why “Hii” can be blocked

Credential verification, app publication, template approval and callback activation do not open the 24-hour free-text reply window for a customer. That window requires an actual incoming customer message to the connected API phone. The portal never invents such an event or imports existing mobile-app chat history.

The inbox now shows the actual API sender, whether it is a test sender, and a specific per-customer reply block:

- `CONNECTION_REQUIRED`: API setup needs attention.
- `CUSTOMER_MESSAGE_REQUIRED`: no incoming API message for this sender/customer yet.
- `REPLY_WINDOW_EXPIRED`: the customer's last incoming API message is outside the reply window.

The API send button remains protected while the window is closed. A typed draft can be opened in the ordinary WhatsApp app through an explicit link; that does not record a portal/API send. Once a genuine signed incoming event opens the reply window, API replies become available.

## Testing with a Meta test number

Use Meta API Setup to add/verify the intended test recipient and start with an approved test template through Meta's controls. Have that recipient reply to the API number, then refresh the portal or wait for its 15-second refresh. New incoming events are recorded; past test sends and mobile-app history are not retroactively imported. Outside the reply window, API initiation requires an approved template instead of arbitrary text.

The three approved marketing templates found during the audit were generic Jaspers Market samples. They were not compatible lab campaign templates: required lab identity, opt-out wording or attribution variables were absent, and one used an unsupported carousel. Approval by Meta alone does not make those samples suitable for a Baunthiyal Path Lab campaign. Campaign wording must match its actual approved template; it is not silently changed by the sender.

## Verification

36 unit tests, seven chat/security emulator tests and a production build passed. Backend checks prove that a verified callback without incoming customer activity cannot send free text, while a signed inbound event opens the window. Browser fixtures check the visible test sender, disabled API send button, usable manual draft link and the transition to an available reply after an incoming event. Browser/provider fixtures are test-only; real delivery and read statuses still require actual Meta receipts.
