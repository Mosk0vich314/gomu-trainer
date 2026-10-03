// Run with: node tools/review_storage_test.cjs (no packages required).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../scripts/app.js'), 'utf8');
const section = (start, end) => {
    const a = source.indexOf(start), b = source.indexOf(end, a);
    assert(a >= 0 && b > a, `Missing source section: ${start}`);
    return source.slice(a, b);
};
const clone = value => JSON.parse(JSON.stringify(value));

function harness() {
    const stored = new Map(), db = new Map(), elements = new Map(), timers = new Map();
    let nextTimer = 1;
    const localStorage = {
        get length() { return stored.size; }, key: i => [...stored.keys()][i],
        getItem: k => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, String(v)),
        removeItem: k => stored.delete(k), clear: () => stored.clear()
    };
    const document = {
        createElement: () => ({ classList: { add() {}, remove() {} }, remove() { elements.delete(this.id); this.parentNode = null; } }),
        body: { appendChild(el) { el.parentNode = this; elements.set(el.id, el); elements.set('undo-toast-btn', {}); } },
        getElementById: id => elements.get(id) || null,
        querySelector: () => null, addEventListener() {}
    };
    const context = vm.createContext({
        console, URL, localStorage, document, APP_VERSION: 'test',
        workoutHistoryCache: [], completedDays: {}, activeWorkout: null,
        getWorkoutKey: () => 'Program_w1_d1', addEventListener() {},
        workoutDurationInterval: null, clearInterval() {}, closeTimer() {},
        setDB: async (key, value) => db.set(key, clone(value)), getDB: async (key, fallback) => clone(db.get(key) ?? fallback),
        setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
        clearTimeout: id => timers.delete(id), requestAnimationFrame: fn => fn(),
        renderHistory() {}, updateDashboard() {}, renderDayPills() {}, renderStats() {}, checkOnboarding() {}, updateLibraryUI() {},
        showConfirm: async () => true, alert() {}, location: { reload() {} },
        kgDisp: value => value, unitSuffix: () => 'kg', fmtShortDate: () => 'Today'
    });
    context.window = context;
    context.safeParse = (key, fallback) => key === 'workoutHistory' ? context.workoutHistoryCache : JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
    const code = [
        section('let _sessionCacheKey =', 'let currentProgram ='),
        section('function saveSessionState(', 'window.dismissTargetSet ='),
        section('const BACKUP_PREFERENCES', 'function fmtRelTime'),
        section('window.saveSessionNote =', "let currentChartEx = ''"),
        section('let _undoTimer =', '// --- PROGRAM MANAGEMENT FUNCTIONS'),
        section('async function clearAllPRs()', 'window.updateManual1RM ='),
        section('function discardActiveWorkout()', 'function getActiveExercises('),
        section('function escapeHtml(', '// --- GLOBAL ERROR SURFACE'),
        section('function safePRVideoURL(', '// Feature 3: Save or clear video URL'),
        section('async function gdriveBackup()', 'window.isNoPlateExercise =')
    ].join('\n');
    vm.runInContext(code, context);
    context.updateGistUI = () => {};
    return { context, localStorage, db, elements, timers, stored };
}

