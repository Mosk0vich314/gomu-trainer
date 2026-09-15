const CACHE_NAME = 'gomu-trainer-v2026.09.16.0016'; // Increment this!
const urlsToCache = [
  './',
  './index.html',
  './styles/styles.css',
  './scripts/app.js',
  './scripts/database.enc',
  './assets/manifest.json',
  './assets/logo.png',
  './assets/logo-192.png',
  './assets/logo-512.png',
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

// 3. FETCH: Stale-While-Revalidate
// Serve from cache INSTANTLY, refresh the cache in the background.
// Network-first made the app hang for the full network timeout on flaky
// gym connections (1 bar ≠ offline). Updates still land: each deploy ships
// a new CACHE_NAME + version-stamped sw.js, and the controllerchange
// listener in app.js reloads the page when the new worker takes over.
self.addEventListener('fetch', function(event) {
    // We only want to handle standard GET requests (ignore API posts, etc.)
    if (event.request.method !== 'GET') return;
    // Never intercept API calls (e.g. GitHub Gist backup)
    if (event.request.url.includes('api.github.com')) return;

    event.respondWith(
        caches.match(event.request)
            .then(function(cached) {
                // ignoreSearch fallback: install caches './scripts/database.enc' but the
                // app requests it with '?v=...' — without this, offline login breaks
                // until the versioned URL has been fetched online once.
                if (cached) return cached;
                return caches.match(event.request, { ignoreSearch: true });
            })
            .then(function(cached) {
                const network = fetch(event.request)
                    .then(function(response) {
                        // Cache good responses. Opaque (status 0) covers cross-origin
                        // no-cors resources like Google Fonts so they work offline too.
                        if (response && (response.status === 200 || response.type === 'opaque')) {
                            const responseClone = response.clone();
                            caches.open(CACHE_NAME).then(function(cache) {
                                cache.put(event.request, responseClone);
                            });
                        }
                        return response;
                    })
                    .catch(function() {
                        return cached; // offline and nothing fresher — serve what we have
                    });
                return cached || network;
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

// 5. MESSAGES: "Update Now" command + rest-timer alarm scheduling.
// The page schedules the alarm at timer start because Android freezes a
// backgrounded PWA — the in-page timer can't fire until the app is reopened.
// event.waitUntil keeps this worker alive (Chrome allows ~5 min) so the
// notification lands on time even while the page is frozen. If the app is
// visible when the alarm fires, the page's own beep handles it and we skip.
let timerTimeout = null;
let timerDone = null; // resolver for the waitUntil promise

function cancelTimerAlarm() {
    if (timerTimeout) { clearTimeout(timerTimeout); timerTimeout = null; }
    if (timerDone) { timerDone(); timerDone = null; }
}

self.addEventListener('message', (event) => {
    if (!event.data) return;

    if (event.data.action === 'skipWaiting') {
        self.skipWaiting();
    }

    if (event.data.action === 'scheduleTimer') {
        cancelTimerAlarm(); // ±15s adjustments reschedule; only one alarm at a time
        const delay = Math.max(0, event.data.delay || 0);
        event.waitUntil(new Promise((resolve) => {
            timerDone = resolve;
            timerTimeout = setTimeout(async () => {
                timerTimeout = null;
                timerDone = null;
                const clientList = await self.clients.matchAll({ type: 'window' });
                const appVisible = clientList.some(c => c.visibilityState === 'visible');
                if (!appVisible) {
                    await self.registration.showNotification("⏱️ Rest Complete!", {
                        body: "Time for your next set. Tap to resume.",
                        icon: "./assets/logo-192.png",
                        vibrate: [200, 100, 200, 100, 400],
                        tag: "gomu-timer",
                        renotify: true,
                        requireInteraction: true
                    });
                }
                resolve();
            }, delay);
        }));
    }

    if (event.data.action === 'cancelTimer') {
        cancelTimerAlarm();
    }
});