// Regression checks for the November audit fixes. Run with: node --test tools/review_fixes_test.cjs
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
function classes() {
    const values = new Set();
    return { contains: v => values.has(v), add: v => values.add(v), remove: v => values.delete(v),
        toggle(v) { if (values.has(v)) { values.delete(v); return false; } values.add(v); return true; } };
}
function storage() {
    const stores = new Map();
    return {
        stores,
        localStorage: { getItem: k => stores.get(k) ?? null, setItem: (k, v) => stores.set(k, String(v)), removeItem: k => stores.delete(k),
            get length() { return stores.size; }, key: i => [...stores.keys()][i] ?? null },
        safeParse: (k, fallback) => stores.has(k) ? JSON.parse(stores.get(k)) : fallback
    };
}
// The pure helpers: RTS table, unit boundary, training week.
function helpers(extra = {}) {
    const s = storage();
    const c = vm.createContext({ ...s, normalizeExName: n => n, console, ...extra });
    c.window = c;
    vm.runInContext(section('const RTS_TABLE =', '// --- HTML ESCAPE ---'), c);
    return c;
}
// A workout row harness around toggleCheck, in the style of review_pr_test.cjs.
function workout(overrides = {}) {
    const elements = new Map(), insults = [], toasts = [];
    let stamp = 1000;
    const c = helpers({
        document: { getElementById: id => elements.get(id) || null, querySelector: () => null, querySelectorAll: () => [] },
        Date: { now: () => ++stamp, parse: Date.parse },
        getWorkoutKey: () => 'test_w1_d1', isBodyweightExercise: () => false, getResolved1RM: () => 0,
        fireConfetti() {}, showPRToast: (...a) => toasts.push(a), showInsultToast: n => insults.push(n),
        checkAndAddTargetRpeSet() {}, startTimer() {}, insultedThisSession: {}, navigator: {},
        Event: class { constructor(type) { this.type = type; } },
        getUnit: () => c.localStorage.getItem('preferredUnit') || 'kg', ...overrides
    });
    c.saveSessionState = (key, value) => {
        const session = c.safeParse(c.getWorkoutKey(), {});
        if (value === undefined) delete session[key]; else session[key] = value;
        c.localStorage.setItem(c.getWorkoutKey(), JSON.stringify(session));
    };
    c.addRow = (set, load, { reps = 5, rpe = 8, blocktype = 'top' } = {}) => {
        const id = `ex-0_b0_s${set}`;
        const check = { id: `${id}_check`, dataset: { norest: 'true', blocktype }, classList: classes() };
        elements.set(check.id, check);
        for (const [field, value] of Object.entries({ load, reps, rpe })) {
            elements.set(`${id}_${field}`, { id: `${id}_${field}`, value: String(value), dataset: { exname: 'Bench Press', rowid: id },
                classList: classes(), dispatchEvent() {} });
        }
        return check;
    };
    c.field = id => elements.get(id);
    vm.runInContext(section('window.toggleCheck =', 'function saveSessionState('), c);
    return Object.assign(c, { insults, toasts });
}

test('the e1RM tap keeps a progressed training max and can be undone', () => {
    const c = helpers();
    vm.runInContext(section('function getProgramTrainingMax(', '// Exercises carrying `tmProgression'), c);
    c.localStorage.setItem('global1RMs', JSON.stringify({ 'Bench Press': 100, Squat: 180 }));
    c.localStorage.setItem('programTMs_nSuns', JSON.stringify({ tms: { 'Bench Press': { tm: 97.5, seed: 100 } }, log: {} }));
    // A stale training max (its seed no longer matches the 1RM) must stay stale.
    c.localStorage.setItem('programTMs_Other', JSON.stringify({ tms: { 'Bench Press': { tm: 80, seed: 90 } }, log: {} }));
    const touched = c.setReference1RM('Bench Press', 103.4);
    assert.equal(c.safeParse('global1RMs', {})['Bench Press'], 103.4);
    assert.equal(c.getProgramTrainingMax('nSuns', 'Bench Press', 0.9), 97.5, 'progress survives the tap');
    assert.equal(c.safeParse('programTMs_Other', {}).tms['Bench Press'].seed, 90);
    assert.equal(touched.length, 1);
    c.restoreReference1RM('Bench Press', 100, touched);
    assert.equal(c.safeParse('global1RMs', {})['Bench Press'], 100);
    assert.equal(c.safeParse('programTMs_nSuns', {}).tms['Bench Press'].seed, 100);
    assert.equal(c.getProgramTrainingMax('nSuns', 'Bench Press', 0.9), 97.5);
    // Undoing a first-ever reference removes it again.
    const fresh = c.setReference1RM('Deadlift', 200);
    c.restoreReference1RM('Deadlift', 0, fresh);
    assert.equal(c.safeParse('global1RMs', {}).Deadlift, undefined);
});

