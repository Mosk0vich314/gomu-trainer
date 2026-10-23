/* Local-only bench video prototype. No upload, cloud API, or saved video blobs. */
(() => {
    let current = null;
    const calibrationKey = 'videoRpeCalibration';
    const markup = `
        <header class="va-header"><div><p>Bench lab · experimental</p><h2>Analyze a bench set</h2></div><button type="button" class="va-close" aria-label="Close video analysis">✕</button></header>
        <div class="va-body">
            <p class="va-intro">Measure your presses, then build a personal RPE profile. Your video stays on this device and is released when you close this window.</p>
            <details class="va-help"><summary>How to film for this prototype</summary><p>Use a stationary side-on camera with a clear view of the plate face. Keep the whole plate visible, use normal-speed video (ideally 60 fps), and press with your normal intent to move quickly. Slow-motion exports, moving cameras, spotter assistance, and deliberate slow-tempo presses are not supported.</p><p>Choose a clip of one set. Trim out the unrack and rerack, starting at lockout before the first lowering. Leave a short hold after the last press. Plate-based distance is an approximation; angled footage can distort it.</p></details>
            <fieldset class="va-settings">
                <div class="va-fields"><label>Set<select id="va-set"></select></label><label>Bench style<select id="va-style"><option value="">Choose style</option><option value="paused">Paused</option><option value="touch-go">Touch and go</option></select></label></div>
                <label class="va-file">Choose set video<input id="va-file" type="file" accept="video/*"></label>
                <div id="va-editor" hidden>
                    <h3>1. Trim and mark the plate</h3>
                    <div class="va-fields"><label>Start (seconds)<input id="va-start" type="number" min="0" step="0.05" value="0"></label><label>End (seconds)<input id="va-end" type="number" min="0" step="0.05"></label><label>Plate diameter (cm)<input id="va-diameter" type="number" min="10" max="60" step="0.1" value="45"></label><label>Reps in this set<input id="va-reps" type="number" min="1" max="20" step="1"></label></div>
                    <p class="va-hint">Use the plate’s actual diameter; 45 cm is a full-size competition plate. Trim to 45 seconds or less.</p>
                    <video id="va-video" playsinline muted preload="auto" hidden></video>
                    <canvas id="va-canvas" tabindex="0" role="img" aria-label="Video frame. Use Mark plate, then click its centre and rim. Keyboard: arrow keys move the marker; Enter places it."></canvas>
                    <label class="va-scrub">Video position <output id="va-time">0.00 s</output><input id="va-position" type="range" min="0" max="1" step="0.05" value="0"></label>
                    <div class="va-buttons"><button type="button" id="va-mark">Mark plate</button><button type="button" id="va-review">Play clip</button></div>
                    <p id="va-mark-help" class="va-hint">Mark the centre of the plate, then a point on its outer rim. Keyboard users can move the marker with arrow keys and place it with Enter.</p>
                    <button type="button" id="va-analyze" class="va-primary">Analyze video</button>
                </div>
            </fieldset>
            <div class="va-progress" hidden><progress max="1" value="0" aria-label="Video analysis progress"></progress><button type="button" id="va-cancel">Cancel analysis</button></div>
            <p id="va-status" role="status" aria-live="polite"></p>
            <section id="va-results" hidden>
                <h3>2. Review the tracking</h3>
                <p class="va-hint">Play or scrub the clip above. The crosshair must stay on the plate throughout every rep. Reject the result if it jumps or follows the background.</p>
                <div id="va-metrics" class="va-metrics"></div>
                <div id="va-chart" class="va-chart"></div>
                <div class="va-table-wrap"><table><thead><tr><th>Rep</th><th>Press time</th><th>Travel</th><th>Mean speed</th></tr></thead><tbody id="va-rep-rows"></tbody></table></div>
                <div class="va-estimate"><h3>Personal RPE estimate</h3><p id="va-estimate"></p><small>Experimental suggestion from your self-ratings. It has not been validated on real lifting videos; check it against how the set felt.</small></div>
                <h3>3. Save your review</h3>
                <label class="va-check"><input id="va-verified" type="checkbox">I reviewed every rep: tracking, rep count, and plate size are correct.</label>
                <label class="va-rating">Your own RPE (optional)<input id="va-rating" type="number" min="6" max="10" step="0.5" placeholder="6–10"></label>
                <p class="va-hint">Use how the set felt, rather than copying the estimate. Your rating helps calibrate future suggestions for this exercise and bench style.</p>
                <label class="va-check"><input id="va-apply" type="checkbox">Also put my rating into this set’s RPE field</label>
                <button type="button" id="va-save" class="va-primary" disabled>Save reviewed analysis</button>
                <p class="va-hint">Only measurements and your optional rating are saved. The video is not retained or included in backups.</p>
            </section>
        </div>`;

    function waitFor(video, event, signal, trigger) {
        return new Promise((resolve, reject) => {
            let timeout;
            const cleanup = () => { clearTimeout(timeout); video.removeEventListener(event, done); video.removeEventListener('error', fail); signal.removeEventListener('abort', abort); };
            const done = () => { cleanup(); resolve(); };
            const fail = () => { cleanup(); reject(new Error('This video could not be decoded. Try a normal-speed MP4 or WebM clip supported by this browser.')); };
            const abort = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')); };
            if (signal.aborted) { abort(); return; }
            video.addEventListener(event, done, { once: true }); video.addEventListener('error', fail, { once: true }); signal.addEventListener('abort', abort, { once: true });
            timeout = setTimeout(() => { cleanup(); reject(new Error('Video decoding timed out. Try a shorter, lower-resolution clip.')); }, 15000);
            try { trigger(); } catch (error) { cleanup(); reject(error); }
        });
    }

    window.openBenchVideoAnalysis = async function(exId, trigger) {
        if (current) { current.dialog.focus(); return; }
        const exercise = document.getElementById(exId);
        if (!exercise) return;
        const inputs = [...exercise.querySelectorAll('input[data-exname][id$="_load"]')];
        if (!inputs.length) return;
        const dialog = document.createElement('dialog');
        dialog.id = 'bench-video-lab'; dialog.setAttribute('aria-label', 'Bench video analysis'); dialog.setAttribute('data-no-tab-swipe', '');
        dialog.innerHTML = markup; document.body.append(dialog);
        const $ = id => dialog.querySelector('#va-' + id);
        const state = { dialog, key: getWorkoutKey(), controller: new AbortController(), url: null, points: [], result: null, center: null, radius: null, mark: 0, raf: 0, closed: false, busy: false, cursor: null, core: null };
        current = state;
        const video = $('video'), canvas = $('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
        const priorOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        inputs.forEach((input, i) => {
            const rowId = input.dataset.rowid, option = document.createElement('option'); option.value = rowId;
            option.textContent = `Set ${i + 1} · ${input.value || '—'} × ${document.getElementById(rowId + '_reps')?.value || '—'}${input.disabled ? ' · logged' : ''}`;
            $('set').append(option);
        });
        const selected = () => {
            const rowId = $('set').value;
            return { rowId, load: document.getElementById(rowId + '_load'), reps: document.getElementById(rowId + '_reps'), rpe: document.getElementById(rowId + '_rpe') };
        };
        const status = message => { $('status').textContent = message; };
        const stopPlayback = () => { video.pause(); cancelAnimationFrame(state.raf); state.raf = 0; $('review').textContent = 'Play clip'; };
        const invalidate = () => { state.result = null; state.points = []; $('results').hidden = true; $('verified').checked = false; $('save').disabled = true; };
        const setBusy = busy => { state.busy = busy; dialog.querySelector('.va-settings').disabled = busy; dialog.querySelector('.va-progress').hidden = !busy; };
        const release = () => {
            state.closed = true; state.controller.abort(); stopPlayback();
            video.removeAttribute('src'); video.load();
            if (state.url) URL.revokeObjectURL(state.url);
            document.body.style.overflow = priorOverflow;
            document.removeEventListener('visibilitychange', visibility);
            dialog.remove(); if (current === state) current = null;
            if (trigger?.isConnected) trigger.focus({ preventScroll: true });
        };
        const visibility = () => { if (document.hidden) { stopPlayback(); if (state.busy) state.controller.abort(); } };
        document.addEventListener('visibilitychange', visibility);
        dialog.addEventListener('close', release, { once: true });
        dialog.querySelector('.va-close').onclick = () => dialog.close();
        dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
        $('cancel').onclick = () => state.controller.abort();

        function draw() {
            if (video.readyState < 2 || state.closed) return;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            let point = state.center;
            if (state.points.length) point = state.points.reduce((a, b) => Math.abs(b.t - video.currentTime) < Math.abs(a.t - video.currentTime) ? b : a);
            const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
            if (state.points.length) {
                ctx.beginPath(); state.points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
                ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.stroke();
            }
            if (point) {
                ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.beginPath();
                ctx.arc(point.x, point.y, state.radius || 7, 0, Math.PI * 2); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(point.x - 10, point.y); ctx.lineTo(point.x + 10, point.y); ctx.moveTo(point.x, point.y - 10); ctx.lineTo(point.x, point.y + 10); ctx.stroke();
            }
            if (state.mark && state.cursor) {
                ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.strokeRect(state.cursor.x - 5, state.cursor.y - 5, 10, 10);
            }
            $('time').textContent = video.currentTime.toFixed(2) + ' s'; $('position').value = video.currentTime;
        }
        async function seek(time) {
            if (state.controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
            if (Math.abs(video.currentTime - time) < .001 && video.readyState >= 2) return;
            await waitFor(video, 'seeked', state.controller.signal, () => { video.currentTime = time; });
        }
        function handleError(error) {
            if (!state.closed) status(error.name === 'AbortError' ? 'Analysis cancelled. You can try again.' : error.message);
        }
        const freshController = () => { state.controller.abort(); state.controller = new AbortController(); };
        const readProfile = () => {
            try { const data = JSON.parse(localStorage.getItem(calibrationKey) || '[]'); return Array.isArray(data) ? data.filter(state.core.validCalibration).slice(-100) : []; } catch { return []; }
        };
        const updateSet = () => { $('reps').value = selected().reps?.value || ''; invalidate(); };
        $('set').onchange = updateSet; updateSet();
        $('file').onchange = async () => {
            const file = $('file').files[0];
            if (!file) return;
            freshController(); stopPlayback(); invalidate(); state.center = null; state.radius = null; state.mark = 0;
            $('editor').hidden = true;
            if (state.url) { URL.revokeObjectURL(state.url); state.url = null; }
            video.removeAttribute('src'); video.load();
            if (file.size > 150 * 1024 * 1024) { status('Choose a clip smaller than 150 MB. Trim or export it at a lower resolution first.'); return; }
            setBusy(true); status('Opening video…');
            try {
                state.url = URL.createObjectURL(file);
                await waitFor(video, 'loadeddata', state.controller.signal, () => { video.src = state.url; video.load(); });
                // Browser-recorded WebM may omit duration metadata. Seeking to the
                // end lets the decoder discover it without uploading/transcoding.
                if (video.duration === Infinity) {
                    await waitFor(video, 'durationchange', state.controller.signal, () => { video.currentTime = 1e10; });
                    await seek(0);
                }
                if (!Number.isFinite(video.duration) || video.duration <= 0 || video.duration > 600) throw new Error('Choose a finite video clip under 10 minutes.');
                const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
                canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
                $('start').value = '0'; $('end').value = Math.min(45, video.duration - .05).toFixed(2);
                $('position').max = Math.max(0, video.duration - .05); $('position').value = 0;
                // Hash only bounded ends of the file plus its size: never persist its name or video bytes.
                const head = new Uint8Array(await file.slice(0, 65536).arrayBuffer()), tail = new Uint8Array(await file.slice(-65536).arrayBuffer());
                const size = new TextEncoder().encode(String(file.size)), bytes = new Uint8Array(head.length + tail.length + size.length);
                bytes.set(head); bytes.set(tail, head.length); bytes.set(size, head.length + tail.length);
                state.clipId = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
                if (state.closed) return;
                $('editor').hidden = false; draw(); status('Trim to the set, choose bench style, then mark the plate.');
            } catch (error) { handleError(error); } finally { if (!state.closed) setBusy(false); }
        };
        for (const id of ['style', 'diameter', 'reps', 'end']) $(id).onchange = () => { invalidate(); draw(); };
        $('start').onchange = () => { invalidate(); state.center = null; state.radius = null; state.mark = 0; draw(); status('Start changed. Mark the plate again on the new first frame.'); };
        $('position').oninput = async () => { if (state.busy) return; stopPlayback(); state.mark = 0; try { await seek(+$('position').value); draw(); } catch (error) { handleError(error); } };
        $('mark').onclick = async () => {
            stopPlayback(); freshController(); invalidate();
            try {
                const start = +$('start').value;
                if (!Number.isFinite(start) || start < 0 || start >= video.duration) throw new Error('Choose a valid start time.');
                await seek(start); state.center = null; state.radius = null; state.mark = 1;
                state.cursor = { x: canvas.width / 2, y: canvas.height / 2 };
                $('mark-help').textContent = 'Place the marker at the centre of the visible plate. Then mark its outer rim.'; draw(); canvas.focus();
            } catch (error) { handleError(error); }
        };
        function place(point) {
            if (!state.mark || state.busy) return;
            if (state.mark === 1) { state.center = point; state.mark = 2; $('mark-help').textContent = 'Now select a point on the outer rim of the same plate.'; }
            else {
                const radius = Math.hypot(point.x - state.center.x, point.y - state.center.y);
                if (radius < 12 || radius > Math.min(canvas.width, canvas.height) / 2) { status('Mark a clearly visible plate at least 24 pixels across; select its actual outer rim.'); return; }
                state.radius = radius; state.mark = 0; $('mark-help').textContent = 'Plate marked. The circle should follow its outer edge.'; status('Ready to analyze.');
            }
            draw();
        }
        canvas.onclick = event => {
            const rect = canvas.getBoundingClientRect();
            place({ x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height });
        };
        canvas.onkeydown = event => {
            if (!state.mark) return;
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); place({ ...state.cursor }); return; }
            const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
            if (!delta) return;
            event.preventDefault(); const step = event.shiftKey ? 10 : 2;
            state.cursor.x = Math.max(0, Math.min(canvas.width - 1, state.cursor.x + step * delta[0]));
            state.cursor.y = Math.max(0, Math.min(canvas.height - 1, state.cursor.y + step * delta[1])); draw();
        };
        $('review').onclick = async () => {
            if (!video.paused) { stopPlayback(); return; }
            freshController(); state.mark = 0;
            try {
                await seek(+$('start').value); await video.play(); $('review').textContent = 'Pause clip';
                const frame = () => { if (state.closed) return; draw(); if (video.currentTime >= +$('end').value || video.ended) stopPlayback(); else state.raf = requestAnimationFrame(frame); };
                state.raf = requestAnimationFrame(frame);
            } catch (error) { handleError(error); }
        };
        $('analyze').onclick = async () => {
            stopPlayback(); freshController(); invalidate();
            try {
                const start = +$('start').value, end = +$('end').value, diameter = +$('diameter').value, expected = +$('reps').value;
                const row = selected(), load = Number(row.load?.value), style = $('style').value;
                if (!state.core) throw new Error('Analysis tools are still loading. Try again shortly.');
                if (!style) throw new Error('Choose paused or touch-and-go bench.');
                if (!state.center || !state.radius) throw new Error('Mark the plate centre and rim first.');
                if (!Number.isFinite(start + end) || start < 0 || end > video.duration || end - start < 1 || end - start > 45) throw new Error('Trim a complete set between 1 and 45 seconds long.');
                if (!Number.isFinite(diameter) || diameter < 10 || diameter > 60) throw new Error('Enter the actual plate diameter, between 10 and 60 cm.');
                if (!Number.isInteger(expected) || expected < 1 || expected > 20 || expected !== Number(row.reps?.value)) throw new Error('The clip must match this set’s logged rep count (1–20). Enter actual reps in the workout first.');
                if (!load || load <= 0 || load >= 1000) throw new Error('Enter this set’s load in the workout first.');
                state.row = row; state.load = load; state.expected = expected; state.style = style;
                setBusy(true); status('Tracking the plate on this device…');
                await seek(start); ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                const frame = () => state.core.grayscale(ctx.getImageData(0, 0, canvas.width, canvas.height));
                const template = state.core.makeTemplate(frame(), canvas.width, canvas.height, state.center.x, state.center.y, state.radius);
                const metersPerPixel = diameter / 100 / (2 * state.radius);
                let previous = { ...state.center, score: 1 }, points = [{ ...previous, t: start }];
                const frames = Math.floor((end - start) * 20), search = Math.ceil(Math.max(9, Math.min(40, .09 / metersPerPixel)));
                for (let i = 1; i <= frames; i++) {
                    const t = start + i / 20;
                    await seek(t); ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                    const point = state.core.trackPlate(frame(), canvas.width, canvas.height, template, previous, search);
                    if (point.score < .72 || Math.hypot(point.x - previous.x, point.y - previous.y) * metersPerPixel > .1) throw new Error(`Tracking became unreliable at ${t.toFixed(2)} s. Try a clearer, steadier clip or mark the plate again. No analysis was saved.`);
                    points.push({ ...point, t }); previous = point;
                    if (i % 5 === 0) { dialog.querySelector('progress').value = i / frames; await new Promise(resolve => setTimeout(resolve, 0)); }
                }
                const result = state.core.summarizeTrack(points, metersPerPixel);
                state.points = points;
                if (result.reps.length !== expected) throw new Error(`Found ${result.reps.length} complete presses; this set has ${expected} reps. Review the trim and tracking, then analyze again. No result was saved.`);
                const distances = result.reps.map(r => r.distance);
                if (Math.max(...distances) / Math.min(...distances) > 1.35 || result.reps.some(r => r.velocity < .03 || r.velocity > 2)) throw new Error('Rep motion was inconsistent. Check for partial reps, camera movement, or a tracking error. No result was saved.');
                state.result = result;
                state.sample = { version: 1, id: state.clipId, day: localDateKey(new Date()), exercise: normalizeExName(row.load.dataset.exname), style, load, reps: expected, lastVelocity: result.lastVelocity };
                const estimate = state.core.estimateRpe(state.sample, readProfile()); state.estimate = estimate;
                $('metrics').innerHTML = `<div><strong>${result.reps.length}</strong><span>Presses</span></div><div><strong>≈ ${result.lastVelocity.toFixed(2)} <small>m/s</small></strong><span>Last press, vertical</span></div><div><strong>${Math.round(result.velocityLoss)}%</strong><span>Slower than fastest</span></div>`;
                $('rep-rows').innerHTML = result.reps.map((r, i) => `<tr><td>${i + 1}</td><td>${r.duration.toFixed(2)} s</td><td>≈ ${Math.round(r.distance * 100)} cm</td><td>≈ ${r.velocity.toFixed(2)} m/s</td></tr>`).join('');
                const max = Math.max(...result.reps.map(r => r.velocity));
                $('chart').innerHTML = `<svg viewBox="0 0 320 100" role="img" aria-label="Mean press speed by repetition">${result.reps.map((r, i) => { const width = 280 / expected, height = r.velocity / max * 65; return `<rect x="${20 + i * width}" y="${75 - height}" width="${Math.max(2, width - 6)}" height="${height}" rx="3"/><text x="${20 + i * width + (width - 6) / 2}" y="94" text-anchor="middle">${i + 1}</text>`; }).join('')}</svg>`;
                $('estimate').textContent = estimate.available ? `RPE ${estimate.low}–${estimate.high}. Based on ${estimate.count} comparable self-rated sets.` : `${estimate.reason} (${estimate.count} comparable sets saved.)`;
                $('apply').disabled = row.rpe.disabled; $('apply').checked = false; $('rating').value = '';
                $('results').hidden = false; $('review').textContent = 'Play tracking';
                await seek(start); draw(); status('Analysis ready for review. Check the full tracking overlay before saving.');
                $('results').scrollIntoView({ block: 'start', behavior: 'instant' });
            } catch (error) { state.result = null; $('results').hidden = true; handleError(error); draw(); }
            finally { if (!state.closed) setBusy(false); }
        };
        $('verified').onchange = () => { $('save').disabled = !state.result || !$('verified').checked; };
        $('save').onclick = () => {
            try {
                if (!state.result || !$('verified').checked) return;
                const row = selected();
                if (getWorkoutKey() !== state.key || completedDays[state.key] || row.load !== state.row.load || !row.load?.isConnected || Number(row.load.value) !== state.load || Number(row.reps.value) !== state.expected) throw new Error('The workout set changed. Close this window and analyze the correct set again.');
                const rawRating = $('rating').value, rating = rawRating === '' ? null : Number(rawRating);
                if (rating !== null && (!Number.isFinite(rating) || rating < 6 || rating > 10 || rating * 2 % 1)) throw new Error('Enter your own RPE from 6 to 10 in half-point steps, or leave it blank.');
                if ($('apply').checked && (rating === null || row.rpe.disabled)) throw new Error('Enter your own rating first. Logged sets must be unchecked before their RPE can be changed.');
                const result = state.result;
                const summary = { version: 1, style: state.style, load: state.load, reps: result.reps.length, lastVelocity: result.lastVelocity, fastestVelocity: result.fastestVelocity, velocityLoss: result.velocityLoss, presses: result.reps, reviewed: true, ownRpe: rating, estimatedRange: state.estimate.available ? [state.estimate.low, state.estimate.high] : null };
                // Commit the whole session in one write. The app's normal batched
                // flush logs quota errors instead of throwing, so it is unsuitable
                // as an acknowledgement of this explicit Save action.
                flushSessionState();
                const session = safeParse(state.key, {});
                session[row.rowId + '_video'] = summary;
                if ($('apply').checked) session[row.rpe.id] = String(rating);
                const previousProfile = localStorage.getItem(calibrationKey);
                if (rating !== null) {
                    const profile = readProfile().filter(s => s.id !== state.sample.id);
                    profile.push({ ...state.sample, rpe: rating }); localStorage.setItem(calibrationKey, JSON.stringify(profile.slice(-100)));
                }
                try { localStorage.setItem(state.key, JSON.stringify(session)); }
                catch (error) {
                    if (rating !== null) {
                        try { if (previousProfile === null) localStorage.removeItem(calibrationKey); else localStorage.setItem(calibrationKey, previousProfile); } catch { /* Report the storage failure below. */ }
                    }
                    throw new Error('Could not save to device storage. Free some space and try again; keep this window open.');
                }
                if ($('apply').checked) {
                    row.rpe.value = String(rating); row.rpe.dispatchEvent(new Event('input', { bubbles: true })); row.rpe.dispatchEvent(new Event('change', { bubbles: true }));
                }
                flushSessionState();
                dialog.close(); renderWorkout();
            } catch (error) { handleError(error); }
        };
        dialog.showModal();
        try { state.core = await import('./video-analysis-core.js'); } catch { status('Video tools could not load. Reconnect once to download the app’s offline files, then reopen this window.'); }
    };
})();
