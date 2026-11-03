// Run after python tools/import_nsuns.py. Uses only Node built-ins.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'scripts/app.js'), 'utf8');
const db = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'scripts/database.js'), 'utf8'), db);
const program = db.window.db.nsuns_531_4day;
const refs = { 'Bench Press': 100, Squat: 200, Deadlift: 250, 'Overhead Press (bench)': 60, 'Front Squat': 100, 'Close Grip (bench)': 80 };
const storage = {};
const context = vm.createContext({ currentProgram: 'nsuns_531_4day',
    safeParse: (key, fallback) => key === 'global1RMs' ? refs : (key in storage ? JSON.parse(storage[key]) : fallback),
    localStorage: { setItem: (key, value) => { storage[key] = value; } },
    normalizeExName: name => name === 'Overhead Press' ? 'Overhead Press (bench)' : name });
vm.runInContext(app.slice(app.indexOf('function getPercentageTrainingMax('), app.indexOf('// Renders the exercise title')), context);

test('32 sessions preserve ordered waves, 17 main/supplemental sets per day and seven weekly AMRAPs', () => {
    assert.equal(Object.keys(program.weeks).length, 8);
    const reps = [[8,6,4,4,4,5,6,7,8], [5,3,1,3,3,3,5,5,5], [5,3,1,3,5,3,5,3,5], [5,3,1,3,3,3,3,3,3]];
    for (const week of Object.values(program.weeks)) {
        assert.equal(Object.keys(week).length, 4);
        let amraps = 0;
        Object.values(week).forEach((day, d) => {
            assert.equal(day.length, 5);
            assert.equal(day.slice(0, 2).flatMap(ex => ex.blocks).reduce((n,b) => n+b.sets, 0), 17);
            // Expand grouped blocks back into the per-set wave.
            const perSet = Array.from(day[0].blocks.flatMap(b => Array.from({ length: b.sets }, () => b)));
            assert.deepEqual(perSet.map(b => b.reps), reps[d]);
            assert.deepEqual(perSet.map(b => b.pct), d === 0
                ? [.65,.75,.85,.85,.85,.80,.75,.70,.65] : [.75,.85,.95,.90,.85,.80,.75,.70,.65]);
            assert.deepEqual(perSet.map((b,i) => b.amrap ? i+1 : 0).filter(Boolean), d === 0 ? [9] : [3,9]);
            day[0].blocks.forEach((b, i) => assert(i === 0 || b.amrap || day[0].blocks[i-1].amrap
                || b.reps !== day[0].blocks[i-1].reps || b.pct !== day[0].blocks[i-1].pct, 'identical neighbours are grouped'));
            day.flatMap(ex => ex.blocks).forEach(b => assert(b.restSec > 0, 'every set has a rest time'));
            if (d > 0) assert.equal(day[0].tmProgression.block, 3);
            amraps += day.flatMap(ex => ex.blocks).filter(b => b.amrap).length;
            day.slice(0, 2).forEach(ex => ex.blocks.forEach(b => assert.equal(b.targetRpe, undefined)));
            const accessories = day.slice(2);
            assert.equal(accessories.flatMap(ex => ex.blocks).reduce((n,b) => n+b.sets, 0), d % 2 === 0 ? 8 : 7);
            accessories.forEach(ex => {
                assert.equal(ex.type, 'accessory');
                assert.equal(ex.percentageReference, undefined);
                ex.blocks.forEach(b => {
                    assert.equal(b.targetRpe, 8);
                    assert.equal(b.pct, null);
                    assert.equal(b.amrap, undefined);
                });
            });
        });
        assert.equal(amraps, 7);
    }
});

test('training max uses exact prescribed parent and 90% once', () => {
    const week = program.weeks[1];
    const tm = context.getPercentageTrainingMax;
    assert.equal(tm(week[1][1]), 54);
    assert.equal(tm(week[2][1]), 225);
    assert.equal(tm(week[3][1]), 90);
    assert.equal(tm(week[4][1]), 180);
    assert.equal(tm(week[2][0]) * week[2][0].blocks[2].pct, 171);
    delete refs['Overhead Press (bench)'];
    assert.equal(tm(week[1][1]), 0, 'OHP must not use the available bench max');
    assert.equal(tm({ name: 'Bench Press' }), null, 'Existing programs keep their current behavior');
    assert.equal(tm({ ...week[1][0], _originalName: 'Bench Press', name: 'Dumbbell Bench' }), null);
});

test('library card and registry resolve to the injected program', () => {
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const folder = html.slice(html.indexOf('id="boostcamp-folder-content"'), html.indexOf('id="history-screen"'));
    assert(folder.includes('data-program-id="nsuns_531_4day"'));
    const registry = JSON.parse(fs.readFileSync(path.join(root, 'Programs/programs-list.json')));
    assert(registry.programs.some(p => p.id === 'nsuns_531_4day'));
    assert.deepEqual(JSON.parse(JSON.stringify(program.weeks)), JSON.parse(fs.readFileSync(path.join(root, 'Programs/nSuns_531_4Day_database.json'))));
});

test('finishing a 1+ set progresses that TM per program, follows bench with OHP and never stacks a redo', () => {
    const week = program.weeks[1];
    const finish = (key, day, reps) => context.applyTrainingMaxProgression('nsuns_531_4day', key, day,
        { 'ex-0_b2_s1_check': true, 'ex-0_b2_s1_reps': String(reps) });
    refs['Overhead Press (bench)'] = 60;
    const tm = ex => context.getPercentageTrainingMax(ex);
    assert.deepEqual({ ...finish('w1_d2', week[2], 4) }, { Squat: 5 });
    assert.equal(tm(week[2][0]), 185);
    assert.equal(tm(week[4][1]), 185, 'front squat reads the progressed squat TM');
    assert.deepEqual({ ...finish('w1_d2', week[2], 1) }, {}, 'redoing the day reverts, then applies the new result');
    assert.equal(tm(week[2][0]), 180);
    assert.deepEqual({ ...finish('w1_d3', week[3], 6) }, { 'Bench Press': 5, 'Overhead Press (bench)': 2.5 });
    assert.equal(tm(week[3][1]), 95, 'close grip reads the progressed bench TM');
    assert.equal(tm(week[1][1]), 56.5);
    assert.deepEqual({ ...finish('w1_d4', week[4], 2) }, { Deadlift: 2.5 });
    assert.deepEqual({ ...context.applyTrainingMaxProgression('nsuns_531_4day', 'w2_d4', week[4], {}) }, {}, 'unchecked 1+ set changes nothing');
    assert.equal(tm(week[2][1]), 227.5);
    refs.Squat = 210;
    assert.equal(tm(week[2][0]), 189, 'a new Stats 1RM restarts the TM from it');
    assert.equal(refs.Squat, 210, 'progression never writes the global 1RM');
});
