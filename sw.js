const CACHE_NAME = 'gomu-trainer-v8'; // Increment this!
const urlsToCache = [
  './',
  './index.html',
  './styles/styles.css',
  './scripts/app.js',
  './scripts/database.js',
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

self.addEventListener('fetch', function(event) {
    event.respondWith(
        fetch(event.request).catch(function() {
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