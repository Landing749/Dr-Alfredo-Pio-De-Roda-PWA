// DAPRES Parent Portal — Firebase init.
// This is the PARENT PORTAL project (RTDB + Auth + FCM). It is intentionally
// a different Firebase project from the one ATSYS desktop uses for
// licensing — do not merge these two configs.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
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

// Resolves once we have a signed-in user (anonymous is fine — there's no
// parent account system, the link code IS the credential). Anonymous auth
// persists across sessions via IndexedDB, so a parent only ever re-enters
// a code once per device/browser install.
export function ensureSignedIn() {
  return new Promise((resolve, reject) => {
    const unsub = onAuthStateChanged(
      auth,
      (user) => {
        if (user) {
          unsub();
          resolve(user);
        } else {
          signInAnonymously(auth).catch((e) => {
            unsub();
            reject(e);
          });
        }
      },
      reject
    );
  });
}
