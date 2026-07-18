import { describe, it, expect } from 'bun:test';
import { buildWebConfig, injectShellConfig } from '../spa-shell.ts';

const HEAD_HTML = '<html><head><title>Shraga</title></head><body><div id="root"></div></body></html>';

describe('buildWebConfig', () => {
  it('reads the clean env names', () => {
    const cfg = buildWebConfig({
      FIREBASE_WEB_CONFIG: '{"apiKey":"demo","projectId":"y"}',
      GOOGLE_IOS_OAUTH_CLIENT_ID: 'ios-123',
    } as NodeJS.ProcessEnv);
    expect(cfg.firebase).toEqual({ apiKey: 'demo', projectId: 'y' });
    expect(cfg.googleIosOAuthClientId).toBe('ios-123');
  });

  it('falls back to the VITE_ names', () => {
    const cfg = buildWebConfig({
      VITE_FIREBASE_CONFIG_PROD: '{"apiKey":"vite"}',
      VITE_GOOGLE_IOS_OAUTH_CLIENT_ID: 'ios-vite',
    } as NodeJS.ProcessEnv);
    expect(cfg.firebase).toEqual({ apiKey: 'vite' });
    expect(cfg.googleIosOAuthClientId).toBe('ios-vite');
  });

  it('prefers the clean name over the VITE_ fallback', () => {
    const cfg = buildWebConfig({
      FIREBASE_WEB_CONFIG: '{"apiKey":"clean"}',
      VITE_FIREBASE_CONFIG_PROD: '{"apiKey":"vite"}',
    } as NodeJS.ProcessEnv);
    expect(cfg.firebase).toEqual({ apiKey: 'clean' });
  });

  it('returns an empty config when nothing is set', () => {
    expect(buildWebConfig({} as NodeJS.ProcessEnv)).toEqual({});
  });

  it('omits firebase on empty-object or invalid JSON (no throw)', () => {
    expect(buildWebConfig({ FIREBASE_WEB_CONFIG: '{}' } as NodeJS.ProcessEnv)).toEqual({});
    expect(buildWebConfig({ FIREBASE_WEB_CONFIG: 'not json' } as NodeJS.ProcessEnv)).toEqual({});
  });
});

describe('injectShellConfig', () => {
  it('injects the global into <head> before </head>', () => {
    const out = injectShellConfig(HEAD_HTML, { firebase: { apiKey: 'demo' } });
    expect(out).toContain('<script>window.__SHRAGA_WEB_CONFIG__ = {"firebase":{"apiKey":"demo"}};</script></head>');
    // still before the app bundle / body
    expect(out.indexOf('__SHRAGA_WEB_CONFIG__')).toBeLessThan(out.indexOf('<body>'));
  });

  it('injects an empty object when config is absent', () => {
    const out = injectShellConfig(HEAD_HTML, {});
    expect(out).toContain('window.__SHRAGA_WEB_CONFIG__ = {};');
    expect(out).not.toContain('apiKey');
  });

  it('prepends when there is no </head>', () => {
    const out = injectShellConfig('<div id="root"></div>', { firebase: { apiKey: 'x' } });
    expect(out.startsWith('<script>window.__SHRAGA_WEB_CONFIG__')).toBe(true);
    expect(out).toContain('<div id="root"></div>');
  });

  it('cannot break out of the script when a value contains </script>', () => {
    const out = injectShellConfig(HEAD_HTML, { firebase: { evil: '</script><script>alert(1)</script>' } });
    // the raw closing tag must be escaped, so no literal </script> from the value survives
    expect(out).not.toContain('</script><script>alert(1)');
    expect(out).toContain('\\u003c/script>');
  });
});
