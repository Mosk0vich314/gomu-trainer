// Run with: node tools/review_app_test.cjs
// Uses built-in modules only; the app remains a static, build-free PWA.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const crypto = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../scripts/app.js'), 'utf8');
function section(start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    assert(from >= 0 && to > from, `Missing source section: ${start}`);
    return source.slice(from, to);
}
function classes(...values) {
    const items = new Set(values);
    return { contains: x => items.has(x), add: x => items.add(x), remove: x => items.delete(x) };
}

async function main() {
    const listeners = {};
    const banner = { classList: classes('active') };
    const workerMessages = [];
    let beeps = 0;
    let displays = 0;
    const timer = vm.createContext({
        document: { visibilityState: 'visible', addEventListener: (n, fn) => listeners[n] = fn,
            getElementById: () => banner },
        navigator: {}, activeWorkout: null, timerTargetMs: Date.now() - 5000, timeLeft: 0,
        timerWorker: { postMessage: m => workerMessages.push(m) },
        updateTimerDisplay: () => displays++, playBeep: () => beeps++,
        completeTimer: () => banner.classList.add('finished'), Date
    });
    vm.runInContext(section("document.addEventListener('visibilitychange'", '// MODAL FUNCTIONS'), timer);
    listeners.visibilitychange();
    assert.equal(beeps, 1);
    assert.equal(timer.timeLeft, -5);
    assert.deepEqual(workerMessages, [], 'Returning after expiry must keep overtime ticking');
    timer.timerTargetMs -= 5000;
    listeners.visibilitychange();
    assert.equal(timer.timeLeft, -10, 'An already-finished timer catches up on return');
    assert.equal(beeps, 1, 'Returning again must not beep twice');
    assert.equal(displays, 2);

    let grant;
    let releases = 0;
    const wake = vm.createContext({
        navigator: { wakeLock: { request: () => new Promise(resolve => grant = resolve) } },
        document: { visibilityState: 'visible' }, activeWorkout: {},
        wakeLockSentinel: null, wakeLockPending: false
    });
    vm.runInContext(section('async function requestWakeLock()', 'function releaseWakeLock()'), wake);
    const pending = wake.requestWakeLock();
    wake.activeWorkout = null;
    grant({ release: async () => releases++, addEventListener() {} });
    await pending;
    assert.equal(releases, 1, 'A late wake lock must be released after workout completion');
    assert.equal(wake.wakeLockSentinel, null);
    assert.equal(wake.wakeLockPending, false);

    const warmupContainer = {};
    let routine = ['<img src=x onerror=alert(1)>', { text: 'A & B' }];
    const warmup = vm.createContext({ document: { getElementById: () => warmupContainer },
        safeParse: () => routine, DEFAULT_WARMUP: ['Default'], warmupEditMode: false });
    warmup.window = warmup;
    vm.runInContext(section('function escapeHtml(str)', '// --- GLOBAL ERROR SURFACE'), warmup);
    vm.runInContext(section('function getWarmupItems()', 'window.toggleWarmupEdit ='), warmup);
    warmup.renderWarmupList();
    assert(!warmupContainer.innerHTML.includes('<img'), 'Warmup text must never create HTML');
    assert(warmupContainer.innerHTML.includes('&lt;img'));
    assert(warmupContainer.innerHTML.includes('A &amp; B'));
    warmup.warmupEditMode = true;
    warmup.renderWarmupList();
    routine = {};
    assert.deepEqual(Array.from(warmup.getWarmupItems()), ['Default']);

    let switched = 0;
    const gestures = {};
    const swipe = vm.createContext({ Date, Set, switchTab: () => switched++,
        document: { addEventListener: (n, fn) => gestures[n] = fn,
            querySelector: () => ({ id: 'history-screen' }) } });
    vm.runInContext(section('// Swipe navigation between main tabs', 'function updateLibraryUI()'), swipe);
    const touch = blocked => ({ touches: [{ clientX: 10, clientY: 10 }],
        target: { closest: () => blocked ? {} : null } });
    gestures.touchstart(touch(true));
    gestures.touchend({ changedTouches: [{ clientX: 150, clientY: 10 }] });
    assert.equal(switched, 0, 'Deleting a history card must not switch tabs');
    gestures.touchstart(touch(false));
    gestures.touchend({ changedTouches: [{ clientX: 150, clientY: 10 }] });
    assert.equal(switched, 1, 'Swiping the screen background still navigates');

    const decrypt = vm.createContext({ fetch: async () => ({ ok: false, status: 404 }) });
    vm.runInContext(section('async function decryptDatabase(password)', 'async function bootWithPassword'), decrypt);
    await assert.rejects(decrypt.decryptDatabase('test'), /Could not load workout programs/);
    for (const iterations of [600000, 100000]) {
        const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
        const key = crypto.pbkdf2Sync('fixture-password', salt, iterations, 32, 'sha256');
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const ciphertext = Buffer.concat([cipher.update('window.db = { fixture: true };'), cipher.final()]);
        const blob = Buffer.concat([salt, iv, ciphertext, cipher.getAuthTag()]).toString('base64');
        const compatible = vm.createContext({ crypto: crypto.webcrypto, TextEncoder, TextDecoder, atob,
            APP_VERSION: 'test', fetch: async () => ({ ok: true, text: async () => blob }) });
        compatible.window = compatible;
        vm.runInContext(section('const PBKDF2_ITERATION_CANDIDATES', 'async function bootWithPassword'), compatible);
        await compatible.decryptDatabase('fixture-password');
        assert.equal(compatible.db.fixture, true, `Database unlocks at ${iterations} iterations`);
        await assert.rejects(compatible.decryptDatabase('wrong-password'), { name: 'OperationError' });
    }
    console.log('PASS: timer catch-up, wake-lock race, warmup escaping, swipe ownership, login failures and both encryption formats');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
