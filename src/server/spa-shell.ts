import { readFileSync } from 'fs';

// Runtime web-config injected into the SPA shell so self-hosters (and the npm consumer) configure
// Firebase via SERVER env with NO client rebuild. The client reads window.__SHRAGA_WEB_CONFIG__
// first, then falls back to the build-time VITE_ values, so from-source builds keep working.

export interface SpaWebConfig {
  firebase?: Record<string, unknown>;
  googleIosOAuthClientId?: string;
}

/** Build the runtime web-config from server env. Clean names win, VITE_ names are the fallback. */
export function buildWebConfig(env: NodeJS.ProcessEnv = process.env): SpaWebConfig {
  const config: SpaWebConfig = {};

  const firebaseRaw = env.FIREBASE_WEB_CONFIG ?? env.VITE_FIREBASE_CONFIG_PROD;
  if (firebaseRaw) {
    try {
      const parsed = JSON.parse(firebaseRaw);
      if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) config.firebase = parsed;
    } catch (err) {
      console.warn('[spa-shell] invalid FIREBASE_WEB_CONFIG/VITE_FIREBASE_CONFIG_PROD JSON:', (err as Error).message);
    }
  }

  const iosClientId = env.GOOGLE_IOS_OAUTH_CLIENT_ID ?? env.VITE_GOOGLE_IOS_OAUTH_CLIENT_ID;
  if (iosClientId) config.googleIosOAuthClientId = iosClientId;

  return config;
}

/** Inject the config as an inline global into <head> (before the app bundle). Pure + escape-safe. */
export function injectShellConfig(html: string, config: SpaWebConfig): string {
  // Escape `<` so a `</script>` inside any value cannot break out of the inline script.
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  const tag = `<script>window.__SHRAGA_WEB_CONFIG__ = ${json};</script>`;
  return html.includes('</head>') ? html.replace('</head>', `${tag}</head>`) : `${tag}${html}`;
}

// Cache the injected shell per index.html path — env is fixed for the process lifetime.
const shellCache = new Map<string, string>();

/** Read index.html once, inject the runtime web-config, and cache the result. */
export function getSpaShell(indexHtmlPath: string): string {
  let shell = shellCache.get(indexHtmlPath);
  if (shell === undefined) {
    shell = injectShellConfig(readFileSync(indexHtmlPath, 'utf8'), buildWebConfig());
    shellCache.set(indexHtmlPath, shell);
  }
  return shell;
}
