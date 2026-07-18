// The NATIVE capability seam — the imperative sibling of the client SLOTS seam (slots.tsx).
//
// CE core owns no native shell. Push, desktop-attention (Dock bounce/badge), and native Google
// OAuth all require a native runtime (@livx.cc/native-kit inside an appwrap shell), so that
// dependency + implementation live in the EE/native overlay, NOT here. CE ships the web NO-OP
// provider below and reads capabilities exclusively through `getNativeProvider()` — so the built CE
// bundle contains zero native-kit code, exactly like the empty client-slot set.
//
// An EE/native build fills the seam at its composition root (before first render):
//   registerNativeProvider(nativeKitProvider)   // main.ee.tsx
// consuming CE as a library. No CE file is shadowed; the provider is swapped at runtime, so every
// CE consumer (`usePush`, `useUnread`, `App`, `firebase`) keeps its imports and lights up natively.
import type { Auth } from 'firebase/auth';

/** A push message delivered to the app (foreground) or via a notification tap. */
export interface PushMessage {
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
}

/** The device push registration returned by `push.register()`. */
export interface PushToken {
  platform: string;
  token: string;
  topic?: string;
}

export type PushPermission = 'granted' | 'denied' | 'default';

/** Push surface consumed by `usePush`. `capability !== 'native'` ⇒ consumers skip every push path. */
export interface NativePush {
  capability: string;
  register(): Promise<PushToken>;
  requestPermission(): Promise<PushPermission>;
  onTap(cb: (m: PushMessage) => void): () => void;
  onMessage(cb: (m: PushMessage) => void): () => void;
}

/**
 * Everything the CE client needs from a native runtime. CE provides the web no-op default; the EE
 * overlay registers a @livx.cc/native-kit-backed implementation. Loose/local types only — never
 * import a native-kit type into the core, or the dependency leaks back across the seam.
 */
export interface NativeProvider {
  /** One-time native-shell handshake → true inside a native shell, false on web. Never rejects. */
  initNative(): Promise<boolean>;
  push: NativePush;
  /** One-time detection of the appwrap DESKTOP shell (Dock bounce/badge available). Never rejects. */
  initDesktopAttention(): Promise<boolean>;
  isDesktopShell(): boolean;
  requestDesktopAttention(blocking?: boolean): void;
  setDesktopBadge(count: number): void;
  /** True only inside a native shell with a configured native Google OAuth client. */
  canUseNativeGoogleSignIn(): Promise<boolean>;
  /** Run the native (system-browser) Google sign-in against the given Firebase Auth. */
  signInWithGoogleNative(auth: Auth): Promise<void>;
}

/** CE default: no native shell — every capability is an inert web no-op. */
const webProvider: NativeProvider = {
  initNative: () => Promise.resolve(false),
  push: {
    capability: 'none',
    register: () => Promise.reject(new Error('push unavailable on web')),
    requestPermission: () => Promise.resolve('denied'),
    onTap: () => () => {},
    onMessage: () => () => {},
  },
  initDesktopAttention: () => Promise.resolve(false),
  isDesktopShell: () => false,
  requestDesktopAttention: () => {},
  setDesktopBadge: () => {},
  canUseNativeGoogleSignIn: () => Promise.resolve(false),
  signInWithGoogleNative: () => Promise.reject(new Error('native Google sign-in unavailable on web')),
};

let active: NativeProvider = webProvider;

/** Fill the native seam (EE/native composition root). Last registration wins. */
export function registerNativeProvider(provider: NativeProvider): void {
  active = provider;
}

/** The active native provider — the CE web no-op unless an overlay registered one. */
export function getNativeProvider(): NativeProvider {
  return active;
}
