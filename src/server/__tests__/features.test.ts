import { describe, test, expect } from 'bun:test';
import {
  registerFeature,
  mountFeatures,
  collectFeatureFlags,
  collectSidecarRoutes,
  collectAlwaysMcp,
  resumeFeatureSession,
  type FeatureContext,
} from '../features.ts';

// The registry is module-level and has no reset (adding a test-only reset would be new public
// surface on a seam that add-ons depend on). So: every feature name here is unique, and every
// assertion is written to be additive/order-independent — never "the registry contains exactly N".
const ctx = () => ({ app: {}, requireAuth: () => {}, broadcast: () => {}, passive: false }) as unknown as FeatureContext;

describe('server feature seam', () => {
  test('the CORE registers nothing — a bare collect is empty', () => {
    // Must run before anything else in this file registers. Guards the invariant that the core
    // never names an add-on concept — importing the seam alone contributes zero.
    expect(collectFeatureFlags()).toEqual({});
    expect(collectSidecarRoutes()).toEqual({});
    expect(collectAlwaysMcp()).toEqual(new Set());
  });

  test('a registered feature is mounted and receives the live context', () => {
    let got: FeatureContext | null = null as FeatureContext | null;
    registerFeature({ name: 'seam-mount', register: (c) => { got = c; } });
    const c = ctx();
    mountFeatures(c);
    expect(got).toBe(c);
  });

  test('registration is idempotent by name — the first registration wins', () => {
    let first = 0, second = 0;
    registerFeature({ name: 'seam-dup', register: () => { first++; } });
    registerFeature({ name: 'seam-dup', register: () => { second++; } });
    mountFeatures(ctx());
    expect(first).toBe(1);
    expect(second).toBe(0);
  });

  // Documented contract: "Throwing is contained (logged, other features still load)."
  test('a throwing feature does not prevent later features from mounting', () => {
    let laterMounted = false;
    registerFeature({ name: 'seam-throws', register: () => { throw new Error('boom'); } });
    registerFeature({ name: 'seam-after-throw', register: () => { laterMounted = true; } });
    expect(() => mountFeatures(ctx())).not.toThrow();
    expect(laterMounted).toBe(true);
  });

  test('static flags are contributed to /api/features', () => {
    registerFeature({ name: 'seam-static-flags', register: () => {}, flags: { seamStatic: true } });
    expect(collectFeatureFlags().seamStatic).toBe(true);
  });

  // The getter form is what lets an add-on honor env per-request rather than at import time.
  test('getter flags are evaluated per call, not frozen at registration', () => {
    let on = false;
    registerFeature({ name: 'seam-dyn-flags', register: () => {}, flags: () => ({ seamDyn: on }) });
    expect(collectFeatureFlags().seamDyn).toBe(false);
    on = true;
    expect(collectFeatureFlags().seamDyn).toBe(true);
  });

  test('sidecar routes (prefix -> port) are merged for the core WS proxy table', () => {
    registerFeature({ name: 'seam-sidecar', register: () => {}, sidecarRoutes: { 'seam-x': 41999 } });
    expect(collectSidecarRoutes()['seam-x']).toBe(41999);
  });

  test('resumeFeatureSession routes to the matching feature by channel name', async () => {
    const seen: unknown[] = [];
    registerFeature({
      name: 'seam-resume',
      register: () => {},
      resumeSession: (s, p) => { seen.push([s, p]); },
    });
    expect(resumeFeatureSession('seam-resume', { id: 's1' }, 'continue')).toBe(true);
    expect(seen).toEqual([[{ id: 's1' }, 'continue']]);
  });

  test('resumeFeatureSession returns false for an unknown channel (core falls back)', () => {
    expect(resumeFeatureSession('seam-does-not-exist', {}, 'p')).toBe(false);
  });

  test('resumeFeatureSession returns false when the feature has no resumeSession hook', () => {
    registerFeature({ name: 'seam-no-resume', register: () => {} });
    expect(resumeFeatureSession('seam-no-resume', {}, 'p')).toBe(false);
  });

  // A rejected resume must not surface as an unhandled rejection and kill the process.
  test('a rejecting resumeSession is contained', async () => {
    registerFeature({
      name: 'seam-resume-rejects',
      register: () => {},
      resumeSession: () => Promise.reject(new Error('nope')),
    });
    expect(resumeFeatureSession('seam-resume-rejects', {}, 'p')).toBe(true);
    await new Promise((r) => setTimeout(r, 10)); // let the rejection settle
  });
});
