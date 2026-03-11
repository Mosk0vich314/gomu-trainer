self.addEventListener('install', function(event) {
    self.skipWaiting();
});

self.addEventListener('activate', function(event) {
    event.waitUntil(clients.claim());
});

// NEW: When you tap the notification, open the app!
self.addEventListener('notificationclick', function(event) {
    event.notification.close(); // Clear the notification
    
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
            // If the app is already open in a background tab, focus it
            for (let i = 0; i < clientList.length; i++) {
                let client = clientList[i];
                if (client.url.includes('index.html') || client.url.includes('clean_app.html') || ('focus' in client)) {
                    return client.focus();
                }
            }
            // If the app was completely closed, open a new window
            if (clients.openWindow) {
                return clients.openWindow('/');
            }
        })
    );
});