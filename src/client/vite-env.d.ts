/// <reference types="vite/client" />

/**
 * The shraga version the CLIENT BUNDLE was built from, stamped by vite at build time.
 * Compared against the server's `/api/version` at runtime — a mismatch means `dist/client` is
 * stale relative to the running server, which fails SILENTLY (a client written against an older
 * API shape just discards the response). See the version-skew banner in Sidebar.
 */
declare const __SHRAGA_CLIENT_VERSION__: string;
