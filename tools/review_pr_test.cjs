// Run with: node tools/review_pr_test.cjs
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
function context() {
    const stores = new Map(), elements = new Map();
    let stamp = 1000;
    const c = vm.createContext({
        localStorage: { getItem: k => stores.get(k) ?? null, setItem: (k, v) => stores.set(k, String(v)), removeItem: k => stores.delete(k) },
        safeParse: (k, fallback) => stores.has(k) ? JSON.parse(stores.get(k)) : fallback,
        document: { getElementById: id => elements.get(id) || null, querySelector: () => null, querySelectorAll: () => [] },
        Date: { now: () => ++stamp, parse: Date.parse }, normalizeExName: n => n,
        getWorkoutKey: () => 'test_w1_d1', isBodyweightExercise: () => false, getResolved1RM: () => 0,
        fireConfetti() {}, showPRToast() {}, checkAndAddTargetRpeSet() {}, startTimer() {},
        workoutHistoryCache: [], kgDisp: n => n, navigator: {}, console
    });
    c.window = c;
    c.saveSessionState = (key, value) => {
        const session = c.safeParse(c.getWorkoutKey(), {});
        if (value === undefined) delete session[key]; else session[key] = value;
        c.localStorage.setItem(c.getWorkoutKey(), JSON.stringify(session));
    };
    c.addRow = (block, load, reps = 1) => {
        const id = `ex-0_b${block}_s1`;
        const check = { id: `${id}_check`, dataset: { norest: 'true' }, classList: classes() };
        elements.set(check.id, check);
        for (const [field, value] of Object.entries({ load, reps, rpe: 10 })) {
            elements.set(`${id}_${field}`, { id: `${id}_${field}`, value: String(value), dataset: { exname: 'Row', rowid: id }, classList: classes() });
        }
        elements.set(`e1rm-btn-${id}`, { dataset: {}, classList: classes() });
        return check;
    };
    vm.runInContext(section('const RTS_TABLE =', '// --- HTML ESCAPE ---'), c);
    vm.runInContext(section('window.toggleCheck =', 'function saveSessionState('), c);
    vm.runInContext(section('function rebuildPRHistoryFromWorkouts()', '// ── Feature 2:'), c);
    vm.runInContext(section('const calculateTrigger =', "document.querySelectorAll('.calc-trigger')") + '\nwindow.calculateTrigger = calculateTrigger;', c);
    return c;
}

test('missing RPE defaults to 10 while explicit RPE zero is preserved', () => {
    const c = context();
    for (const missing of [null, undefined, '', '  ', NaN]) {
        assert.equal(c.rtsE1RM(100, 1, missing), 100);
    }
    assert(c.rtsE1RM(100, 1, 0) > 100);
    assert(c.rtsPct(10, 15) < c.rtsPct(10, 12));
});

for (const order of [[0, 1, 2], [2, 0, 1], [1, 2, 0]]) {
    test(`PR undo order ${order.join(',')} preserves remaining PRs and the prior best`, () => {
        const c = context();
        const prior = { weight: 100, reps: 1, e1rm: 100, date: 50 };
        c.localStorage.setItem('actualBests', JSON.stringify({ Row: prior }));
        c.localStorage.setItem('prHistory', JSON.stringify({ Row: [prior] }));
        const rows = [110, 120, 130].map((load, index) => c.addRow(index, load));
        rows.forEach(row => c.toggleCheck(row));
        const remaining = new Set([0, 1, 2]);
        for (const index of order) {
            c.toggleCheck(rows[index]);
            remaining.delete(index);
            const expected = Math.max(100, ...Array.from(remaining, i => 110 + i * 10));
            assert.equal(c.safeParse('actualBests', {}).Row.weight, expected);
            assert.equal(c.safeParse('prHistory', {}).Row.length, remaining.size + 1);
        }
    });
}

test('unchecking all first-ever PRs leaves no phantom best', () => {
    const c = context(), first = c.addRow(0, 100), second = c.addRow(1, 110);
    c.toggleCheck(first);
    c.toggleCheck(second);
    c.toggleCheck(first);
    assert.equal(c.safeParse('actualBests', {}).Row.weight, 110);
    c.toggleCheck(second);
    assert.equal(c.safeParse('actualBests', {}).Row, undefined);
    assert.equal(c.safeParse('prHistory', {}).Row, undefined);
});

test('high-rep sets remain estimates but cannot earn live or rebuilt PRs', () => {
    const c = context();
    c.localStorage.setItem('actualBests', JSON.stringify({ Row: { weight: 100, reps: 1, e1rm: 100, date: 50 } }));
    const highRep = c.addRow(0, 150, 20);
    const input = c.document.getElementById('ex-0_b0_s1_load');
    const button = c.document.getElementById('e1rm-btn-ex-0_b0_s1');
    c.calculateTrigger({ target: input });
    assert(button.dataset.e1rm > 100, 'The high-rep estimate is still displayed');
    assert.equal(button.classList.contains('pr'), false);
    c.toggleCheck(highRep);
    assert.equal(c.safeParse('actualBests', {}).Row.weight, 100);
    c.workoutHistoryCache = [{ id: '2000', details: [{ name: 'Row', sets: [
        { load: 100, reps: 12, rpe: 10 }, { load: 150, reps: 20, rpe: 10 }
    ] }] }];
    c.localStorage.setItem('prHistoryRTS_v2', '1');
    c.rebuildPRHistoryFromWorkouts();
    assert.equal(c.safeParse('actualBests', {}).Row.reps, 12);
    assert(c.safeParse('prHistory', {}).Row.every(entry => entry.reps <= 12));
});
