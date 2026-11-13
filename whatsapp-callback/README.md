# Baunthiyal Path Lab WhatsApp callback

This endpoint serves no patient or message-read routes. Health responses contain only application status. Callback GET requests require the private verification token; POST requests require the original Meta HMAC signature and matching phone-number ID before any event is recorded. Customer records and conversations are never returned from the receiver.

The receiver uses a dedicated datastore-only service identity through secret runtime configuration. Credentials are outside source. The portal remains owner-private. This new receiver is initially owner-private too; enabling unauthenticated Meta delivery requires an explicit request to change this receiver’s audience to public.

Build with `node build.mjs`. Required runtime values: FIREBASE_PROJECT_ID, WHATSAPP_CONNECTION_ENCRYPTION_KEY, WHATSAPP_SERVICE_ACCOUNT_JSON.
