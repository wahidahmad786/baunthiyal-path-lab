# Baunthiyal Path Lab — Firebase-connected setup preview

This private static UI displays the verified Firebase setup snapshot for project automotive-web-application (43361196855). Its Firestore, email/password Auth and scoped lab-admin claim were provisioned and verified in the real project while keeping the Spark plan. No patient data or campaign delivery is simulated.

The login page uses Firebase public web-app configuration to support an owner-requested password setup/reset email. Dashboard sign-in and API-backed operations remain disabled until a real Node.js backend is hosted. No mail is sent automatically by the agent.

Build: npm ci && NEXT_PUBLIC_UI_PREVIEW=true npx next build --webpack. Also supply the three public NEXT_PUBLIC_FIREBASE_* web-app fields at build time, obtained from the registered BPL Firebase app. These browser configuration fields are public by design; no server credential, OAuth refresh token, password or Meta key is included in the site.

The complete credential-free server source and deployment/setup guide are available under public/downloads/baunthiyal-path-lab-source.zip. Firebase App Hosting and new Firebase Storage provisioning were not activated because the owner selected Spark/free. Existing automotive app and Hosting site were retained.
