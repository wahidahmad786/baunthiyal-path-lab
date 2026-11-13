'use client';
import { getApps, initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';

export const previewOnly = process.env.NEXT_PUBLIC_UI_PREVIEW === 'true';
export const clientAuthConfigured = !!process.env.NEXT_PUBLIC_FIREBASE_API_KEY;

export function labClientAuth() {
  const app =
    getApps().find((a) => a.name === 'bpl-client') ||
    initializeApp(
      {
        apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
        authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
        projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
      },
      'bpl-client',
    );
  return getAuth(app);
}

export function signInError(error: unknown): string {
  const code = (error as { code?: string })?.code;
  switch (code) {
    case 'auth/popup-blocked':
      return 'Allow pop-ups for this site, then choose Continue with Google again.';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return 'Google sign-in was cancelled. Choose Continue with Google to try again.';
    case 'auth/unauthorized-domain':
      return 'This website domain needs to be authorized in Firebase Authentication settings.';
    case 'auth/operation-not-allowed':
      return 'This sign-in provider needs to be enabled in Firebase Authentication.';
    case 'auth/network-request-failed':
      return 'Unable to reach Google sign-in. Check your connection and try again.';
    case 'auth/account-exists-with-different-credential':
      return 'This email uses another sign-in method. Sign in with your email and password first.';
    default:
      return error instanceof Error && !code
        ? error.message
        : 'Unable to sign in. Check your credentials and administrator access.';
  }
}