test('load fields convert at the boundary and storage stays kg', () => {
    const c = helpers();
    assert.equal(c.kgFromEntry('102.5'), 102.5);
    assert.equal(c.entryFromKg('102.5'), '102.5');
    assert.equal(c.entryFromKg(95), '95');
    assert.equal(c.entryFromKg(''), '');
    assert(Number.isNaN(c.kgFromEntry('')));
    c.localStorage.setItem('preferredUnit', 'lbs');
    const kg = c.kgFromEntry('225');
    assert(Math.abs(kg - 102.058) < 0.01);
    assert.equal(c.entryFromKg(kg), '225', 'a typed pound value comes back unchanged');
    assert.equal(c.entryFromKg(100), '220.5');
    assert.equal(c.loadFieldKgString({ value: '' }), '');
    assert.equal(c.loadFieldKgString({ value: '135' }), String(c.kgFromEntry('135')));
});

test('pound mode rounds suggestions to pound steps and plates the pound inventory', () => {
    const c = helpers({ getEquipmentMode: () => 'bb', getUnit: () => c.localStorage.getItem('preferredUnit') || 'kg' });
    vm.runInContext(section('window.roundForEquipment =', 'function updateDashboard()'), c);
    vm.runInContext(section('const DEFAULT_PLATES_KG', 'window.openPlateSettings ='), c);
    vm.runInContext(section('function platesPerSide(', 'function paintPlateStrips('), c);
    assert.equal(c.roundForEquipment(101.3, 'Bench Press'), 102.5);
    assert.deepEqual(Array.from(c.platesPerSide(100), p => p.w), [25, 15]);
    c.localStorage.setItem('preferredUnit', 'lbs');
    const rounded = c.roundForEquipment(101.3, 'Bench Press'); // 223.3 lb -> 225 lb
    assert.equal(c.entryFromKg(rounded), '225');
    assert.equal(c.getBarbellWeight(), 45);
    assert.deepEqual(Array.from(c.platesPerSide(rounded), p => p.w), [45, 45]);
    assert.equal(c.safeParse('gymPlateInventory', null).length, 7, 'the kilo inventory is untouched');
    assert.equal(c.safeParse('gymPlateInventoryLb', null)[0].w, 45);
});

test('the training week has one start, Saturday unless the lifter changes it', () => {
    const c = helpers();
    const wednesday = new Date(2026, 10, 18, 15, 30); // Wed 18 Nov 2026
    assert.equal(c.weekStartDay(), 6);
    let start = c.weekStartDate(wednesday);
    assert.deepEqual([start.getDay(), start.getDate(), start.getHours()], [6, 14, 0]);
    c.localStorage.setItem('weekStart', '1');
    start = c.weekStartDate(wednesday);
    assert.deepEqual([start.getDay(), start.getDate()], [1, 16]);
    c.localStorage.setItem('weekStart', 'nonsense');
    assert.equal(c.weekStartDay(), 6);
});

test('text rows, main lifts and imported programs are recognised by exact shape', () => {
    const c = helpers({ SBD_PARENTS: { bench: 'Bench Press', squat: 'Squat', deadlift: 'Deadlift' }, activeWorkout: null, completedDays: {}, db: {} });
    vm.runInContext(section('function isNonExerciseName(', 'function lastSessionSets('), c);
    vm.runInContext(section('function isAbandonedEmptyWorkout(', 'const originalInitApp ='), c);
    for (const name of ['Rest Day', 'rest', 'Information', 'Info', 'Notes']) assert.equal(c.isNonExerciseName(name), true, name);
    for (const name of ['Wrestler Bridge', 'Rest-Pause Curl', 'Chest Press', 'Keynote Raise']) assert.equal(c.isNonExerciseName(name), false, name);
    for (const name of ['Squat', 'bench', 'Bench Press', 'Deadlift']) assert.equal(c.isExactSBD(name), true, name);
    for (const name of ['Dumbbell Bench', 'Goblet Squat', 'Single Leg RDL (deadlift)']) assert.equal(c.isExactSBD(name), false, name);
    const ok = { name: 'A', weeks: { 1: { 1: [{ name: 'Row', blocks: [{ sets: 3, reps: 10 }] }] } } };
    assert.equal(c.isValidProgram(ok), true);
    assert.equal(c.isValidProgram({ name: 'A', weeks: { 1: { 1: [] } } }), true, 'an empty day is still a program');
    assert.equal(c.isValidProgram({ name: 'A' }), false);
    assert.equal(c.isValidProgram({ name: 'A', weeks: { 1: { 1: [{ name: 'Row' }] } } }), false);
    assert.equal(c.isValidProgram({ name: 'A', weeks: { 1: { 1: [{ name: 'Row', blocks: [{ reps: 5 }] }] } } }), false);
    // Only a never-used, still-empty on-the-fly workout is cleaned up.
    const empty = { name: 'On-the-Fly Workout', weeks: { 1: { 1: [] } } };
    assert.equal(c.isAbandonedEmptyWorkout('Custom_1', empty), true);
    assert.equal(c.isAbandonedEmptyWorkout('Custom_1', { ...empty, name: 'Push day' }), false);
    assert.equal(c.isAbandonedEmptyWorkout('Custom_1', { name: 'On-the-Fly Workout', weeks: { 1: { 1: [{ name: 'Row', blocks: [] }] } } }), false);
    c.completedDays = { Custom_1_w1_d1: true };
    assert.equal(c.isAbandonedEmptyWorkout('Custom_1', empty), false);
});

