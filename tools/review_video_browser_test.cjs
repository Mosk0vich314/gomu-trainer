// Run with Playwright on NODE_PATH. Synthetic encoded footage tests the actual
// browser decoder/tracker/save path; it does NOT validate real-world RPE accuracy.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { chromium } = require('playwright');

(async () => {
    const server = http.createServer((req, res) => {
        const pathname = new URL(req.url, 'http://localhost').pathname.replace(/^\/$/, '/index.html');
        if (!/^\/(?:index\.html|sw\.js|scripts\/(?:(?:app|technique-guide|technique-models|video-analysis|video-analysis-core)\.js|database\.enc)|styles\/[\w.-]+\.css|assets\/[\w/.-]+)$/.test(pathname) || pathname.includes('..')) { res.writeHead(404).end(); return; }
        const file = path.join(__dirname, '..', pathname);
        if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' })[path.extname(file)] || 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
    });
    await new Promise(resolve => server.listen(8767, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ headless: true, channel: 'msedge' });
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
        const page = await context.newPage(), errors = [], posts = [];
        page.on('pageerror', e => errors.push(e.message)); page.on('request', r => { if (r.method() === 'POST') posts.push(r.url()); });
        await page.goto('http://127.0.0.1:8767');
        // Simulate an existing installation that already ran the old alias migration.
        await page.evaluate(() => {
            localStorage.setItem('exerciseDB_v1', '1');
            localStorage.removeItem('exerciseDB_v2');
            localStorage.setItem('global1RMs', JSON.stringify({ 'Barbell Bench': 110, 'Bench Press': 100 }));
            localStorage.setItem('lastUsedWeights', JSON.stringify({ 'Barbell Bench': 80 }));
            localStorage.setItem('equipmentModes', JSON.stringify({ 'Barbell Bench': 'bb' }));
        });
        await page.reload();
        assert.deepEqual(await page.evaluate(() => ({
            rms: JSON.parse(localStorage.getItem('global1RMs')),
            weights: JSON.parse(localStorage.getItem('lastUsedWeights')),
            equipment: JSON.parse(localStorage.getItem('equipmentModes')),
            migrated: localStorage.getItem('exerciseDB_v2')
        })), { rms: { 'Bench Press': 110 }, weights: { 'Bench Press': 80 }, equipment: { 'Bench Press': 'bb' }, migrated: '1' });
        await page.evaluate(() => {
            window.db = { VideoTest: { name: 'Video test', weeks: { 1: { 1: [
                { name: 'Bench Press', type: 'main', blocks: [{ sets: 3, reps: 3, targetRpe: 8 }] },
                { name: 'Dumbbell Bench Press', type: 'accessory', blocks: [{ sets: 3, reps: 5 }] }
            ] } } } };
            currentProgram = 'VideoTest'; selectedWeek = '1'; selectedDay = '1';
            document.getElementById('login-screen').style.display = 'none';
            applyTheme('Expedition'); switchTab('workout-screen'); renderWorkout();
            const load = document.getElementById('ex-0_b0_s1_load'); load.value = '100'; load.dispatchEvent(new Event('input', { bubbles: true }));
            window.testUrls = new Set(); const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
            URL.createObjectURL = blob => { const url = create(blob); testUrls.add(url); return url; };
            URL.revokeObjectURL = url => { testUrls.delete(url); revoke(url); };
        });
        assert.equal(await page.getByRole('button', { name: 'Analyze video', exact: true }).count(), 1);
        for (const name of ['Bench', 'Barbell Bench', 'Barbell Bench Press', 'Bench (Barbell)', 'Bench Press']) {
            await page.evaluate(name => { db.VideoTest.weeks[1][1][0].name = name; renderWorkout(); }, name);
            const entry = page.getByRole('button', { name: 'Analyze video', exact: true });
            assert.equal(await entry.isVisible(), true, name);
            assert.equal(await entry.isEnabled(), true, name);
            assert.equal(await page.evaluate(name => normalizeExName(name), name), 'Bench Press');
            await entry.click();
            await page.locator('#va-file').waitFor();
            await page.getByRole('button', { name: 'Close video analysis' }).click();
        }
        await page.evaluate(() => { completedDays[getWorkoutKey()] = true; renderWorkout(); });
        assert.equal(await page.locator('.bench-video-button').isVisible(), true);
        assert.equal(await page.locator('.bench-video-button').isDisabled(), true);
        assert.match(await page.locator('.bench-video-entry').innerText(), /unfinished workout/);
        await page.evaluate(() => { delete completedDays[getWorkoutKey()]; setEquipmentMode('Bench', '1db'); });
        assert.equal(await page.locator('.bench-video-button').isVisible(), true);
        assert.equal(await page.locator('.bench-video-button').isDisabled(), true);
        assert.match(await page.locator('.bench-video-entry').innerText(), /select BB/);
        await page.evaluate(() => {
            setEquipmentMode('Barbell Bench', 'bb');
            const load = document.getElementById('ex-0_b0_s1_load'); load.value = '100'; load.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await page.locator('#ex-0').screenshot({ path: path.join(os.tmpdir(), 'gomu-video-entry.png') });
        // Generate three known presses, including slower later reps, into a real VP8 file.
        const bytes = await page.evaluate(async () => {
            const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 360;
            const ctx = canvas.getContext('2d');
            const stream = canvas.captureStream(20), recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 1500000 });
            const chunks = []; recorder.ondataavailable = e => chunks.push(e.data);
            const done = new Promise(resolve => { recorder.onstop = async () => resolve(Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()))); });
            const phases = [[.5,100,100]];
            [1,1.25,1.5].forEach(up => phases.push([.6,100,180],[.25,180,180],[up,180,100],[.35,100,100]));
            phases.push([.5,100,100]); const total = phases.reduce((s,p)=>s+p[0],0), start = performance.now();
            recorder.start();
            await new Promise(resolve => {
                const frame = () => {
                    let t = (performance.now() - start) / 1000, remaining = t, y = 100;
                    for (const [duration, a, b] of phases) { if (remaining <= duration) { y = a + (b-a)*remaining/duration; break; } remaining -= duration; }
                    ctx.fillStyle = '#172b36'; ctx.fillRect(0,0,480,360);
                    ctx.strokeStyle = '#32616a'; for(let x=0;x<480;x+=40) {ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,360);ctx.stroke();}
                    ctx.fillStyle = '#dadada'; ctx.beginPath(); ctx.arc(240,y,45,0,Math.PI*2);ctx.fill();
                    ctx.strokeStyle = '#222';ctx.lineWidth=5;ctx.stroke();
                    for(let i=0;i<6;i++){const a=i*Math.PI/3;ctx.beginPath();ctx.moveTo(240,y);ctx.lineTo(240+36*Math.cos(a),y+36*Math.sin(a));ctx.stroke();}
                    ctx.fillStyle='#ffc801';ctx.beginPath();ctx.arc(240,y,9,0,Math.PI*2);ctx.fill();
                    if(t >= total) {recorder.stop();stream.getTracks().forEach(t=>t.stop());resolve();} else setTimeout(frame,25);
                };frame();
            }); return done;
        });
        const file = { name: 'synthetic-bench.webm', mimeType: 'video/webm', buffer: Buffer.from(bytes) };
        const open = async () => { await page.getByRole('button', { name: 'Analyze video', exact: true }).click(); await page.locator('#va-file').waitFor(); };
        await open();
        for (const width of [320,390,768]) {
            await page.setViewportSize({ width, height: 844 });
            assert.equal(await page.locator('.va-body').evaluate(e => e.scrollWidth > e.clientWidth + 1), false);
        }
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('#va-file').setInputFiles(file);
        await page.locator('#va-editor').waitFor({ state: 'visible', timeout: 25000 });
        await page.locator('#va-style').selectOption('paused');
        await page.locator('#va-mark').click();
        await page.locator('#va-canvas').click({ position: { x: 240 / 480 * 348, y: 100 / 360 * 261 } });
        await page.locator('#va-canvas').click({ position: { x: 285 / 480 * 348, y: 100 / 360 * 261 } });
        await page.locator('#va-analyze').click();
        await page.waitForFunction(() => document.querySelector('.va-progress').hidden);
        const status = await page.locator('#va-status').innerText();
        assert.equal(await page.locator('#va-results').isVisible(), true, status);
        assert.equal(await page.locator('#va-rep-rows tr').count(), 3);
        assert.match(await page.locator('#va-estimate').innerText(), /at least 6/);
        assert.equal(await page.locator('#va-save').isDisabled(), true);
        await page.locator('#va-verified').check(); await page.locator('#va-rating').fill('7.5');
        await page.locator('.va-body').evaluate(e => e.scrollTop = e.scrollHeight);
        await page.locator('#bench-video-lab').screenshot({ path: path.join(os.tmpdir(), 'gomu-video-results.png') });
        // A session storage failure must keep the dialog and roll back calibration.
        await page.evaluate(() => {
            window.testSetItem = Storage.prototype.setItem;
            Storage.prototype.setItem = function(key, value) {
                if (key === 'VideoTest_w1_d1') throw new DOMException('Full', 'QuotaExceededError');
                return testSetItem.call(this, key, value);
            };
        });
        await page.locator('#va-save').click();
        assert.match(await page.locator('#va-status').innerText(), /Could not save/);
        assert.equal(await page.evaluate(() => localStorage.getItem('videoRpeCalibration')), null);
        await page.evaluate(() => { Storage.prototype.setItem = testSetItem; });
        await page.locator('#va-save').click();
        await page.locator('#bench-video-lab').waitFor({ state: 'detached' });
        assert.equal(Number(await page.locator('#ex-0_b0_s1_rpe').inputValue()), 8);
        const saved = await page.evaluate(() => safeParse(getWorkoutKey(), {})['ex-0_b0_s1_video']);
        assert.equal(saved.reps, 3); assert.equal(saved.ownRpe, 7.5); assert.equal(saved.reviewed, true);
        assert(Math.abs(saved.lastVelocity - .267) < .05, `Speed ${saved.lastVelocity}`);
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('videoRpeCalibration')).length), 1);
        const backup = await page.evaluate(async () => collectBackup(false));
        assert.equal(JSON.parse(backup.preferences.videoRpeCalibration).length, 1);
        assert.equal(backup.workoutSessions.VideoTest_w1_d1['ex-0_b0_s1_video'].reps, 3);
        assert.equal(await page.evaluate(() => testUrls.size), 0);
        // Cancelling an analysis must not create or alter a saved result.
        await open(); await page.locator('#va-file').setInputFiles(file);
        await page.locator('#va-editor').waitFor({ state: 'visible', timeout: 25000 });
        await page.locator('#va-style').selectOption('paused');
        await page.locator('#va-mark').click();
        await page.locator('#va-canvas').click({ position: { x: 174, y: 72.5 } });
        await page.locator('#va-canvas').click({ position: { x: 206.625, y: 72.5 } });
        await page.locator('#va-analyze').click();
        await page.locator('#va-cancel').click();
        await page.waitForFunction(() => document.getElementById('va-status').textContent.includes('cancelled'));
        assert.equal(await page.locator('#va-results').isVisible(), false);
        assert.equal(await page.evaluate(() => safeParse(getWorkoutKey(), {})['ex-0_b0_s1_video'].ownRpe), 7.5);
        await page.keyboard.press('Escape');
        await page.locator('#bench-video-lab').waitFor({ state: 'detached' });
        assert.equal(await page.evaluate(() => testUrls.size), 0);
        assert.equal(await page.evaluate(() => document.body.style.overflow), '');
        await page.locator('#ex-0_b0_s1_load').fill('105');
        assert.equal(await page.evaluate(() => safeParse(getWorkoutKey(), {})['ex-0_b0_s1_video']), undefined);
        assert.deepEqual(errors, []); assert.deepEqual(posts, []);
        console.log('PASS: real video decoding/tracking, mobile layout, guarded save, no automatic RPE changes, calibration backup, URL cleanup, and stale-analysis removal. Synthetic footage only.');
    } finally { if (browser) await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
