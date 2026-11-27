# Netlify entry URL

`bpllab.netlify.app` is a navigation entry point for the existing full application at `https://baunthiyal-path-lab.onrender.com`.

The root `netlify.toml` publishes only `netlify-entry/`, which contains a forced temporary redirect for every path. For example, `/login` opens the real Node application's `/login` page. The branded HTML page is a fallback if redirects are not processed; it opens the same real application and is not a simulated dashboard.

The address bar changes to the application host. Netlify does not run the application's backend, store private patient records, or create a second WhatsApp socket session in this setup. The existing Google sign-in domain, server origin checks, encrypted credentials, callback and hosting plan remain in use. Ordinary serverless requests are not used to host the persistent personal WhatsApp linked-device socket.

The temporary HTTP 302 allows a later deliberate hosting migration. Keep the destination pointed at the verified application host; do not replace it with another Netlify entry URL or create a redirect loop.

Expected Netlify settings, supplied by the root configuration file:

- Base directory: `netlify-entry`
- Build command: empty
- Publish directory: `.` relative to that base
- Configuration file: `/netlify.toml`

After GitHub deploys the configuration, opening the Netlify root should return a redirect to the application, and following it should return the branded application. Check `/login`, `/privacy-policy` and a nested path as well. The old "Published" status alone does not establish that the app was being served.

If the site does not deploy this repository's latest `main` commit, confirm the connected repository, production branch, root configuration location and whether automatic deploys are enabled in Netlify. No Netlify access token is required in source code.
