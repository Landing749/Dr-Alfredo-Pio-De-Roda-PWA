/* DAPRES Parent Portal — FCM background handler.
 * Must be named exactly "firebase-messaging-sw.js" and served from the
 * site root — this is a hard Firebase requirement, not a convention.
 * Separate from sw.js (app-shell caching) on purpose: this one only
 * ever handles push messages that arrive while the app isn't focused.
 */
importScripts("https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js");

// Same PARENT_FIREBASE_CONFIG as js/firebase-init.js — duplicated here
// because importScripts-based service workers can't import ES modules.
firebase.initializeApp({
  apiKey: "AIzaSyBf9r4B3JRpHneJt1OaxkD9E5arzLA2OfM",
  authDomain: "dr-alfredo-pio-de-roda.firebaseapp.com",
  databaseURL: "https://dr-alfredo-pio-de-roda-default-rtdb.firebaseio.com",
  projectId: "dr-alfredo-pio-de-roda",
  storageBucket: "dr-alfredo-pio-de-roda.firebasestorage.app",
  messagingSenderId: "228553752118",
  appId: "1:228553752118:web:9c7d81a3a7758e813ce297",
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const title = (payload.notification && payload.notification.title) || "DAPRES Parent Portal";
  const body = (payload.notification && payload.notification.body) || "";
  self.registration.showNotification(title, {
    body,
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    data: payload.data || {},
  });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("./");
    })
  );
});