(async () => {
    let checks = 0;
    const check = (condition, message) => { assert(condition, message); checks++; };
    const h = harness(), c = h.context;
    h.localStorage.setItem('activeWorkout', JSON.stringify({ key: 'Program_w1_d1', startTime: 1 }));
    h.localStorage.setItem('Program_w1_d1', JSON.stringify({ row1_done: true, row1_note: 'Paused rep' }));
    h.localStorage.setItem('programModes_Program', JSON.stringify({ Curl: { type: 'myo' } }));
    h.localStorage.setItem('appTheme', 'Ocean');
    h.localStorage.setItem('onboardingSkipped', '1');
    h.localStorage.setItem('prHistoryRTS_v2', '1');
    c.workoutHistoryCache = [{ id: '200', note: 'Newer' }];
    c.saveSessionState('row1_load', '55');
    const backup = await c.collectBackup(false);
    check(backup.workoutSessions.Program_w1_d1.row1_load === '55', 'Export flushes the latest input before collecting session data');
    check(backup.preferences.onboardingSkipped === '1', 'Backup includes skipped onboarding');
    check(backup.workoutSessions.Program_w1_d1.row1_done, 'Backup preserves checked active sets');
    check(backup.workoutSessions.Program_w1_d1.row1_note === 'Paused rep', 'Backup preserves set notes');
    check(backup.preferences.appTheme === 'Ocean' && backup.migrations.prHistoryRTS_v2 === '1', 'Backup preserves preferences and completed migrations');
    h.db.set('workoutHistory', [{ id: '100' }, { id: 200, note: 'Older' }]);
    h.localStorage.clear();
    await c.applyBackup(backup);
    check(c.safeParse('Program_w1_d1', {}).row1_done, 'Restore restores active session inputs');
    check(h.db.get('workoutHistory').length === 2 && h.db.get('workoutHistory')[0].note === 'Newer', 'Restore merges old sessions and reconciles numeric/string IDs');
    c.saveSessionState('row1_load', '100');
    await c.applyBackup(backup);
    c.flushSessionState();
    check(c.safeParse('Program_w1_d1', {}).row1_load === '55', 'Pending edits cannot overwrite a restored workout');
    await c.applyBackup({ workoutHistory: [], activeWorkout: null, activeProgram: null });
    check(h.localStorage.getItem('activeWorkout') === null, 'Explicit null removes stale active session');
    check(h.db.get('workoutHistory').length === 2, 'Empty incoming history preserves local history');

    const before = JSON.stringify([...h.stored]);
    await assert.rejects(c.applyBackup({ completedDays: { changed: true }, workoutHistory: {} }), /Invalid backup/); checks++;
    await assert.rejects(c.applyBackup({ completedDays: {}, programSwaps: { gistPAT: {} } }), /Invalid backup/); checks++;
    check(JSON.stringify([...h.stored]) === before, 'Invalid backups cannot partially change localStorage');

    const undone = [], committed = [];
    c.showUndoToast('First', () => committed.push('first'), () => undone.push('first'));
    c.showUndoToast('Second', () => committed.push('second'), () => undone.push('second'));
    check(committed.join() === 'first', 'Replacing toast commits first deletion');
    h.elements.get('undo-toast-btn').onclick();
    check(undone.join() === 'second' && committed.length === 1, 'Undo only cancels the currently shown deletion');

    c.workoutHistoryCache = [{ id: '2', key: 'Program_w1_d1' }, { id: '1', key: 'Program_w1_d1' }];
    c.completedDays = { Program_w1_d1: true };
    c.activeWorkout = { key: 'Program_w1_d1' };
    h.localStorage.setItem('activeWorkout', JSON.stringify(c.activeWorkout));
    c.deleteHistoryLog('1', 'Program_w1_d1');
    check(c.completedDays.Program_w1_d1 === true, 'Deleting older repeated day preserves completion');
    c.deleteHistoryLog('2', 'Program_w1_d1');
    check(c.activeWorkout.key === 'Program_w1_d1' && c.safeParse('Program_w1_d1', {}).row1_done, 'Deleting history preserves a new live session');

    c.workoutHistoryCache = [{ id: '300' }]; c._lastSummaryLogId = '300';
    await c.saveSessionNote(' A difficult session ');
    check(h.db.get('workoutHistory')[0].note === 'A difficult session', 'Session note persists before a debounce/navigation window');
    check((await c.collectBackup(false)).workoutHistory[0].note === 'A difficult session', 'Immediate export contains latest session note');

    check(c.safePRVideoURL('javascript:alert(1)') === '', 'Reject executable PR video URLs');
    check(c.safePRVideoURL('https://example.com/video?x=1&y=2').startsWith('https://'), 'Allow normal video links');
    h.localStorage.setItem('prHistory', JSON.stringify({ 'Curl "quoted"': [{ date: 1, weight: 10, reps: 5, e1rm: 12, videoUrl: "https://example.com/it's-a-video" }] }));
    const rendered = {}; c.renderPRTimelineEl('Curl "quoted"', rendered);
    check(rendered.innerHTML.includes('rel="noopener noreferrer"') && !rendered.innerHTML.includes('window.open('), 'Video link does not interpolate its URL into executable JavaScript');
    check(rendered.innerHTML.includes('&quot;'), 'Exercise name is escaped in event attributes');

    h.localStorage.setItem('gistPAT', 'test-token');
    const requests = []; let reloaded = false;
    c.location.reload = () => { reloaded = true; };
    c.fetch = async url => {
        requests.push(url);
        return requests.length === 1
            ? { ok: true, json: async () => ({ files: { 'gomu-trainer-backup.json': { content: '{truncated', truncated: true, raw_url: 'https://example.com/raw' } } }) }
            : { ok: true, text: async () => JSON.stringify({ workoutHistory: [{ id: '500' }] }) };
    };
    h.localStorage.setItem('gistId', 'test-gist');
    await c.restoreFromGist();
    check(requests.length === 2 && reloaded && h.db.get('workoutHistory')[0].id === '500', 'Truncated Gist restore downloads and applies complete content');

    h.db.set('progressPictures', [{ id: '600', src: 'private-photo' }]);
    c.saveSessionState('row1_load', '200');
    await c.clearAllPRs();
    c.flushSessionState();
    check(h.db.get('progressPictures').length === 0 && h.db.get('workoutHistory').length === 0, 'Factory reset clears both IndexedDB stores');
    check(h.localStorage.getItem('Program_w1_d1') === null, 'Factory reset removes pending session edits');
    check(h.localStorage.getItem('gistPAT') === 'test-token', 'Factory reset preserves the backup connection');
    console.log(`Storage review: ${checks} regression checks passed.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
