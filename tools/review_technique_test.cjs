// Browser regression check. Run with Playwright on NODE_PATH.
// Uses synthetic workout data in an isolated browser and a local static server.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');

(async () => {
    const server = http.createServer((req, res) => {
        const pathname = new URL(req.url, 'http://localhost').pathname.replace(/^\/$/, '/index.html');
        if (!/^\/(?:index\.html|sw\.js|scripts\/(?:(?:app|technique-guide|technique-models|video-analysis|video-analysis-core)\.js|database\.enc)|styles\/[\w.-]+\.css|assets\/[\w/.-]+)$/.test(pathname) || pathname.includes('..')) { res.writeHead(404).end(); return; }
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
        await guide.locator('#bench h2').waitFor({ state: 'visible' });
        assert.equal(await guide.locator('section.lift:visible').count(), 1);
        assert.equal(await guide.locator('#bench h2').innerText(), 'Bench press');
        await guide.screenshot({ path: path.join(os.tmpdir(), 'gomu-technique-mobile.png') });
        await guide.getByText('Interactive lift models', { exact: true }).click();
        await guide.locator('#bpGrip').fill('60');
        assert.equal(await guide.locator('#bpGripO').innerText(), '60 cm');
        assert(!(await guide.locator('#bpR3').innerText()).includes('NaN'));
        await guide.locator('#bpPlay').click();
        assert.equal(await guide.locator('#bpPlay').getAttribute('aria-pressed'), 'true');
        await guide.getByRole('button', { name: 'Squat', exact: true }).click();
        assert.equal(await guide.locator('#bpPlay').getAttribute('aria-pressed'), 'false');
        assert.equal(await guide.locator('section.lift:visible').getAttribute('id'), 'squat');
        await guide.getByRole('button', { name: 'Your build', exact: true }).click();
        await guide.locator('#inH').fill('185');
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('techniqueBody')).inH), '185');
        assert.equal(await page.evaluate(async () => JSON.parse((await collectBackup(false)).preferences.techniqueBody).inH), '185');
        await guide.getByRole('button', { name: 'Deadlift', exact: true }).click();
        await guide.locator('#deadlift').getByText('Setup & interactive model', { exact: true }).click();
        await guide.locator('#dlSumo').click();
        assert.equal(await guide.locator('#dlSumo').getAttribute('aria-pressed'), 'true');
        await guide.locator('#dlPlay').click();
        await page.keyboard.press('Escape');
        assert.equal(await guide.getAttribute('open'), null);
        assert.equal(await guide.locator('#dlPlay').getAttribute('aria-pressed'), 'false');
        assert.equal(await workoutInput.inputValue(), '92.5');
        assert.deepEqual(await page.evaluate(() => ({ workout: JSON.stringify(activeWorkout), completed: JSON.stringify(completedDays), prs: localStorage.getItem('actualBests') })), snapshot);
        assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Bench Press technique guide');
        await page.locator('#ex-0').getByRole('button', { name: 'History', exact: true }).click();
        assert.equal(await page.locator('#history-overlay').isVisible(), true);
        await page.evaluate(() => document.getElementById('history-overlay').style.display = 'none');
        await page.getByRole('button', { name: 'Bench Press technique guide', exact: true }).click();
        for (const width of [320, 390, 768, 1280]) {
            await page.setViewportSize({ width, height: 900 });
            for (const id of ['bench', 'squat', 'deadlift', 'you', 'principles', 'brace', 'coach']) {
                await page.evaluate(id => openTechniqueGuide(id), id);
                await guide.locator(`#${id} details`).evaluateAll(elements => elements.forEach(el => { el.open = true; }));
                const overflow = await guide.locator('.reader').evaluate(el => el.scrollWidth > el.clientWidth + 1);
                assert.equal(overflow, false, `${id} overflows at ${width}px`);
            }
        }
        await page.evaluate(() => openTechniqueGuide('bench'));
        await guide.screenshot({ path: path.join(os.tmpdir(), 'gomu-technique-desktop.png') });
        // App theme variables must reach the isolated reader and SVGs.
        await page.evaluate(() => document.documentElement.style.setProperty('--accent', '#b491ff'));
        assert.equal(await guide.locator('.guide-label').evaluate(el => getComputedStyle(el).color), 'rgb(180, 145, 255)');
        assert.equal(await guide.locator('#bench h2').evaluate(el => getComputedStyle(el).fontFamily), '"Space Grotesk", sans-serif');
        assert.deepEqual(errors, []);
        await context.close();

        const retryContext = await browser.newContext({ serviceWorkers: 'block' });
        const retryPage = await retryContext.newPage();
        await retryPage.route('**/assets/technique-manual.json', route => route.abort());
        await retryPage.goto('http://127.0.0.1:8766');
        await retryPage.evaluate(() => openTechniqueGuide('bench'));
        await retryPage.getByRole('button', { name: 'Try again' }).waitFor();
        await retryPage.unroute('**/assets/technique-manual.json');
        await retryPage.getByRole('button', { name: 'Try again' }).click();
        await retryPage.locator('#technique-guide #bench h2').waitFor({ state: 'visible' });
        await retryContext.close();

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
        await offlinePage.locator('#technique-guide #bench h2').waitFor({ state: 'visible' });
        assert.equal(await offlinePage.evaluate(async () => typeof (await import('./scripts/video-analysis-core.js')).summarizeTrack), 'function');
        assert.equal(await offlinePage.evaluate(() => typeof openBenchVideoAnalysis), 'function');
        await offlineContext.close();
        console.log('PASS: exercise routing, interactive models, saved measurements/backup, history, focus, workout preservation, responsive themes, and first-open offline guide.');
    } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });



