// Browser regression check. Run with Playwright on NODE_PATH.
// Uses synthetic workout data in an isolated browser and a local static server.
const assert = require('node:assert/strict');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) {
    // Not a pass: the browser checks did not run. Put Playwright on NODE_PATH to run them.
    console.log('SKIPPED ' + require('node:path').basename(__filename) + ': Playwright is not on NODE_PATH');
    process.exit(0);
}
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');

(async () => {
    const server = http.createServer((req, res) => {
        const pathname = new URL(req.url, 'http://localhost').pathname.replace(/^\/$/, '/index.html');
        if (!/^\/(?:index\.html|sw\.js|scripts\/(?:(?:app|technique-guide|video-analysis|video-analysis-core)\.js|database\.enc)|styles\/[\w.-]+\.css|assets\/[\w/.-]+)$/.test(pathname) || pathname.includes('..')) { res.writeHead(404).end(); return; }
        const file = path.join(__dirname, '..', pathname);
        if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
        const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };
        res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
    });
    await new Promise(resolve => server.listen(8766, '127.0.0.1', resolve));
    const browser = await chromium.launch({ headless: true, channel: 'msedge' });
    try {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.goto('http://127.0.0.1:8766');
        await page.evaluate(() => {
            window.db = { TechniqueTest: { name: 'Technique test', weeks: { 1: { 1: [
                { name: 'Bench Press', type: 'main', blocks: [{ sets: 3, reps: 5, targetRpe: 8 }] },
                { name: 'Squat', type: 'main', blocks: [{ sets: 3, reps: 5 }] },
                { name: 'Deadlift', type: 'main', blocks: [{ sets: 3, reps: 5 }] },
                { name: 'Dumbbell Row', type: 'accessory', blocks: [{ sets: 3, reps: 10 }] }
            ] } } } };
            currentProgram = 'TechniqueTest'; selectedWeek = '1'; selectedDay = '1';
            document.getElementById('login-screen').style.display = 'none';
            switchTab('workout-screen'); renderWorkout();
        });
        assert.deepEqual(await page.evaluate(() => ['Bench', 'Paused Bench Press', 'Larsen Press (bench)', 'Squat', 'Sumo Deadlift', 'Single Leg RDL (deadlift)', 'Dumbbell Row', 'Bulgarian Split Squat'].map(getTechniqueLift)), ['bench', 'bench', 'bench', 'squat', 'deadlift', null, null, null]);
        // Use a real workout input without checking off a set or changing history.
        const workoutInput = page.locator('#workout-container input[type="number"]').first();
        await workoutInput.fill('92.5');
        const snapshot = await page.evaluate(() => ({ workout: JSON.stringify(activeWorkout), completed: JSON.stringify(completedDays), prs: localStorage.getItem('actualBests') }));
        await page.getByRole('button', { name: 'Bench Press technique guide', exact: true }).click();
        const guide = page.locator('#technique-guide');
        await guide.locator('.tg-cue-group strong').first().waitFor();
        assert.equal(await guide.locator('[data-lift][aria-selected="true"]').innerText(), 'Bench');
        // Cues are the default tab, grouped by phase of the rep.
        assert.equal(await guide.locator('[data-tab][aria-selected="true"]').innerText(), 'Cues');
        assert.deepEqual(await guide.locator('.tg-cue-phase').allInnerTexts(), ['Start', 'Down', 'Touch', 'Press']);
        await guide.screenshot({ path: path.join(os.tmpdir(), 'gomu-technique-mobile.png') });
        // Tapping a phase holds the schematic there and stops the player.
        await guide.locator('[data-pose="touch"] .tg-cue-phase').click();
        assert.equal(await guide.locator('.tg-phase').innerText(), 'Touch');
        assert.equal(await guide.locator('.tg-scrub').inputValue(), '100');
        // With the bar on the chest the forearm is vertical: elbow straight under the bar, below it.
        const [, benchElbow, benchBar] = (await guide.locator('.tg-limb').getAttribute('points')).split(' ').map(p => p.split(',').map(Number));
        assert.equal(benchElbow[0], benchBar[0]);
        assert(benchElbow[1] - benchBar[1] > 20, 'forearm should hang a forearm length under the bar');
        assert.equal(await guide.locator('.tg-play').getAttribute('aria-pressed'), 'false');
        // The body sliders redraw the figure and the numbers, and are saved and backed up.
        await guide.getByRole('button', { name: 'My body' }).click();
        const travel = () => guide.locator('.tg-stats dd').nth(1).innerText();
        const before = await travel(), figure = await guide.locator('.tg-svg').innerHTML();
        await guide.locator('[data-field="a"]').fill('78');
        assert.notEqual(await travel(), before);
        assert.notEqual(await guide.locator('.tg-svg').innerHTML(), figure);
        assert(!(await guide.locator('.tg-svg').innerHTML()).includes('NaN'));
        await guide.locator('[data-field="h"]').fill('185');
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('techniqueBody')).h), 185);
        assert.equal(await page.evaluate(async () => JSON.parse((await collectBackup(false)).preferences.techniqueBody).a), 78);
        await guide.getByRole('button', { name: 'Use averages for my height' }).click();
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('techniqueBody')).a), null);
        // Setup carries numbers from the body.
        await guide.getByRole('tab', { name: 'Setup' }).click();
        assert.equal(await guide.locator('.tg-steps li').count(), 6);
        assert.match(await guide.locator('.tg-steps .tg-mine').first().innerText(), /^\d+ cm$/);
        // Width: grip from the body, tuned by hand, saved, backed up and carried into Setup.
        await guide.getByRole('tab', { name: 'Width' }).click();
        const grip = guide.locator('[data-w="bg"]');
        const startGrip = await grip.locator('.tg-w-num').innerText();
        assert.match(startGrip, /^\d+ cm$/);
        assert.equal(await grip.locator('.tg-w-reset').isHidden(), true);
        assert.match(await grip.locator('.tg-w-read').innerText(), /^Forearms vertical at the chest/);
        const plan = await guide.locator('.tg-w-svg').innerHTML();
        await grip.locator('input').fill('81');
        assert.equal(await grip.locator('.tg-w-num').innerText(), '81 cm');
        assert.equal(await grip.locator('.tg-w-mark').innerText(), 'Index finger on the ring');
        assert.match(await grip.locator('.tg-w-read').innerText(), /outside the elbows.*widest legal grip/);
        assert.notEqual(await guide.locator('.tg-w-svg').innerHTML(), plan);
        assert(!(await guide.locator('.tg-w-svg').innerHTML()).includes('NaN'));
        assert.equal(await guide.locator('.tg-stats dd').first().innerText(), '81 cm');
        assert.equal(await page.evaluate(async () => JSON.parse((await collectBackup(false)).preferences.techniqueBody).w.bg), 81);
        await guide.getByRole('tab', { name: 'Setup' }).click();
        assert.equal(await guide.locator('.tg-steps .tg-mine').first().innerText(), '81 cm');
        await guide.getByRole('tab', { name: 'Width' }).click();
        await grip.locator('.tg-w-reset').click();
        assert.equal(await grip.locator('.tg-w-num').innerText(), startGrip);
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('techniqueBody')).w.bg), undefined);
        // The conventional deadlift grip follows the stance until it is set by hand.
        await guide.getByRole('tab', { name: 'Deadlift' }).click();
        const pullGrip = () => guide.locator('[data-w="dgc"] .tg-w-num').innerText();
        const narrow = await pullGrip();
        await guide.locator('[data-width="dsc"]').fill('50');
        assert.notEqual(await pullGrip(), narrow);
        await guide.locator('[data-width-reset="dsc"]').click();
        assert.equal(await pullGrip(), narrow);
        await guide.getByRole('tab', { name: 'Bench' }).click();
        // Pin a cue: at most two, shown on the workout card after closing.
        await guide.getByRole('tab', { name: 'Cues' }).click();
        for (const id of ['bp-bend', 'bp-pull', 'bp-away']) await guide.locator(`[data-pin="${id}"]`).click();
        assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('techniqueCues')).bench), ['bp-pull', 'bp-away']);
        assert.equal(await page.evaluate(async () => JSON.parse((await collectBackup(false)).preferences.techniqueCues).bench.length), 2);
        // Switch lift and variant: cues and setup follow.
        await guide.getByRole('tab', { name: 'Deadlift' }).click();
        assert.deepEqual(await guide.locator('.tg-cue-phase').allInnerTexts(), ['Start', 'Off the floor', 'Past the knees', 'Lockout']);
        assert.equal(await guide.locator('[data-pin="dl-spread"]').count(), 0);
        await guide.getByRole('button', { name: 'Sumo', exact: true }).click();
        assert.equal(await guide.getByRole('button', { name: 'Sumo', exact: true }).getAttribute('aria-pressed'), 'true');
        assert.equal(await guide.locator('[data-pin="dl-spread"]').count(), 1);
        assert.equal(await guide.locator('[data-pin="dl-push"]').count(), 0);
        await guide.getByRole('button', { name: 'Conventional', exact: true }).click();
        await guide.locator('.tg-play').click();
        assert.equal(await guide.locator('.tg-play').getAttribute('aria-pressed'), 'true');
        await page.keyboard.press('Escape');
        assert.equal(await guide.getAttribute('open'), null);
        assert.equal(await guide.locator('.tg-play').getAttribute('aria-pressed'), 'false');
        assert.equal(await workoutInput.inputValue(), '92.5');
        assert.deepEqual(await page.evaluate(() => ({ workout: JSON.stringify(activeWorkout), completed: JSON.stringify(completedDays), prs: localStorage.getItem('actualBests') })), snapshot);
        assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Bench Press technique guide');
        assert.deepEqual(await page.locator('#ex-0 [data-technique-cue] .tq-cue').allInnerTexts(), ['Pull the bar to you', 'Push yourself away from the bar']);
        assert.equal((await page.locator('#ex-1 [data-technique-cue]').innerText()).trim(), 'Technique');
        await page.locator('#ex-0').getByRole('button', { name: 'History', exact: true }).click();
        assert.equal(await page.locator('#history-overlay').isVisible(), true);
        await page.evaluate(() => document.getElementById('history-overlay').style.display = 'none');
        await page.getByRole('button', { name: 'Bench Press technique guide', exact: true }).click();
        await guide.getByRole('button', { name: 'My body' }).click();
        for (const width of [320, 390, 768, 1280]) {
            await page.setViewportSize({ width, height: 900 });
            for (const id of ['bench', 'squat', 'deadlift']) {
                for (const tab of ['Setup', 'Cues', 'Width', 'Fixes']) {
                    await page.evaluate(id => openTechniqueGuide(id), id);
                    await guide.getByRole('tab', { name: tab }).click();
                    const overflow = await guide.locator('.tg-body, .tg-model, .tg-read').evaluateAll(els => els.some(el => el.scrollWidth > el.clientWidth + 1));
                    assert.equal(overflow, false, `${id} ${tab} overflows at ${width}px`);
                }
            }
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `workout card overflows at ${width}px`);
        }
        await page.evaluate(() => openTechniqueGuide('bench'));
        await guide.screenshot({ path: path.join(os.tmpdir(), 'gomu-technique-desktop.png') });
        // The guide follows the app theme and faces.
        await page.evaluate(() => document.documentElement.style.setProperty('--accent', '#b491ff'));
        assert.equal(await guide.locator('.tg-phase').evaluate(el => getComputedStyle(el).color), 'rgb(180, 145, 255)');
        assert.match(await guide.locator('.tg-stats dd').first().evaluate(el => getComputedStyle(el).fontFamily), /Sofia Sans Extra Condensed/);
        assert.deepEqual(errors, []);
        await context.close();

        // Measurements saved by the first guide (raw form fields) convert to the new shape.
        const legacyContext = await browser.newContext({ serviceWorkers: 'block' });
        const legacyPage = await legacyContext.newPage();
        await legacyPage.addInitScript(() => localStorage.setItem('techniqueBody', JSON.stringify({ inH: '185', inW: '190', inB: '42', inF: '47', inS: '', inArch: '12' })));
        await legacyPage.goto('http://127.0.0.1:8766');
        await legacyPage.evaluate(() => { openTechniqueGuide('bench'); document.querySelector('.tg-body-btn').click(); });
        assert.equal(await legacyPage.locator('[data-out="h"]').innerText(), '185 cm');
        assert.equal(await legacyPage.locator('[data-out="f"]').innerText(), '47 cm');
        assert.equal(await legacyPage.locator('[data-out="a"]').innerText(), '68 cm');
        assert.equal(await legacyPage.getByRole('button', { name: 'Big arch' }).getAttribute('aria-pressed'), 'true');
        await legacyContext.close();

        // Cache on a fresh installation, then load the guide for the first time offline.
        const offlineContext = await browser.newContext();
        const offlinePage = await offlineContext.newPage();
        await offlinePage.goto('http://127.0.0.1:8766');
        await offlinePage.evaluate(async () => {
            await navigator.serviceWorker.register('./sw.js');
            await Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => setTimeout(() => reject(new Error('Offline installation timed out')), 15000))]);
        });
        await offlinePage.waitForFunction(() => !!navigator.serviceWorker.controller);
        await offlineContext.setOffline(true);
        await offlinePage.reload();
        await offlinePage.evaluate(() => openTechniqueGuide('bench'));
        await offlinePage.locator('#technique-guide .tg-cue-group strong').first().waitFor({ state: 'visible' });
        assert.equal(await offlinePage.evaluate(async () => typeof (await import('./scripts/video-analysis-core.js')).summarizeTrack), 'function');
        assert.equal(await offlinePage.evaluate(() => typeof openBenchVideoAnalysis), 'function');
        await offlineContext.close();
        console.log('PASS: exercise routing, schematic and body sliders, saved measurements/backup, pinned cues on the card, legacy measurements, history, focus, workout preservation, responsive themes, and offline guide.');
    } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });



