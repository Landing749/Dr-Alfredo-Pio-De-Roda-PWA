// DAPRES Parent Portal — Firebase init.
// This is the PARENT PORTAL project (RTDB + Auth + FCM). It is intentionally
// a different Firebase project from the one ATSYS desktop uses for
// licensing — do not merge these two configs.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  updateProfile,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getDatabase,
  ref,
  get,
  onValue,
  set,
  update,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";
import {
  getMessaging,
  getToken,
  onMessage,
  isSupported as isMessagingSupported,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging.js";

export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBf9r4B3JRpHneJt1OaxkD9E5arzLA2OfM",
  authDomain: "dr-alfredo-pio-de-roda.firebaseapp.com",
  databaseURL: "https://dr-alfredo-pio-de-roda-default-rtdb.firebaseio.com",
  projectId: "dr-alfredo-pio-de-roda",
  storageBucket: "dr-alfredo-pio-de-roda.firebasestorage.app",
  messagingSenderId: "228553752118",
  appId: "1:228553752118:web:9c7d81a3a7758e813ce297",
  measurementId: "G-CYTESJ5E7H",
};

// ⚠️ Fill this in from Firebase console → Project settings → Cloud
// Messaging → Web configuration → "Web Push certificates". Token
// registration below is skipped (silently) until this is set, so the
// rest of the app works fine without it — you just won't get push.
export const FCM_VAPID_KEY = "";

export const app = initializeApp(FIREBASE_CONFIG);
export const auth = getAuth(app);
export const db = getDatabase(app);

export { ref, get, onValue, set, update };

let _messaging = null;
export async function getMessagingIfSupported() {
  if (_messaging) return _messaging;
  try {
    if (await isMessagingSupported()) {
      _messaging = getMessaging(app);
      return _messaging;
    }
  } catch (e) {
    console.warn("[fcm] messaging not supported in this browser:", e);
  }
  return null;
}
export { getToken, onMessage };

// ─────────────────────────────────────────────────────────────────────────
// Parent accounts — real accounts (email/password or Google), NOT
// anonymous. This is what lets a parent sign up once and log back in on a
// second phone/browser and see the same linked students, instead of the
// old anonymous-auth model where every device was a fresh identity. The
// link code is still what actually attaches a student to the account
// (see redeemCode() in app.js) — the account is just the thing that
// carries that attachment across devices.
// ─────────────────────────────────────────────────────────────────────────

// Fires immediately with the current user (or null), then again on every
// sign-in/sign-out. Returns the unsubscribe function.
export function watchAuthState(callback) {
  return onAuthStateChanged(auth, callback);
}

export async function signUpParent(email, password) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  return cred.user;
}

export async function signInParent(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

export async function resetParentPassword(email) {
  return sendPasswordResetEmail(auth, email);
}

export async function signOutParent() {
  return signOut(auth);
}

// Google sign-in doubles as sign-up: same call either creates the account
// or logs into it if it already exists. Popup is nicer UX but doesn't work
// inside an installed PWA's standalone window (no chrome to host it), so we
// fall back to a full-page redirect there or whenever the popup is blocked.
export async function signInParentWithGoogle() {
  const provider = new GoogleAuthProvider();
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;
  if (standalone) {
    return signInWithRedirect(auth, provider); // resolved later via resolveGoogleRedirect()
  }
  try {
    const cred = await signInWithPopup(auth, provider);
    return cred.user;
  } catch (e) {
    const fallbackCodes = [
      "auth/popup-blocked",
      "auth/operation-not-supported-in-this-environment",
      "auth/cancelled-popup-request",
    ];
    if (fallbackCodes.includes(e.code)) {
      return signInWithRedirect(auth, provider);
    }
    throw e;
  }
}

// Call once on startup, before watchAuthState's first callback matters —
// picks up the result of a signInWithRedirect() from the fallback path
// above (or from standalone PWAs, which always redirect). No-op if there
// was no pending redirect.
export async function resolveGoogleRedirect() {
  const result = await getRedirectResult(auth);
  return result?.user || null;
}

export { updateProfile };
