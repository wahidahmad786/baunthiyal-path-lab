# Render deployment

Use the existing `baunthiyal-path-lab` Docker web service and its private GitHub repository. Keep its free instance plan.

## Build settings

- Branch: `main`
- Root directory: empty
- Dockerfile path: `nextjs-app/Dockerfile`
- Docker build context directory: `.`
- Environment/build argument `APP_SOURCE`: `nextjs-app`
- Optional health-check path: `/api/health`

The Dockerfile also supports an app-only build context (`nextjs-app`) with `APP_SOURCE=.`. Match the context and this argument; do not mix the two configurations. Render passes configured environment variables to declared Docker build arguments. Public Firebase web configuration is needed at build time and at runtime.

## Required runtime configuration

Set `APP_URL` to the exact HTTPS Render URL, `FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` and `NEXT_PUBLIC_FIREBASE_PROJECT_ID`. Add the Render hostname to Firebase Authentication's authorized domains. Set `LAB_PHONE` to the lab contact number.

For existing account-scoped WhatsApp connections, preserve the existing `WHATSAPP_CONNECTION_ENCRYPTION_KEY`. Configure the dedicated datastore service identity as `WHATSAPP_SERVICE_ACCOUNT_JSON` through a runtime secret. For the owner's current callback repair request, set `WHATSAPP_WEBHOOK_BASE_URL` to the exact HTTPS Render origin and `WHATSAPP_WEBHOOK_PUBLIC_READY=true`. The receiver is `/webhook/<account-uid>`; the original separate callback Site remains private and is no longer the Meta callback target. Do not commit the key, service-account JSON or any Meta token.

The account-scoped APIs use verified Firebase user tokens and the same Firestore workspace records as the hosted portal. Google sign-in can complete even while the separate administrator session backend is not configured. Administrator session creation still requires configured server Firebase credentials and an authorized administrator claim. Campaign dispatch and other global admin features remain unavailable until that backend is configured; this deployment does not simulate sending or migrate account records into global admin collections.

For a future full administrator backend, configure the separate server settings in `.env.example`, review service-identity permissions and data integration, then test that backend before enabling campaign dispatch. Account record management does not require a public callback or a billing upgrade; receiving Meta events requires the signed public receiver.
