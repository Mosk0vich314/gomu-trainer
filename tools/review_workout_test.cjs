// Run with: node tools/review_workout_test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../scripts/app.js'), 'utf8');
function section(start, end) {
    const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
    assert(from >= 0 && to > from, start);
    return source.slice(from, to);
}
function context() {
    const stores = new Map();
    const c = vm.createContext({
        localStorage: { getItem: k => stores.get(k) ?? null, setItem: (k,v) => stores.set(k, String(v)), removeItem: k => stores.delete(k) },
        safeParse: (k, fallback) => stores.has(k) ? JSON.parse(stores.get(k)) : fallback,
        currentProgram: 'Custom_test', selectedWeek: '1', selectedDay: '1', completedDays: {}, activeWorkout: null,
        workoutHistoryCache: [], workoutDurationInterval: null, clearInterval() {},
        db: { Custom_test: { name: 'Test', weeks: { 1: { 1: [{ name: 'Row', type: 'accessory', blocks: [{ sets: 3, reps: 10, targetRpe: 8 }] }] } } } },
        renderWorkout() {}, renderDayPills() {}, updateBanners() {}, updateDashboard() {}, closeTimer() {},
        document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
        addEventListener() {}, setTimeout: () => 1, clearTimeout() {},
        scrollTo() {}, gdriveBackup() {}, setDB() {}, isBodyweightExercise: () => false, kgDisp: n => n, unitSuffix: () => 'kg',
        showConfirm: async () => true, navigator: {}, console
    });
    c.window = c;
    vm.runInContext(section('let _sessionCacheKey =', 'let currentProgram ='), c);
    vm.runInContext(section('function saveSessionState(', 'window.dismissTargetSet ='), c);
    vm.runInContext(section('function getWorkoutKey()', 'function generateSummary('), c);
    vm.runInContext(section('function reindexSessionAfterDelete(', 'window.openSwapModal ='), c);
    vm.runInContext(section('window.addSetToBlock =', '// --- EXERCISE'), c);
    return c;
}

test('set deletion moves notes, durations, target definitions and target row values together', () => {
    const c = context();
    const result = c.reindexSessionAfterDelete({
        ex_untouched: 'ok', ex_ignored: 5,
        'ex-0_b0_s1_load': '10', 'ex-0_b0_s2_load': '20', 'ex-0_b0_s2_note': 'Keep',
        'ex-0_b0_s2_duration': 2, extras_0_0_s2: [{ reps: 5 }], 'ex-0_b0_s2_extra_0_check': true
    }, 0, 0, 1);
    assert.equal(result['ex-0_b0_s1_load'], '20');
    assert.equal(result['ex-0_b0_s1_note'], 'Keep');
    assert.equal(result['ex-0_b0_s1_duration'], 2);
    assert.equal(result.extras_0_0_s1[0].reps, 5);
    assert.equal(result['ex-0_b0_s1_extra_0_check'], true);
    assert(!Object.hasOwn(result, 'ex-0_b0_s2_load'));
});

test('exercise and block removal reindex row values and metadata', () => {
    const c = context();
    const result = c.reindexSessionAfterDelete({
        'ex-0_b0_s1_load': '10', 'ex-1_b1_s1_load': '30', modifiedBlocks: { '1_1': 4 },
        deletedBlocks: ['1_2'], modifiedNotes: { 1: 'Keep' }, customOrder: [1,0]
    }, 0);
    assert.equal(result['ex-0_b1_s1_load'], '30');
    assert.equal(result.modifiedNotes[0], 'Keep');
    assert.equal(result.modifiedBlocks['0_1'], 4);
    assert.deepEqual(Array.from(result.customOrder), [0]);
    const blockResult = c.reindexSessionAfterDelete(result, 0, 0);
    assert.equal(blockResult['ex-0_b0_s1_load'], '30');
    assert.equal(blockResult.modifiedBlocks['0_0'], 4);
    assert.deepEqual(Array.from(blockResult.deletedBlocks), ['0_1']);
});

test('adding and deleting sets in converted custom modes changes the rendered structure', () => {
    const c = context(), key = c.getWorkoutKey();
    c.localStorage.setItem('programModes_Custom_test', JSON.stringify({ Row: { type: 'dropset', actSets: 2, drops: 2, actReps: 6, stripPct: 20 } }));
    c.addSetToBlock(0, 4); // A converted block beyond the source template's only block.
    assert.equal(c.getActiveExercises('Custom_test', '1', '1', key)[0].blocks[4].sets, 2);
    c.deleteSetFromBlock(0, 4, 2);
    assert.equal(c.getActiveExercises('Custom_test', '1', '1', key)[0].blocks[4].sets, 1);
    c.deleteSetFromBlock(0, 4, 1);
    assert.equal(c.getActiveExercises('Custom_test', '1', '1', key)[0].blocks[4]._deleted, true);
    assert.equal(c.db.Custom_test.weeks[1][1][0].blocks.length, 1);
});

test('added exercises receive program-level swaps', () => {
    const c = context(), key = c.getWorkoutKey();
    c.localStorage.setItem(key, JSON.stringify({ addedExercises: [{ name: 'Curl', blocks: [] }] }));
    c.localStorage.setItem('programSwaps_Custom_test', JSON.stringify({ Curl: 'Cable Curl' }));
    const ex = c.getActiveExercises('Custom_test', '1', '1', key)[1];
    assert.equal(ex.name, 'Cable Curl');
    assert.equal(ex._originalName, 'Curl');
});

