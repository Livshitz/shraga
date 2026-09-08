/**
 * The shraga version this client bundle was built from (stamped by vite's `define`).
 * Falls back to 'dev' wherever the define is absent (tests, an embedder's own vite config), which
 * disables the skew check rather than reporting a false mismatch.
 */
export const CLIENT_BUILD_VERSION: string =
  typeof __SHRAGA_CLIENT_VERSION__ === 'string' ? __SHRAGA_CLIENT_VERSION__ : 'dev';
