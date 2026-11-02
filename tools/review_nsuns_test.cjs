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
const context = vm.createContext({ safeParse: () => refs,
    normalizeExName: name => name === 'Overhead Press' ? 'Overhead Press (bench)' : name });
vm.runInContext(app.slice(app.indexOf('function getPercentageTrainingMax('), app.indexOf('// Renders the exercise title')), context);

test('32 sessions preserve ordered waves, 17 sets per day and seven weekly AMRAPs', () => {
    assert.equal(Object.keys(program.weeks).length, 8);
    const reps = [[8,6,4,4,4,5,6,7,8], [5,3,1,3,3,3,5,5,5], [5,3,1,3,5,3,5,3,5], [5,3,1,3,3,3,3,3,3]];
    for (const week of Object.values(program.weeks)) {
        assert.equal(Object.keys(week).length, 4);
        let amraps = 0;
        Object.values(week).forEach((day, d) => {
            assert.equal(day.length, 2);
            assert.equal(day.flatMap(ex => ex.blocks).reduce((n,b) => n+b.sets, 0), 17);
            assert.deepEqual(Array.from(day[0].blocks, b => b.reps), reps[d]);
            assert.deepEqual(Array.from(day[0].blocks, b => b.pct), d === 0
                ? [.65,.75,.85,.85,.85,.80,.75,.70,.65] : [.75,.85,.95,.90,.85,.80,.75,.70,.65]);
            assert.deepEqual(Array.from(day[0].blocks, (b,i) => b.amrap ? i+1 : 0).filter(Boolean), d === 0 ? [9] : [3,9]);
            amraps += day.flatMap(ex => ex.blocks).filter(b => b.amrap).length;
            day.forEach(ex => ex.blocks.forEach(b => assert.equal(b.targetRpe, undefined)));
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
