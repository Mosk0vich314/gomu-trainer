// Browser regression check for the program editor. Run with Playwright on NODE_PATH.
// Uses synthetic programs in an isolated browser and a local static server.
const assert = require('node:assert/strict');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) {
    // Not a pass: the browser checks did not run. Put Playwright on NODE_PATH to run them.
    console.log('SKIPPED ' + require('node:path').basename(__filename) + ': Playwright is not on NODE_PATH');
    process.exit(0);
}
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

(async () => {
    const server = http.createServer((req, res) => {
        const pathname = new URL(req.url, 'http://localhost').pathname.replace(/^\/$/, '/index.html');
        if (!/^\/(?:index\.html|sw\.js|scripts\/(?:(?:app|technique-guide|program-editor|video-analysis|video-analysis-core)\.js|database\.enc)|styles\/[\w.-]+\.css|assets\/[\w/.-]+)$/.test(pathname) || pathname.includes('..')) { res.writeHead(404).end(); return; }
        const file = path.join(__dirname, '..', pathname);
        if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
        const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };
        res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
    });
    await new Promise(resolve => server.listen(8768, '127.0.0.1', resolve));
    const browser = await chromium.launch({ headless: true, channel: 'msedge' });
    try {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.goto('http://127.0.0.1:8768');
        await page.evaluate(async () => {
            const day = main => [
                { name: main, type: 'main', percentageReference: main, trainingMaxFactor: 0.9, blocks: [{ sets: 1, reps: 3, type: 'top', targetRpe: 8, pct: 0.85, restSec: 240 }, { sets: 3, reps: 5, type: 'backoff', pct: 0.75, amrap: true }] },
                { name: 'Dumbbell Row', type: 'accessory', blocks: [{ sets: 3, reps: 10, type: 'acc', targetRpe: 8 }] }
            ];
            window.db = { Demo: { name: 'Demo Strength Block', weeks: { 1: { 1: day('Squat'), 2: day('Bench Press') }, 2: { 1: day('Squat'), 2: day('Bench Press') } } } };
            localStorage.setItem('global1RMs', JSON.stringify({ Squat: 180, 'Bench Press': 120 }));
            localStorage.setItem('onboardingSkipped', '1');
            document.getElementById('login-screen').style.display = 'none';
            await initApp();
            switchTab('library-screen');
            document.getElementById('custom-folder').open = true;
        });
        const editor = page.locator('#program-editor');
        const confirmOk = async () => { await page.locator('#confirm-ok').click(); await page.waitForTimeout(200); };

        // A new program: refused while unnamed, then built from the controls.
        await page.locator('#custom-folder .pe-new').click();
        assert.equal(await editor.locator('.pe-head h2').innerText(), 'New program');
        await editor.locator('[data-act="save"]').click();
        assert.match(await editor.locator('.pe-error').innerText(), /name/);
        await editor.locator('[data-field="name"]').pressSequentially('Garage block');
        assert.equal(await editor.locator('.pe-error').isHidden(), true, 'the complaint clears once something changes');
        await editor.locator('[data-act="add-ex"]').click();
        await editor.locator('.pe-ex-name').last().pressSequentially('Squat');
        await editor.locator('[data-act="ex-type"][data-value="main"]').click();
        await editor.locator('.pe-block [data-field="sets"]').first().fill('5');
        await editor.locator('.pe-block [data-field="reps"]').first().fill('5');
        await editor.locator('.pe-block [data-field="targetRpe"]').first().fill('8');
        await editor.locator('.pe-block [data-field="pct"]').first().fill('80');
        await editor.locator('.pe-block select').first().selectOption('top');
        await editor.locator('[data-act="add-block"]').click();
        await editor.locator('.pe-block [data-field="sets"]').nth(1).fill('2');
        await editor.locator('[data-act="add-day"]').click();
        await editor.locator('[data-act="add-ex"]').click();
        await editor.locator('.pe-ex-name').last().pressSequentially('Bench Press');
        await editor.locator('[data-act="dup-week"]').click();
        // The panel fits a phone: nothing wider than the viewport.
        assert(await page.evaluate(() => document.querySelector('#program-editor .pe-body').scrollWidth <= 390), 'editor must not scroll sideways');
        await editor.locator('[data-act="save"]').click();
        await page.waitForTimeout(300);
        const saved = await page.evaluate(() => {
            const store = safeParse('userPrograms', {}), id = Object.keys(store)[0], p = store[id];
            const card = document.querySelector(`.program-card[data-program-id="${id}"]`);
            return { id, name: p.name, weeks: Object.keys(p.weeks).length, days: Object.keys(p.weeks[2]).length, first: p.weeks[2][1][0], inDb: !!db[id],
                card: card ? card.textContent.replace(/\s+/g, ' ').trim() : '', closed: document.getElementById('program-editor').hidden };
        });
        assert.deepEqual([saved.name, saved.weeks, saved.days, saved.inDb, saved.closed], ['Garage block', 2, 2, true, true]);
        assert.deepEqual(saved.first.blocks.map(b => [b.sets, b.reps, b.targetRpe, b.pct, b.type]), [[5, 5, 8, 0.8, 'top'], [2, 5, 8, 0.8, 'top']]);
        assert.equal(saved.first.type, 'main');
        assert.match(saved.card, /Garage block.*2 wk/);

        // It runs like a database program, and cannot be edited mid-session.
        await page.evaluate(id => startProgram(id), saved.id);
        const run = await page.evaluate(() => ({ spine: getComputedStyle(document.querySelector('.spine-wrap')).display, weeks: document.querySelectorAll('#week-pills .spine-col').length,
            days: document.querySelectorAll('#day-pills .dtab').length, cards: document.querySelectorAll('.exercise-container').length }));
        assert.deepEqual([run.spine !== 'none', run.weeks, run.days, run.cards], [true, 2, 2, 1]);
        await page.evaluate(() => toggleWorkoutState('start'));
        assert.equal(await page.evaluate(() => localStorage.getItem('activeProgram')), saved.id);
        await page.evaluate(id => { openProgramEditor(id); }, saved.id);
        await page.waitForTimeout(200);
        assert.equal(await page.locator('#confirm-title').innerText(), 'Finish your session first');
        assert.equal(await editor.count() === 0 || await editor.isHidden(), true);
        await confirmOk();
        await page.evaluate(() => { document.getElementById('ex-0_b0_s1_check').click(); });
        await page.evaluate(() => toggleWorkoutState('finish'));
        await page.waitForTimeout(600);
        assert.match(await page.evaluate(() => { switchTab('home-screen'); return document.getElementById('hero-program-detail').innerText; }), /Week 1, day 2 of Garage block/);

        // Changing the layout of a program with progress asks first, restarts it, keeps history.
        await page.evaluate(id => { openProgramEditor(id); }, saved.id);
        await editor.locator('[data-act="week"][data-value="2"]').click();
        await editor.locator('[data-act="del-week"]').click();
        await confirmOk();
        await editor.locator('[data-act="save"]').click();
        await page.waitForTimeout(200);
        assert.equal(await page.locator('#confirm-title').innerText(), 'Start the program again?');
        await confirmOk();
        assert.deepEqual(await page.evaluate(id => [Object.keys(db[id].weeks).length, Object.keys(completedDays).filter(k => k.startsWith(id)).length, workoutHistoryCache.length], saved.id), [1, 0, 1]);

        // A built-in program is edited as a copy; fields the editor does not show survive.
        await page.evaluate(() => { currentProgram = 'Demo'; openProgramEditor('Demo'); });
        await page.waitForTimeout(200);
        assert.equal(await page.locator('#confirm-title').innerText(), 'Edit a copy?');
        await confirmOk();
        await editor.locator('.pe-block [data-field="sets"]').first().fill('2');
        await editor.locator('[data-act="save"]').click();
        await page.waitForTimeout(300);
        const copy = await page.evaluate(() => {
            const store = safeParse('userPrograms', {}), id = Object.keys(store).find(k => store[k].copyOf === 'Demo'), ex = store[id].weeks[1][1][0];
            return { id, name: store[id].name, sets: ex.blocks[0].sets, restSec: ex.blocks[0].restSec, amrap: ex.blocks[1].amrap, ref: ex.percentageReference, original: db.Demo.weeks[1][1][0].blocks[0].sets };
        });
        assert.deepEqual([copy.name, copy.sets, copy.restSec, copy.amrap, copy.ref, copy.original], ['Demo Strength Block (my copy)', 2, 240, true, 'Squat', 1]);

        // Backups: the export has both; the Gist leaves the copy of a built-in out; a restore never deletes it.
        const backup = await page.evaluate(async () => {
            const full = await collectBackup(false);
            localStorage.setItem('gistPAT', 'test-token');
            let body = null;
            const realFetch = window.fetch;
            window.fetch = async (url, opts) => { body = JSON.parse(opts.body); return { ok: true, json: async () => ({ id: 'gist123' }) }; };
            await gdriveBackup();
            window.fetch = realFetch;
            const sent = JSON.parse(body.files['gomu-trainer-backup.json'].content);
            await applyBackup(sent);
            localStorage.removeItem('gistPAT'); localStorage.removeItem('gistId');
            return { local: Object.keys(full.userPrograms).length, gist: Object.keys(sent.userPrograms), kept: Object.keys(safeParse('userPrograms', {})).length, history: sent.workoutHistory.length };
        });
        assert.deepEqual([backup.local, backup.gist, backup.kept, backup.history], [2, [saved.id], 2, 1]);

        // A restart loads them again, and a program can be deleted.
        assert.equal(await page.evaluate(async ids => { ids.forEach(id => delete db[id]); await initApp(); return ids.every(id => !!db[id] && !!db[id].weeks); }, [saved.id, copy.id]), true);
        await page.evaluate(id => { switchTab('library-screen'); deleteUserProgram(id); }, copy.id);
        await page.waitForTimeout(200);
        await confirmOk();
        assert.equal(await page.evaluate(id => !safeParse('userPrograms', {})[id] && !db[id], copy.id), true);

        assert.deepEqual(errors, []);
        console.log('PASS: new program from the controls, validation, library card, runs as a database program, no editing mid-session, layout change restarts progress, editable copy of a built-in keeps hidden fields, Gist leaves copies out, restore keeps them, reload, delete.');
    } finally {
        await browser.close();
        server.close();
    }
})().catch(error => { console.error(error); process.exit(1); });
