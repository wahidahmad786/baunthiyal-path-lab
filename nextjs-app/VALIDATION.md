# Validation — 11 November 2026

- `npm test`: **12 passed**, covering consent exclusions across every audience, visit/history/group/manual filters, offer eligibility, paise calculations, invalid offer rejection, phone normalization, placeholders, delivery state ordering, and ROI.
- `npm run test:integration`: **14 passed**, against isolated `demo-bpl` Firebase Auth/Firestore emulators. Includes an actual local Next.js production HTTP server with authenticated sessions, private API access checks, origin enforcement, registration consent defaults, real catalog/offer records, public booking privacy and deduplication, consent verification boundary, discounted job cards, duplicate/overpaid payments, PDF receipts, Excel/PDF exports, unsigned-webhook/worker rejection, signed STOP replay handling, concurrent Offer IDs, opt-out targeting, early/out-of-order receipts, queue-time withdrawal, and analytics from stored records.
- `npm run build`: **passed**, including Next.js production compilation and TypeScript checking.
- `npm run typecheck`: **passed**.
- `npm audit --omit=dev`: **0 known production dependency vulnerabilities** at validation time.

The Meta API is mocked only inside isolated tests. The application has no simulated-message or fake-record mode. Emulator tests used no production credentials or patient data; real-cloud setup checks are described separately below. No promotional messages were sent.

Browser/visual QA remains unverified: the managed browser-control tool was unavailable. The original application was absent, so existing portal integration, regression checks, production deployment, scheduler operation, real Meta template approval, and live delivery remain unverified. See INTEGRATION.md for the merge boundary and README.md for configuration and operating bounds.

Setup automation also checks secret generation without disclosure or rotation, restrictive file permissions, scheduler dry-run behavior and target validation. The authenticated setup API was tested against actual emulator services. Firebase authorization and connectivity have since been verified; public backend hosting and Cloud Scheduler remain unprovisioned under the chosen Spark plan, and Meta credentials remain absent.

Real-cloud checks: project-number/ID match verified; dedicated lab web app registered; email/password Auth enabled and Admin SDK read verified; existing Standard Firestore in Mumbai read/write verified using a genuine setup-status record; direct-client-deny rules validated and deployed; scoped lab administrator provisioned without issuing or sending a password. Spark/free billing preference preserved. No live WhatsApp sending or patient data migration was performed.
