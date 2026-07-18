// Native Google sign-in facade over the native capability seam (nativeProvider.ts).
//
// Google rejects OAuth inside an embedded WebView (403 disallowed_useragent), so a native shell runs
// the auth-code + PKCE flow in the SYSTEM browser and hands the id_token to Firebase — same end state
// as the web popup. CE ships the web no-op provider (`canUseNativeGoogleSignIn` → false, so firebase.ts
// falls back to the popup); an EE/native build registers the @livx.cc/native-kit-backed implementation.
import type { Auth } from 'firebase/auth';
import { getNativeProvider } from './nativeProvider';

/** True only inside a native shell with a configured native Google OAuth client. */
export function canUseNativeGoogleSignIn(): Promise<boolean> {
  return getNativeProvider().canUseNativeGoogleSignIn();
}

/** Run the native Google sign-in flow against the given Firebase Auth. Throws on failure. */
export function signInWithGoogleNative(auth: Auth): Promise<void> {
  return getNativeProvider().signInWithGoogleNative(auth);
}
