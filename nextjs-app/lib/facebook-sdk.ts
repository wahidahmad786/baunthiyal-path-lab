'use client';
type FacebookSdk = {
  init(options: Record<string, unknown>): void;
  login(
    callback: (response: { authResponse?: { code?: string } }) => void,
    options: Record<string, unknown>,
  ): void;
};
declare global {
  interface Window {
    FB?: FacebookSdk;
  }
}
let loading: Promise<FacebookSdk> | null = null;
export function loadFacebookSdk(appId: string, version: string): Promise<FacebookSdk> {
  if (!loading)
    loading = new Promise<FacebookSdk>((resolve, reject) => {
      const initialize = () => {
        if (!window.FB)
          return reject(
            new Error('Meta login did not load. Allow Facebook in this browser and try again.'),
          );
        window.FB.init({ appId, version, cookie: false, autoLogAppEvents: false, xfbml: false });
        resolve(window.FB);
      };
      if (window.FB) {
        initialize();
        return;
      }
      const script = document.createElement('script');
      script.id = 'bpl-meta-login-sdk';
      script.async = true;
      script.defer = true;
      script.src = 'https://connect.facebook.net/en_US/sdk.js';
      script.crossOrigin = 'anonymous';
      const timeout = setTimeout(() => {
        script.remove();
        reject(new Error('Meta login timed out. Check your connection and retry.'));
      }, 20000);
      script.onload = () => {
        clearTimeout(timeout);
        initialize();
      };
      script.onerror = () => {
        clearTimeout(timeout);
        script.remove();
        reject(new Error('Meta login could not load. Check browser blocking settings and retry.'));
      };
      document.head.appendChild(script);
    }).catch((error) => {
      loading = null;
      throw error;
    });
  return loading!;
}