test('"last time" lines up with the prescription and reads compactly', () => {
    const c = helpers({ kgDisp: n => n, unitSuffix: () => 'kg', workoutHistoryCache: [
        { id: '2', details: [{ name: 'Squat', sets: [{ load: 100, reps: 5, rpe: '8' }] }] },
        { id: '1', details: [{ name: 'Row', sets: [{ load: 60, reps: 10, rpe: '8' }, { load: 60, reps: 10, rpe: '8', isTargetSet: true }, { load: 60, reps: 9, rpe: '9' }] }] }
    ] });
    vm.runInContext(section('function lastSessionSets(', 'function renderWorkout()'), c);
    const last = c.lastSessionSets('Row');
    assert.equal(last.id, '1');
    assert.equal(last.sets.length, 2, 'engine-added target sets are left out');
    assert.equal(c.lastSessionSets('Curl'), null);
    assert.equal(c.formatLastTime([{ load: 95, reps: 5, rpe: '7' }, { load: 95, reps: 5, rpe: '7' }]), '95 kg × 5 @ 7');
    assert.equal(c.formatLastTime([{ load: 95, reps: 5, rpe: '7' }, { load: 95, reps: 4, rpe: '8' }]), '95 kg × 5, 4 @ 7 to 8');
    assert.equal(c.formatLastTime([{ load: 100, reps: 5 }, { load: 95, reps: 5 }]), '100 × 5, 95 × 5 kg');
    assert.equal(c.formatLastTime([{ load: 0, reps: 8 }, { load: 0, reps: 6 }]), '8, 6 reps');
});

test('"No lift" needs a real shortfall and an RPE the lifter entered', () => {
    // 102.5 x 3 @ 8 is e1RM 119.2 against a 120 reference: plate rounding, not a miss.
    let c = workout({ getResolved1RM: () => 120 });
    c.localStorage.setItem('actualBests', JSON.stringify({ 'Bench Press': { weight: 110, reps: 3, e1rm: 128, date: 1 } }));
    c.toggleCheck(c.addRow(1, 102.5, { reps: 3, rpe: 8 }));
    assert.equal(c.insults.length, 0);
    // 95 x 3 @ 8 is e1RM 110.5: a real miss.
    c = workout({ getResolved1RM: () => 120 });
    c.localStorage.setItem('actualBests', JSON.stringify({ 'Bench Press': { weight: 110, reps: 3, e1rm: 128, date: 1 } }));
    c.toggleCheck(c.addRow(1, 95, { reps: 3, rpe: 8 }));
    assert.equal(c.insults.length, 1);
    // No RPE entered: the conservative RPE 10 reading must never be called a miss.
    c = workout({ getResolved1RM: () => 120 });
    c.localStorage.setItem('actualBests', JSON.stringify({ 'Bench Press': { weight: 110, reps: 3, e1rm: 128, date: 1 } }));
    c.toggleCheck(c.addRow(1, 90, { reps: 5, rpe: '' }));
    assert.equal(c.insults.length, 0);
});

test('a set logged without an RPE can still set a best', () => {
    const c = workout();
    c.toggleCheck(c.addRow(1, 100, { reps: 5, rpe: '' }));
    const best = c.safeParse('actualBests', {})['Bench Press'];
    assert.equal(best.weight, 100);
    assert(Math.abs(best.e1rm - 100 / 0.86) < 0.01, 'read as RPE 10');
});

test('checking a set leaves loads typed into later sets alone and remembers the last load', () => {
    const c = workout();
    const first = c.addRow(1, 100); c.addRow(2, 100); c.addRow(3, 110);
    c.saveSessionState('ex-0_b0_s3_typed', true); // the lifter planned a heavier third set
    c.field('ex-0_b0_s1_load').value = '102.5';
    c.toggleCheck(first);
    assert.equal(c.field('ex-0_b0_s2_load').value, '102.5', 'an untouched set follows');
    assert.equal(c.field('ex-0_b0_s3_load').value, '110', 'a typed set does not');
    const session = c.safeParse('test_w1_d1', {});
    assert.equal(session['ex-0_b0_s2_load'], '102.5');
    assert.equal(session['ex-0_b0_s3_load'], undefined);
    const used = c.safeParse('lastUsedWeights', {})['Bench Press'];
    assert.equal(used._b0_s1, '102.5');
    assert.equal(used.fallback, '102.5', 'seeds set positions that were never done');
});

test('in pound mode a checked set is stored in kg and cascades in pounds', () => {
    const c = workout();
    c.localStorage.setItem('preferredUnit', 'lbs');
    const first = c.addRow(1, 225); c.addRow(2, 200);
    c.toggleCheck(first);
    const session = c.safeParse('test_w1_d1', {});
    assert(Math.abs(parseFloat(session['ex-0_b0_s1_load']) - 102.059) < 0.01);
    assert.equal(c.field('ex-0_b0_s2_load').value, '225');
    assert(Math.abs(c.safeParse('actualBests', {})['Bench Press'].weight - 102.059) < 0.01);
});
