import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { migrateLegacyStorageKeys } from '../storage.ts';

/**
 * The migration enumerates keys via `Object.keys(localStorage)`, so the fake must mirror the real
 * Storage shape: keys are ENUMERABLE own properties, methods are not. A Map-backed stub with
 * enumerable methods would make `Object.keys` return "getItem"/"setItem" and the test would prove
 * nothing about the real browser behaviour.
 */
function makeStorage(seed: Record<string, string> = {}) {
  const s = {} as Record<string, string> & Storage;
  const def = (name: string, fn: unknown) =>
    Object.defineProperty(s, name, { value: fn, enumerable: false, writable: true });
  def('getItem', (k: string) => (Object.prototype.hasOwnProperty.call(s, k) ? s[k] : null));
  def('setItem', (k: string, v: string) => { s[k] = String(v); });
  def('removeItem', (k: string) => { delete s[k]; });
  for (const [k, v] of Object.entries(seed)) s[k] = v;
  return s;
}

/** Own enumerable keys == what a real localStorage would enumerate. */
const keysOf = (s: object) => Object.keys(s).sort();

let original: PropertyDescriptor | undefined;

beforeEach(() => { original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'); });
afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original);
  else delete (globalThis as Record<string, unknown>).localStorage;
});

function install(seed: Record<string, string> = {}) {
  const s = makeStorage(seed);
  Object.defineProperty(globalThis, 'localStorage', { value: s, configurable: true, writable: true });
  return s;
}

describe('migrateLegacyStorageKeys (unclaw:* -> shraga:*)', () => {
  test('sanity: the fake enumerates like a real Storage (keys only, no methods)', () => {
    expect(keysOf(makeStorage({ 'a': '1' }))).toEqual(['a']);
  });

  test('renames a legacy key, preserving its value, and drops the old one', () => {
    const s = install({ 'unclaw:sidebar': 'collapsed' });
    migrateLegacyStorageKeys();
    expect(s.getItem('shraga:sidebar')).toBe('collapsed');
    expect(s.getItem('unclaw:sidebar')).toBeNull();
    expect(keysOf(s)).toEqual(['shraga:sidebar']);
  });

  test('covers dynamic suffixed keys (the reason it migrates by prefix, not a key list)', () => {
    const s = install({ 'unclaw:draft:abc-123': 'hello', 'unclaw:draft:def-456': 'world' });
    migrateLegacyStorageKeys();
    expect(s.getItem('shraga:draft:abc-123')).toBe('hello');
    expect(s.getItem('shraga:draft:def-456')).toBe('world');
    expect(keysOf(s)).toEqual(['shraga:draft:abc-123', 'shraga:draft:def-456']);
  });

  test('an existing canonical key WINS — a stale legacy value can never clobber newer state', () => {
    const s = install({ 'unclaw:sidebar': 'stale', 'shraga:sidebar': 'fresh' });
    migrateLegacyStorageKeys();
    expect(s.getItem('shraga:sidebar')).toBe('fresh');
    expect(s.getItem('unclaw:sidebar')).toBeNull(); // legacy still cleaned up
  });

  test('leaves unrelated keys untouched', () => {
    const s = install({ 'unclaw:x': '1', 'shraga:y': '2', 'theme': 'dark', 'other:z': '3' });
    migrateLegacyStorageKeys();
    expect(keysOf(s)).toEqual(['other:z', 'shraga:x', 'shraga:y', 'theme']);
    expect(s.getItem('theme')).toBe('dark');
  });

  test('re-running is a no-op (idempotent across reloads)', () => {
    const s = install({ 'unclaw:sidebar': 'collapsed' });
    migrateLegacyStorageKeys();
    const after = { ...s };
    migrateLegacyStorageKeys();
    migrateLegacyStorageKeys();
    expect({ ...s }).toEqual(after);
    expect(s.getItem('shraga:sidebar')).toBe('collapsed');
  });

  test('no legacy keys -> nothing changes', () => {
    const s = install({ 'shraga:sidebar': 'open' });
    migrateLegacyStorageKeys();
    expect(keysOf(s)).toEqual(['shraga:sidebar']);
  });

  // Intent guard, not an implementation restatement: `unclaw_auth_token` is a local-auth-only key
  // whose token format this server hard-rejects (`sha_` prefix, different secret). Migrating it
  // would seat a rejected token in the "logged in" slot instead of prompting a clean re-login.
  // This test exists so that a future reader "fixing the gap" fails loudly. See storage.ts.
  test('does NOT migrate the legacy unclaw_auth_token (deliberate — cross-format token)', () => {
    const s = install({ 'unclaw_auth_token': 'legacy-token-value' });
    migrateLegacyStorageKeys();
    expect(s.getItem('shraga_token')).toBeNull();
    expect(keysOf(s)).toEqual(['unclaw_auth_token']);
  });

  test('an empty-string legacy value survives (not treated as absent)', () => {
    const s = install({ 'unclaw:draft:1': '' });
    migrateLegacyStorageKeys();
    expect(s.getItem('shraga:draft:1')).toBe('');
  });

  // Boot-critical: main.tsx calls this before first render, so a throw here would white-screen
  // the whole app (private mode / storage disabled / quota).
  test('swallows a throwing storage instead of breaking boot', () => {
    const boom = {} as Storage;
    Object.defineProperty(boom, 'getItem', { value: () => { throw new Error('denied'); }, enumerable: false });
    Object.defineProperty(boom, 'setItem', { value: () => { throw new Error('denied'); }, enumerable: false });
    Object.defineProperty(boom, 'removeItem', { value: () => { throw new Error('denied'); }, enumerable: false });
    (boom as Record<string, unknown>)['unclaw:x'] = '1';
    Object.defineProperty(globalThis, 'localStorage', { value: boom, configurable: true, writable: true });
    expect(() => migrateLegacyStorageKeys()).not.toThrow();
  });

  test('throws nothing when localStorage is absent entirely (SSR/non-browser)', () => {
    delete (globalThis as Record<string, unknown>).localStorage;
    expect(() => migrateLegacyStorageKeys()).not.toThrow();
  });
});
