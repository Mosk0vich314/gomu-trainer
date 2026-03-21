const CACHE_NAME = 'gomu-trainer-v2026.03.21.1657'; // Increment this!
const urlsToCache = [
  './',
  './index.html',
  './styles/styles.css',
  './scripts/app.js',
  './scripts/database.enc',
  './assets/manifest.json',
  './assets/logo.png',
  './assets/audio/ding.mp3',
  './assets/images/dashboard.jpg',
  './assets/images/warmup.jpg',
  './assets/images/management.jpg',
  './assets/icons/panash_logo.jpg',
  './assets/icons/cbb_logo.jpg',
  './assets/icons/boostcamp_logo.jpg'
];

// 1. INSTALL: Save all files into the phone's memory
self.addEventListener('install', function(event) {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then(function(cache) {
            return cache.addAll(urlsToCache);
        })
    );
});

// 2. ACTIVATE: Clean up old versions of the cache
self.addEventListener('activate', function(event) {
    event.waitUntil(
        caches.keys().then(function(cacheNames) {
            return Promise.all(
                cacheNames.map(function(cacheName) {
                    if (cacheName !== CACHE_NAME) {
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

// 3. FETCH: The "Self-Updating" Engine
self.addEventListener('fetch', function(event) {
    // We only want to handle standard GET requests (ignore API posts, etc.)
    if (event.request.method !== 'GET') return;

    event.respondWith(
        fetch(event.request)
            .then(function(response) {
                // THE MAGIC TRICK: Auto-Update the Cache!
                // If we successfully get a fresh file from GitHub, we show it to you
                // AND silently save a copy into the phone's memory for next time.
                if (response && response.status === 200) {
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then(function(cache) {
                        cache.put(event.request, responseClone);
                    });
                }
                return response;
            })
            .catch(function() {
                // You have no internet (e.g., in the gym). Serve the saved files from the vault!
                return caches.match(event.request);
            })
    );
});
// 4. NOTIFICATION CLICK: Open or focus the app
self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
            for (let i = 0; i < clientList.length; i++) {
                let client = clientList[i];
                if (client.url.includes('index.html') && 'focus' in client) {
                    return client.focus();
                }
            }
            if (clients.openWindow) return clients.openWindow('./');
        })
    );
});

// Add this to listen for the "Update Now" command from app.js
self.addEventListener('message', (event) => {
    if (event.data && event.data.action === 'skipWaiting') {
        self.skipWaiting();
    }
});