test('a new batched edit cannot resurrect a deleted set after reindexing', () => {
    const c = context(), key = c.getWorkoutKey();
    c.saveSessionState('ex-0_b0_s1_note', 'Delete this');
    c.saveSessionState('ex-0_b0_s2_note', 'Keep this');
    c.deleteSetFromBlock(0, 0, 1);
    c.saveSessionState('ex-0_b0_s1_load', '25');
    c.flushSessionState();
    const reloaded = JSON.parse(c.localStorage.getItem(key));
    assert.equal(reloaded['ex-0_b0_s1_note'], 'Keep this');
    assert.equal(reloaded['ex-0_b0_s1_load'], '25');
    assert.equal(reloaded['ex-0_b0_s2_note'], undefined);
});

test('cancel flushes and removes pending session edits before reload', () => {
    const c = context(), key = c.getWorkoutKey();
    c.activeWorkout = { key };
    c.saveSessionState('ex-0_b0_s1_load', '90');
    c.discardActiveWorkout();
    c.flushSessionState();
    assert.equal(c.localStorage.getItem(key), null);
});

test('final-day summary uses swaps and converted blocks before cleanup', async () => {
    const c = context(), key = c.getWorkoutKey();
    c.localStorage.setItem('programSwaps_Custom_test', JSON.stringify({ Row: 'Cable Row' }));
    c.localStorage.setItem('programModes_Custom_test', JSON.stringify({ Row: { type: 'dropset', drops: 2 } }));
    c.activeWorkout = { key, startTime: Date.now() };
    let summary;
    c.generateSummary = () => { summary = c.getActiveExercises('Custom_test', '1', '1', key)[0]; };
    await c.toggleWorkoutState('finish');
    assert.equal(summary.name, 'Cable Row');
    assert.equal(summary.blocks.length, 3);
    assert.equal(c.localStorage.getItem('programModes_Custom_test'), null);
});

test('discard restores all snapshots and clears the running session even while previewing another', () => {
    const c = context();
    c.localStorage.setItem('running_w1_d2', '{}');
    c.localStorage.setItem(c.getWorkoutKey(), '{"preview":true}');
    c.activeWorkout = { key: 'running_w1_d2', backupState: { actualBests: { Row: 1 }, global1RMs: {}, lastUsedWeights: {}, prHistory: {} } };
    c.discardActiveWorkout();
    assert.equal(c.activeWorkout, null);
    assert.equal(c.localStorage.getItem('running_w1_d2'), null);
    assert.equal(c.safeParse(c.getWorkoutKey(), {}).preview, true);
    assert.equal(c.safeParse('actualBests', {}).Row, 1);
});

test('summary preserves zero reps and includes bodyweight in target-set volume', () => {
    const c = context(), key = c.getWorkoutKey();
    vm.runInContext(section('function amrapSetIndex(', 'const TAB_ORDER'), c);
    vm.runInContext(section('function generateSummary(', 'window.saveSessionNote ='), c);
    c.isBodyweightExercise = () => true;
    c.localStorage.setItem('userBodyweight', '80');
    c.localStorage.setItem(key, JSON.stringify({ 'ex-0_b0_s1_check': true, 'ex-0_b0_s1_reps': '0',
        extras_0_0_s1: [{ reps: 5 }], 'ex-0_b0_s1_extra_0_check': true, 'ex-0_b0_s1_extra_0_load': '10' }));
    c.generateSummary(key);
    assert.equal(c.workoutHistoryCache[0].details[0].sets[0].reps, 0);
    assert.equal(c.workoutHistoryCache[0].volume, 450);
});

test('checking an activation cascades without a ReferenceError, backoff checks do not cascade', () => {
    const c = context();
    let checked = false, cascades = 0;
    const el = { id: 'ex-0_b0_s1_check', dataset: { myotype: 'activation', norest: 'true' },
        classList: { toggle: () => checked = !checked, contains: () => checked } };
    const load = { id: 'ex-0_b0_s1_load', value: '30', dataset: { exname: 'Row' } };
    c.document.getElementById = id => id === load.id ? load : null;
    c.normalizeExName = n => n;
    c.cascadeMyoDropLoads = (_, name) => { assert.equal(name, 'Row'); cascades++; };
    vm.runInContext(section('window.toggleCheck =', 'window.dismissTargetSet ='), c);
    c.toggleCheck(el);
    assert.equal(cascades, 1);
    checked = false;
    el.dataset.myotype = 'backoff';
    c.toggleCheck(el);
    assert.equal(cascades, 1);
});

test('variation names remain text and preserve quotes in click arguments', () => {
    const c = context();
    c.getResolved1RM = () => 100;
    vm.runInContext(section('function escapeHtml(str)', '// --- GLOBAL ERROR SURFACE'), c);
    vm.runInContext(section('function variationTitleHtml(', 'function startProgram('), c);
    const name = 'Coach\'s "A" \\ <img src=x> (bench)';
    const html = c.variationTitleHtml({ name }, 2, false);
    assert(!html.includes('<img'));
    const handler = html.match(/onclick="([^"]*)"/)[1]
        .replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
    let captured;
    vm.runInNewContext(handler, { event: { stopPropagation() {} }, openVariationPctModal: (...args) => { captured = args; } });
    assert.deepEqual(captured, [2, name, 'bench']);
});

test('inline callback strings preserve line breaks in imported exercise names', () => {
    const c = context();
    vm.runInContext(section('function escapeHtml(str)', '// --- GLOBAL ERROR SURFACE'), c);
    const name = 'Coach\'s "A"\r\nPause \\ Press & <tag>';
    const encoded = c.escapeJsAttr(name);
    const decoded = encoded.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
    assert.equal(vm.runInNewContext(`'${decoded}'`), name);
});
