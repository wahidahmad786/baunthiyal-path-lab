# Railway deployment

This repository contains three separate projects. Deploy `nextjs-app` for the full dashboard and Node APIs. The root directory intentionally has no npm package.

## Build configuration

The repository-root `Dockerfile` selects `nextjs-app` by default and builds the same Node 24 standalone application as the existing Render service. Railway detects a root `Dockerfile` automatically unless the service has a custom builder/path override.

Use one of these consistent configurations:

| Setting | Repository-root build | App-directory build |
| --- | --- | --- |
| Root Directory | `/` or empty | `/nextjs-app` |
| Dockerfile | `Dockerfile` | `Dockerfile` inside that directory |
| `APP_SOURCE` | `nextjs-app` (default) | `.` (default) |
| Custom Build Command | empty; Dockerfile builds it | empty; Dockerfile builds it |
| Custom Start Command | empty; image starts `node server.js` | empty; image starts `node server.js` |
| Healthcheck Path | `/api/health` | `/api/health` |

Remove stale `RAILWAY_DOCKERFILE_PATH`, `APP_SOURCE`, custom builder or command overrides if they conflict with the chosen configuration. Railway's public networking target port must match the application's runtime `PORT`; the image defaults to 8080 and binds to `0.0.0.0`.

No new service, database, volume, paid plan, domain or public callback is automatically provisioned by these repository files.

## Variables and sign-in

Set these **public Firebase web values before the Docker build** (they are declared build arguments):

- `NEXT_PUBLIC_FIREBASE_API_KEY`
- `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
- `NEXT_PUBLIC_FIREBASE_PROJECT_ID`

Configure runtime values through Railway Variables, never through a committed environment file:

- `APP_URL`: the exact HTTPS Railway/custom-domain origin.
- `FIREBASE_PROJECT_ID`: the existing Firebase project ID.
- `LAB_PHONE`: the lab's contact number.
- `WHATSAPP_CONNECTION_ENCRYPTION_KEY`: preserve the existing key when using existing connections.
- `WHATSAPP_SERVICE_ACCOUNT_JSON`: the existing dedicated datastore-only service identity, as a private variable.
- `WHATSAPP_GRAPH_VERSION`: preserve the configured version where applicable.

Add the Railway hostname to Firebase Authentication → Settings → Authorized domains for Google login. A successful build does not validate Firebase credentials, Google redirect permissions or WhatsApp sessions.

For Meta webhooks, first deploy and verify the Railway receiver, then deliberately update the callback host/subscription and `WHATSAPP_WEBHOOK_BASE_URL` when moving messaging to Railway. Do not change an existing working Meta subscription before the new host is ready. Existing Meta and Embedded Signup settings remain necessary for those features; see `.env.example` and `RENDER.md` for the shared application configuration.

Personal/mobile WhatsApp credentials are stored encrypted in Firestore and require the same encryption key to recover. Only one server can own each linked socket at a time. Running Render and Railway against the same linked account uses that ownership lease; do not expect both hosts to control the same personal WhatsApp socket simultaneously. Choose the intended messaging host before moving active sessions.

## Diagnose a failed build

Open the failed deployment's Build Logs and find the first actual error. The notification email only reports failure.

- No application/package detected: verify Root Directory or root Dockerfile detection.
- `COPY` / missing `package.json`: verify Docker build context, Dockerfile path and `APP_SOURCE` together.
- Unsupported Node version: use the supplied Node 24 Docker image.
- `postinstall` cannot find `scripts/patch-signal-logs.mjs`: use the complete Dockerfile; it copies the required script before `npm ci`.
- A healthy build followed by a startup/healthcheck failure: inspect Deploy Logs, the start-command override, target port and runtime variables.

Build errors, startup errors and account configuration errors need separate evidence. Do not paste tokens, private keys, authorization codes or secret-variable values into public logs or chat.
