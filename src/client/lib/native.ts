// Push + native-readiness facade over the native capability seam (nativeProvider.ts). CE ships the
// web no-op provider, so every push path here is inert in a plain browser; an EE/native build swaps
// in a @livx.cc/native-kit-backed provider and the same calls light up. `isVisible` /
// `onVisibilityChange` are pure Page-Visibility API — not native — so they stay implemented here.
import { getNativeProvider, type NativePush, type PushMessage, type PushToken } from './nativeProvider';

export type { PushMessage, PushToken };

/** The push module (delegates to the active native provider; 'none' capability on web). */
export const push: NativePush = {
  get capability() {
    return getNativeProvider().push.capability;
  },
  register: () => getNativeProvider().push.register(),
  requestPermission: () => getNativeProvider().push.requestPermission(),
  onTap: (cb) => getNativeProvider().push.onTap(cb),
  onMessage: (cb) => getNativeProvider().push.onMessage(cb),
};

/**
 * Run the one-time native-shell handshake and resolve whether we're inside a native shell.
 * Idempotent and never rejects — on web it resolves `false`.
 */
export function initNative(): Promise<boolean> {
  return getNativeProvider().initNative();
}

/** Current page visibility (Page Visibility API). True when the tab/app is foregrounded. */
export function isVisible(): boolean {
  return typeof document === 'undefined' ? true : !document.hidden;
}

/** Subscribe to foreground/background changes. Returns an unsubscribe fn. */
export function onVisibilityChange(cb: (visible: boolean) => void): () => void {
  if (typeof document === 'undefined') return () => {};
  const handler = () => cb(!document.hidden);
  document.addEventListener('visibilitychange', handler);
  return () => document.removeEventListener('visibilitychange', handler);
}
