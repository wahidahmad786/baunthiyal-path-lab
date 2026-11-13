# Meta public application URLs

The existing Render application serves these pages without sign-in:

- Privacy policy: https://baunthiyal-path-lab.onrender.com/privacy-policy
- Terms of service: https://baunthiyal-path-lab.onrender.com/terms
- User data deletion instructions: https://baunthiyal-path-lab.onrender.com/data-deletion
- Contact: https://baunthiyal-path-lab.onrender.com/contact

They are linked in the public homepage/login footer, account sidebar and WhatsApp Integration help. The deletion URL provides the actual manual request procedure through the lab's contact number; it is not an automated Meta deletion callback. Do not configure it as a signed webhook endpoint.

The Meta app owner must enter the URLs in the corresponding app settings and complete any review, business verification or permissions requirements shown by Meta. Publishing the pages does not by itself change Meta's Development/Live mode or approve templates.

## Token and template diagnosis

An earlier read-only Meta audit on 13 November 2026 returned error code **190** for the token saved at that time. After the owner's token replacement, a later audit confirmed a valid token with WhatsApp messaging and management permissions. No promotional message was sent. Meta app Live mode still requires an authorized access token; changing mode does not revive an expired/revoked token. Generate replacements through the owner's Meta Business settings and save them only in the authenticated WhatsApp Integration page.

The campaign dropdown uses real Meta template records. Approved marketing templates with fixed text headers or image headers are supported. Branding and STOP instructions can be in approved headers, body or footer. Unsupported approved templates are listed with reasons; pending and rejected counts remain distinct. No placeholder is presented as a Meta-approved template.

## Banner persistence

Signed-in users can select a PNG/JPEG up to 5 MB. The browser re-encodes the image, removes original metadata and bounds it to 1600 pixels and 600 KB. The optimized image is stored in the user's Firestore workspace through an authenticated server API using the existing datastore service identity. A blob preview stays valid between wizard steps; reopening a stored banner retrieves its bytes through the same authenticated API.

Direct client access to the new banner collection remains denied by the existing default-deny rules. The server derives the owner UID from verified Firebase identity; it does not accept an owner UID from the upload. No Storage bucket, paid Firebase upgrade, local Render filesystem persistence or public asset endpoint was introduced.

The full administrator sender can upload a stored banner to Meta's media endpoint and send its returned media ID for an approved image-header template. Global campaign dispatch remains subject to its existing backend, consent, template, scheduling and callback checks. The original separate callback Site remains private. For the owner's later callback repair request, the public Render app now exposes a token/signature-checked `/webhook/<account-uid>` receiver; the integration page provides its exact URL and an authenticated action to copy the saved verification token.

## Verification

The production build and 31 unit tests passed. Seven banner/template emulator tests checked persistence, recovery, account isolation, input limits, safe provider errors and multipart media payloads. Fifteen existing backend integration tests checked authentication, offers, booking, consent, payments, reports and queued opt-outs. Headless Chromium verified that the banner input works with the account APIs while the global sender is inactive, that previews survive wizard step changes, and that replacing a saved banner completes. The browser also resized a 3000×2000 test image to a valid 1600×1067 JPEG. Browser tests used explicit test-only identity/API fixtures; emulator tests used only `demo-bpl`. No live customer message was sent.
