import { initializeApp, getApps, FirebaseApp } from 'firebase/app';
import {
  initializeAuth,
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithCredential,
  signOut,
  GoogleAuthProvider,
  OAuthProvider,
  onAuthStateChanged,
  Auth,
  User,
  // @ts-expect-error – exists in the RN bundle but missing from public TS definitions
  getReactNativePersistence,
} from 'firebase/auth';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';

export const FIREBASE_SETUP_MSG =
  'Firebase is not configured. Open mobile/.env and paste your Web app keys from Firebase Console → Project settings → Your apps, then run: npx expo start -c';

type FirebaseExtra = {
  apiKey?: string;
  authDomain?: string;
  projectId?: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId?: string;
};

const extra = Constants.expoConfig?.extra?.firebase as FirebaseExtra | undefined;

/**
 * Resolve a Firebase setting from runtime environment or Expo extra configuration and discard
 * blank values.
 */
function env(key: string, fromExtra?: string): string | undefined {
  const value = process.env[key] ?? fromExtra;
  const trimmed = value?.trim();
  return trimmed || undefined;
}

const firebaseConfig = {
  apiKey: env('EXPO_PUBLIC_FIREBASE_API_KEY', extra?.apiKey),
  authDomain: env('EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN', extra?.authDomain),
  projectId: env('EXPO_PUBLIC_FIREBASE_PROJECT_ID', extra?.projectId),
  storageBucket: env('EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET', extra?.storageBucket),
  messagingSenderId: env('EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID', extra?.messagingSenderId),
  appId: env('EXPO_PUBLIC_FIREBASE_APP_ID', extra?.appId),
};

/** Report whether Firebase credentials are present before attempting authentication setup. */
export function isFirebaseConfigured(): boolean {
  return Boolean(firebaseConfig.apiKey);
}

let app: FirebaseApp | null = null;
let authInstance: Auth | null = null;

/**
 * Lazily initialize and cache Firebase Auth with native AsyncStorage persistence, reusing an
 * existing instance when necessary.
 */
function ensureAuth(): Auth {
  if (!isFirebaseConfigured()) {
    throw new Error(FIREBASE_SETUP_MSG);
  }
  if (authInstance) return authInstance;

  app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
  try {
    authInstance = initializeAuth(app, {
      persistence: getReactNativePersistence(AsyncStorage),
    });
  } catch {
    authInstance = getAuth(app);
  }
  return authInstance;
}

/** Safe for navigation — returns null when Firebase env vars are missing. */
export function getAuthIfConfigured(): Auth | null {
  if (!isFirebaseConfigured()) return null;
  return ensureAuth();
}

/**
 * Subscribe to authentication changes; an unconfigured app reports a signed-out state and returns
 * a harmless cleanup function.
 */
export function subscribeAuthState(
  listener: (user: User | null) => void
): () => void {
  const auth = getAuthIfConfigured();
  if (!auth) {
    listener(null);
    return () => { /* Provide the normal unsubscribe interface when no Firebase listener was created. */ };
  }
  return onAuthStateChanged(auth, listener);
}

/**
 * Create an email/password account and return its Firebase user ID; propagate authentication
 * errors to the screen.
 */
export async function signUpWithEmailPassword(email: string, password: string): Promise<string> {
  const cred = await createUserWithEmailAndPassword(ensureAuth(), email, password);
  return cred.user.uid;
}

/** Sign in with email/password credentials and return the authenticated Firebase user ID. */
export async function signInWithEmailPassword(email: string, password: string): Promise<string> {
  const cred = await signInWithEmailAndPassword(ensureAuth(), email, password);
  return cred.user.uid;
}

/** Exchange Google identity tokens for a Firebase session and return the associated user ID. */
export async function signInWithGoogleIdToken(idToken: string, accessToken?: string): Promise<string> {
  const credential = GoogleAuthProvider.credential(idToken, accessToken);
  const result = await signInWithCredential(ensureAuth(), credential);
  return result.user.uid;
}

/** Exchange Apple's identity token and its original nonce for a Firebase session. */
export async function signInWithAppleIdentityToken(
  identityToken: string,
  rawNonce: string
): Promise<string> {
  const provider = new OAuthProvider('apple.com');
  const credential = provider.credential({ idToken: identityToken, rawNonce });
  const result = await signInWithCredential(ensureAuth(), credential);
  return result.user.uid;
}

/**
 * Sign out of Firebase only when authentication is configured, allowing bypass-auth builds to call
 * the same interface.
 */
export async function signOutCurrentUser(): Promise<void> {
  const auth = getAuthIfConfigured();
  if (auth) await signOut(auth);
}
