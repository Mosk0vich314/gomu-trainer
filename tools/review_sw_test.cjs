// Run with: node tools/review_sw_test.cjs
// No app dependencies: exercise service-worker event lifetimes in an isolated VM.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
const scope = 'https://example.github.io/gomuTrainer/';
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const flush = () => new Promise(resolve => setImmediate(resolve));
const response = label => ({ label, status: 200, type: 'basic', clone() { return this; } });

function worker(options = {}) {
    const handlers = {}, deleted = [], writes = [], notifications = [], timers = new Map();
    let nextTimer = 1;
    const cache = {
        match: options.match || (async () => undefined),
        put: options.put || (async (request, value) => writes.push([request, value])),
        addAll: async () => {}
    };
    const clients = {
        claim: async () => {},
        matchAll: options.matchAll || (async () => []),
        openWindow: options.openWindow || (async () => {})
    };
    const self = {
        addEventListener: (name, handler) => { handlers[name] = handler; },
        skipWaiting: async () => {}, clients,
        registration: {
            scope,
            showNotification: options.showNotification || (async (...args) => notifications.push(args))
        }
    };
    const context = vm.createContext({
        self, clients,
        caches: {
            open: options.open || (async () => cache),
            keys: async () => options.keys || [],
            delete: async key => deleted.push(key)
        },
        fetch: options.fetch || (async () => { throw new Error('Offline'); }),
        Response: { error: () => ({ type: 'error' }) },
        console: { warn() {} },
        setTimeout: fn => { const id = nextTimer++; timers.set(id, fn); return id; },
        clearTimeout: id => timers.delete(id)
    });
    vm.runInContext(source, context);
    function dispatch(name, extra = {}) {
        const pending = [];
        const event = {
            ...extra,
            waitUntil(promise) { pending.push(promise); },
            respondWith(promise) { this.response = promise; }
        };
        handlers[name](event);
        return { event, pending };
    }
    return { dispatch, deleted, writes, notifications, timers };
}

function request(path = 'scripts/database.enc?v=123') {
    return { method: 'GET', url: scope + path };
}

test('activation removes old app caches and preserves other sites', async () => {
    const current = source.match(/const CACHE_NAME = '([^']+)'/)[1];
    const w = worker({ keys: [current, 'gomu-trainer-vold', 'another-app-v1'] });
    await Promise.all(w.dispatch('activate').pending);
    assert.deepEqual(w.deleted, ['gomu-trainer-vold']);
});

test('cached content is served while network refresh remains pending', async () => {
    const fresh = deferred(), cached = response('cached');
    const w = worker({ match: async () => cached, fetch: () => fresh.promise });
    const { event, pending } = w.dispatch('fetch', { request: request() });
    assert.equal(await event.response, cached);
    assert.equal(pending.length, 1, 'background refresh has an event lifetime');
    fresh.resolve(response('fresh'));
    await Promise.all(pending);
    assert.equal(w.writes[0][1].label, 'fresh');
});

test('versioned encrypted database falls back to the install cache offline', async () => {
    const cached = response('encrypted database');
    const w = worker({ match: async (_request, opts) => opts?.ignoreSearch ? cached : undefined });
    const { event, pending } = w.dispatch('fetch', { request: request() });
    assert.equal(await event.response, cached);
    await Promise.all(pending);
});

test('cache refresh lifetime includes the asynchronous cache write', async () => {
    const write = deferred();
    const w = worker({ match: async () => response('cached'), fetch: async () => response('fresh'), put: () => write.promise });
    const { event, pending } = w.dispatch('fetch', { request: request() });
    await event.response;
    let finished = false;
    const completion = Promise.all(pending).then(() => { finished = true; });
    await flush();
    assert.equal(finished, false);
    write.resolve();
    await completion;
});

test('cache write failure does not discard an uncached network response', async () => {
    const fresh = response('fresh');
    const w = worker({ fetch: async () => fresh, put: async () => { throw new Error('Quota exceeded'); } });
    const { event, pending } = w.dispatch('fetch', { request: request() });
    assert.equal(await event.response, fresh);
    await Promise.all(pending);
});

test('uncached offline request returns a network error response', async () => {
    const w = worker();
    const { event, pending } = w.dispatch('fetch', { request: request() });
    assert.equal((await event.response).type, 'error');
    await Promise.all(pending);
});

test('disabled Cache Storage still serves a network response', async () => {
    const fresh = response('fresh');
    const w = worker({ fetch: async () => fresh, open: async () => { throw new Error('Storage disabled'); } });
    const { event, pending } = w.dispatch('fetch', { request: request() });
    assert.equal(await event.response, fresh);
    await Promise.all(pending);
});

test('notification click focuses the scope-root app and ignores other apps', async () => {
    const focused = [], opened = [];
    const w = worker({
        matchAll: async () => [
            { url: 'https://example.github.io/other/index.html', focus: async () => focused.push('other') },
            { url: scope, focus: async () => focused.push('app') }
        ],
        openWindow: async url => opened.push(url)
    });
    await Promise.all(w.dispatch('notificationclick', { notification: { close() {} } }).pending);
    assert.deepEqual(focused, ['app']);
    assert.deepEqual(opened, []);
});

test('timer cancelled while clients are being queried never notifies', async () => {
    const query = deferred();
    const w = worker({ matchAll: () => query.promise });
    const scheduled = w.dispatch('message', { data: { action: 'scheduleTimer', delay: 1000 } });
    const alarm = [...w.timers.values()][0]();
    w.dispatch('message', { data: { action: 'cancelTimer' } });
    query.resolve([]);
    await alarm;
    await Promise.all(scheduled.pending);
    assert.equal(w.notifications.length, 0);
});

test('notification rejection settles the timer event lifetime', async () => {
    const w = worker({ showNotification: async () => { throw new Error('Permission denied'); } });
    const scheduled = w.dispatch('message', { data: { action: 'scheduleTimer', delay: 1000 } });
    await [...w.timers.values()][0]();
    await Promise.all(scheduled.pending);
});

test('visible app uses its foreground beep without a notification', async () => {
    const w = worker({ matchAll: async () => [{ visibilityState: 'visible' }] });
    const scheduled = w.dispatch('message', { data: { action: 'scheduleTimer', delay: 1000 } });
    await [...w.timers.values()][0]();
    await Promise.all(scheduled.pending);
    assert.equal(w.notifications.length, 0);
});
