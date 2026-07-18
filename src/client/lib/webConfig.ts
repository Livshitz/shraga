// Runtime web-config injected by the server into index.html (window.__SHRAGA_WEB_CONFIG__),
// read SYNCHRONOUSLY here — the inline script runs before this bundle, so the global is present at
// module-eval. Lets a self-hosted deploy configure Firebase via server env with no client rebuild.
// Falls back to the build-time VITE_ values so from-source builds keep working.

export interface WebConfig {
  firebase?: Record<string, unknown>;
  googleIosOAuthClientId?: string;
}

export const webConfig: WebConfig =
  (typeof window !== 'undefined' && (window as unknown as { __SHRAGA_WEB_CONFIG__?: WebConfig }).__SHRAGA_WEB_CONFIG__) || {};
