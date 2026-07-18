import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged, type Auth, type User } from 'firebase/auth';
import { canUseNativeGoogleSignIn, signInWithGoogleNative } from './googleAuthNative';
import { webConfig } from './webConfig';

// Firebase is OPTIONAL — only initialized when a config is present (an optional add-on). This build
// ships with local auth and no Firebase config; guard so importing this module never throws when
// unconfigured. Runtime server-injected config wins; the build-time VITE_ value is the fallback.
const firebaseConfig = webConfig.firebase ?? JSON.parse(import.meta.env.VITE_FIREBASE_CONFIG_PROD ?? '{}');
export const hasFirebase = !!firebaseConfig.apiKey;

let app: FirebaseApp | null = null;
export const auth: Auth | null = hasFirebase ? getAuth((app = initializeApp(firebaseConfig))) : null;

export async function signInWithGoogle() {
  if (!auth) throw new Error('Firebase not configured');
  // In the appwrap native shell, Google blocks OAuth in the embedded WebView (disallowed_useragent),
  // so run it in the system browser via kit.oauth → signInWithCredential. Falls back to the web popup.
  if (await canUseNativeGoogleSignIn()) {
    await signInWithGoogleNative(auth);
    return;
  }
  await signInWithPopup(auth, new GoogleAuthProvider());
}

export async function signOutUser() {
  if (auth) await signOut(auth);
}

export function onAuth(cb: (user: User | null) => void) {
  if (!auth) { cb(null); return () => {}; }
  return onAuthStateChanged(auth, cb);
}
