// Program editor: the lifter's own multi-week programs, built and edited in the app.
//
// Programs made here live in localStorage `userPrograms` under `User_<timestamp>` ids
// and are merged into `db` at boot (app.js, the initApp wrapper), so they behave like
// any database program: week spine, day tabs, Program Management, Home hero, progress.
// (Custom_* workouts are a different thing: single-session templates.)
//
// The editor works on a deep copy and writes nothing until Save. Fields it does not
// show (restSec, durationMin, amrap, percentageReference, tmProgression, mode ...) ride
// along untouched, so a copy of a built-in program keeps its machinery.
//
// It is a fixed full-screen panel, not a <dialog>: showConfirm()'s modal has to be
// able to sit above it, and a top-layer dialog would cover it.
(function () {
    'use strict';

    const STORE_KEY = 'userPrograms';
    const BLOCK_TYPES = [['top', 'Top set'], ['backoff', 'Back-off'], ['acc', 'Accessory']];
    const ICONS = {
        up: '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 15 12 9 18 15"/></svg>',
        down: '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
        remove: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
        edit: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
        trash: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
    };

    let ed = null;          // { id, isNew, prog, w, d, layout, snapshot, error }
    let root = null;
    let returnFocus = null;

    const clone = v => JSON.parse(JSON.stringify(v));
    const keysOf = obj => Object.keys(obj || {}).sort((a, b) => a - b);
    const isUserProgram = id => typeof id === 'string' && id.startsWith('User_');
    // Which weeks exist and which days each holds. Saved progress is keyed by these
    // numbers, so a changed layout is what makes old progress meaningless.
    const layoutOf = prog => keysOf(prog.weeks).map(w => w + ':' + keysOf(prog.weeks[w]).join(',')).join('|');
    const day = () => ed.prog.weeks[ed.w][ed.d];
    const nextKey = obj => String(Math.max(0, ...Object.keys(obj).map(Number)) + 1);
    // Rebuild an object with keys 1..n in the existing order.
    const renumber = obj => Object.fromEntries(keysOf(obj).map((k, i) => [String(i + 1), obj[k]]));

    function sessionKeys(id) {
        const out = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(id + '_w') && /_w\d+_d\d+$/.test(k)) out.push(k);
        }
        return out;
    }
    function hasProgress(id) {
        return Object.keys(completedDays).some(k => k.startsWith(id + '_w')) || sessionKeys(id).length > 0;
    }
    // Same scope as "Reset Entire Program": day progress and program-level swaps/modes.
    function resetProgress(id) {
        flushSessionState();
        Object.keys(completedDays).forEach(k => { if (k.startsWith(id + '_w')) delete completedDays[k]; });
        localStorage.setItem('completedDays', JSON.stringify(completedDays));
        sessionKeys(id).forEach(k => localStorage.removeItem(k));
        localStorage.removeItem(`programSwaps_${id}`);
        localStorage.removeItem(`programModes_${id}`);
    }

    // ── Library: the lifter's programs, listed at the top of the Custom folder ──
    window.userProgramsLibraryHtml = function () {
        const progs = safeParse(STORE_KEY, {});
        const cards = Object.keys(progs).map(id => `
            <div class="program-card pe-card" role="button" tabindex="0" data-program-id="${escapeHtml(id)}" onclick="startProgram(this.dataset.programId)">
                <div class="pe-card-row">
                    <h3 class="program-title">${escapeHtml(progs[id].name || 'Untitled program')}</h3>
                    <span class="pe-card-tools">
                        <button type="button" class="program-delete pe-card-edit" aria-label="Edit program" onclick="event.stopPropagation(); openProgramEditor(this.closest('.program-card').dataset.programId)">${ICONS.edit}</button>
                        <button type="button" class="program-delete" aria-label="Delete program" onclick="event.stopPropagation(); deleteUserProgram(this.closest('.program-card').dataset.programId)">${ICONS.trash}</button>
                    </span>
                </div>
                <p class="program-desc">${progs[id].copyOf ? 'Your copy of a built-in program' : 'Your program'}</p>
            </div>`).join('');
        return `<p class="pe-library-head">My programs</p>
            <button type="button" class="pe-new" onclick="openProgramEditor()">New program</button>
            ${cards}
            <p class="pe-library-head">Single workouts</p>`;
    };

    window.deleteUserProgram = async function (id) {
        const progs = safeParse(STORE_KEY, {});
        if (!progs[id]) return;
        const ok = await showConfirm('Delete program?', `"${progs[id].name || 'Untitled program'}" and its progress will be removed. Your logged history is kept.`, 'Delete', 'Cancel', true);
        if (!ok) return;
        if (activeWorkout && activeWorkout.program === id) discardActiveWorkout();
        resetProgress(id);
        localStorage.removeItem(`programTMs_${id}`);
        delete progs[id];
        localStorage.setItem(STORE_KEY, JSON.stringify(progs));
        delete db[id];
        if (localStorage.getItem('activeProgram') === id) localStorage.removeItem('activeProgram');
        if (currentProgram === id) {
            currentProgram = null;
            const active = document.querySelector('.app-screen.active');
            if (active && active.id === 'workout-screen') switchTab('library-screen');
        }
        updateLibraryUI();
        updateDashboard();
        updateBanners();
    };

    // ── Open ─────────────────────────────────────────────────────────────────
    // No id: a new program. A User_ id: edit it. A built-in id: offer an editable copy.
    window.openProgramEditor = async function (id) {
        let prog, targetId = id, isNew = false;
        if (!id) {
            targetId = 'User_' + Date.now();
            prog = { name: '', weeks: { 1: { 1: [] } } };
            isNew = true;
        } else if (isUserProgram(id) && db[id]) {
            if (activeWorkout && activeWorkout.program === id) {
                await showConfirm('Finish your session first', 'This program has a workout in progress. Finish or cancel it, then edit the program.', 'OK', 'Close');
                return;
            }
            prog = clone(db[id]);
        } else if (db[id] && db[id].weeks && !id.startsWith('Custom_')) {
            const ok = await showConfirm('Edit a copy?',
                `${db[id].name || 'This program'} is built in and cannot be changed. Make your own copy to edit? The copy is kept on this phone and in exported backup files. It is not uploaded to the Gist.`,
                'Make a copy', 'Cancel');
            if (!ok) return;
            targetId = 'User_' + Date.now();
            prog = clone(db[id]);
            prog.name = `${db[id].name || 'Program'} (my copy)`;
            prog.copyOf = id;
            isNew = true;
        } else {
            return;
        }
        if (!prog.weeks || !keysOf(prog.weeks).length) prog.weeks = { 1: { 1: [] } };
        keysOf(prog.weeks).forEach(w => { if (!keysOf(prog.weeks[w]).length) prog.weeks[w] = { 1: [] }; });

        const firstWeek = keysOf(prog.weeks)[0];
        ed = { id: targetId, isNew, prog, w: firstWeek, d: keysOf(prog.weeks[firstWeek])[0], layout: layoutOf(prog), snapshot: JSON.stringify(prog), error: '' };
        // Open on the day being looked at when the editor is opened from a workout.
        if (!isNew && currentProgram === id && prog.weeks[selectedWeek] && prog.weeks[selectedWeek][selectedDay]) {
            ed.w = selectedWeek; ed.d = selectedDay;
        }

        if (!root) {
            root = document.createElement('div');
            root.id = 'program-editor';
            root.setAttribute('data-no-tab-swipe', '');
            document.body.appendChild(root);
            root.addEventListener('click', onClick);
            root.addEventListener('input', onInput);
            root.addEventListener('change', onInput);
            root.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); cancel(); } });
        }
        returnFocus = document.activeElement;
        root.hidden = false;
        render();
        const name = root.querySelector('[data-field="name"]');
        if (name && isNew && !prog.copyOf) name.focus();
    };

    function close() {
        if (!root) return;
        root.hidden = true;
        root.innerHTML = '';
        ed = null;
        if (returnFocus && returnFocus.focus && document.contains(returnFocus)) returnFocus.focus();
        returnFocus = null;
    }

    async function cancel() {
        if (!ed) return;
        if (JSON.stringify(ed.prog) !== ed.snapshot) {
            const ok = await showConfirm('Discard changes?', 'Your edits to this program have not been saved.', 'Discard', 'Keep editing', true);
            if (!ok) return;
        }
        close();
    }

    // ── Render ───────────────────────────────────────────────────────────────
    function blockHtml(ex, b, i, j) {
        const known = BLOCK_TYPES.some(([v]) => v === b.type);
        const types = (known ? BLOCK_TYPES : [...BLOCK_TYPES, [b.type || '', b.type || 'Other']])
            .map(([v, label]) => `<option value="${escapeHtml(v)}"${v === (b.type || '') ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('');
        const at = `data-ex="${i}" data-b="${j}"`;
        const pct = b.pct ? Math.round(b.pct * 1000) / 10 : '';
        return `<div class="pe-block">
            <input type="number" inputmode="numeric" min="1" data-field="sets" ${at} value="${escapeHtml(b.sets ?? '')}" aria-label="Sets">
            <input type="number" inputmode="numeric" min="1" data-field="reps" ${at} value="${escapeHtml(b.reps ?? '')}" aria-label="Reps"${b.durationMin ? ' disabled' : ''}>
            <input type="number" inputmode="decimal" step="0.5" data-field="targetRpe" ${at} value="${escapeHtml(b.targetRpe ?? '')}" aria-label="Target RPE">
            <input type="number" inputmode="decimal" data-field="pct" ${at} value="${pct}" aria-label="Percent of 1RM">
            <select data-field="type" ${at} aria-label="Kind of set">${types}</select>
            <button type="button" class="pe-icon danger" data-act="block-del" ${at} aria-label="Remove block"${ex.blocks.length < 2 ? ' disabled' : ''}>${ICONS.remove}</button>
        </div>`;
    }

    function exerciseHtml(ex, i, all) {
        const isMain = ex.type === 'main';
        return `<article class="pe-ex${isMain ? ' main' : ''}">
            <div class="pe-ex-head">
                <input type="text" class="pe-ex-name" data-field="ex-name" data-ex="${i}" value="${escapeHtml(ex.name || '')}" placeholder="Exercise name" list="exercise-name-list" aria-label="Exercise name" autocomplete="off">
                <button type="button" class="pe-icon" data-act="ex-up" data-ex="${i}" aria-label="Move exercise up"${i === 0 ? ' disabled' : ''}>${ICONS.up}</button>
                <button type="button" class="pe-icon" data-act="ex-down" data-ex="${i}" aria-label="Move exercise down"${i === all.length - 1 ? ' disabled' : ''}>${ICONS.down}</button>
                <button type="button" class="pe-icon danger" data-act="ex-del" data-ex="${i}" aria-label="Remove exercise">${ICONS.remove}</button>
            </div>
            <div class="pe-seg" role="group" aria-label="Lift type">
                <button type="button" data-act="ex-type" data-ex="${i}" data-value="main" aria-pressed="${isMain}">Main lift</button>
                <button type="button" data-act="ex-type" data-ex="${i}" data-value="accessory" aria-pressed="${!isMain}">Accessory</button>
            </div>
            <input type="text" class="pe-notes" data-field="ex-notes" data-ex="${i}" value="${escapeHtml(ex.notes || '')}" placeholder="Coach notes (optional)" aria-label="Coach notes">
            <div class="pe-blocks">
                <div class="pe-block pe-block-head" aria-hidden="true"><span>Sets</span><span>Reps</span><span>RPE</span><span>%</span><span>Kind</span><span></span></div>
                ${(ex.blocks || []).map((b, j) => blockHtml(ex, b, i, j)).join('')}
            </div>
            <button type="button" class="pe-link" data-act="add-block" data-ex="${i}">Add block</button>
        </article>`;
    }

    function render() {
        const body = root.querySelector('.pe-body');
        const scroll = body ? body.scrollTop : 0;
        const p = ed.prog, weeks = keysOf(p.weeks), days = keysOf(p.weeks[ed.w]), list = day();
        const chip = (act, v, on) => `<button type="button" class="pe-chip" data-act="${act}" data-value="${escapeHtml(v)}" aria-pressed="${on}">${escapeHtml(v)}</button>`;
        root.innerHTML = `
        <div class="pe" role="dialog" aria-modal="true" aria-label="Program editor">
            <header class="pe-head">
                <button type="button" class="pe-quiet" data-act="cancel">Cancel</button>
                <h2>${ed.isNew ? 'New program' : 'Edit program'}</h2>
                <button type="button" class="pe-save" data-act="save">Save</button>
            </header>
            <div class="pe-body">
                <p class="pe-error" role="alert"${ed.error ? '' : ' hidden'}>${escapeHtml(ed.error)}</p>
                <label class="pe-field"><span>Name</span>
                    <input type="text" data-field="name" value="${escapeHtml(p.name || '')}" placeholder="Winter strength block" maxlength="60" autocomplete="off">
                </label>
                <section class="pe-nav" aria-label="Weeks and days">
                    <div class="pe-nav-row"><span class="pe-nav-label">Week</span>
                        <div class="pe-chips">${weeks.map(w => chip('week', w, w === ed.w)).join('')}<button type="button" class="pe-chip pe-chip-add" data-act="add-week" aria-label="Add an empty week">+</button></div>
                    </div>
                    <div class="pe-tools">
                        <button type="button" class="pe-link" data-act="dup-week">Duplicate week ${escapeHtml(ed.w)}</button>
                        <button type="button" class="pe-link" data-act="del-week"${weeks.length < 2 ? ' disabled' : ''}>Delete week</button>
                    </div>
                    <div class="pe-nav-row"><span class="pe-nav-label">Day</span>
                        <div class="pe-chips">${days.map(d => chip('day', d, d === ed.d)).join('')}<button type="button" class="pe-chip pe-chip-add" data-act="add-day" aria-label="Add a day to this week">+</button></div>
                    </div>
                    <div class="pe-tools">
                        <button type="button" class="pe-link" data-act="copy-day"${weeks.length < 2 ? ' disabled' : ''}>Copy day to every week</button>
                        <button type="button" class="pe-link" data-act="del-day"${days.length < 2 ? ' disabled' : ''}>Delete day</button>
                    </div>
                </section>
                <h3 class="pe-day-title">Week ${escapeHtml(ed.w)}, day ${escapeHtml(ed.d)}</h3>
                ${list.length ? list.map(exerciseHtml).join('') : '<p class="pe-empty">Nothing on this day yet.</p>'}
                <button type="button" class="pe-add" data-act="add-ex">Add exercise</button>
            </div>
        </div>`;
        root.querySelector('.pe-body').scrollTop = scroll;
    }

    // ── Typing: update the copy in place, no re-render (the field keeps focus) ──
    function onInput(e) {
        const t = e.target, field = t.dataset && t.dataset.field;
        if (!ed || !field) return;
        if (ed.error) { // the complaint is stale as soon as something is changed
            ed.error = '';
            const err = root.querySelector('.pe-error');
            if (err) err.hidden = true;
        }
        if (field === 'name') { ed.prog.name = t.value; return; }
        const ex = day()[Number(t.dataset.ex)];
        if (!ex) return;
        if (field === 'ex-name') { ex.name = t.value; return; }
        if (field === 'ex-notes') { if (t.value.trim()) ex.notes = t.value; else delete ex.notes; return; }
        const b = ex.blocks[Number(t.dataset.b)];
        if (!b) return;
        if (field === 'type') { b.type = t.value; return; }
        const n = parseFloat(t.value);
        if (field === 'sets' || field === 'reps') b[field] = isFinite(n) ? Math.round(n) : '';
        else if (field === 'targetRpe') b.targetRpe = isFinite(n) ? n : null;
        else if (field === 'pct') b.pct = isFinite(n) && n > 0 ? Math.round(n * 10) / 1000 : null; // shown as %, stored as a fraction
    }

    // ── Buttons ──────────────────────────────────────────────────────────────
    async function onClick(e) {
        const btn = e.target.closest('[data-act]');
        if (!ed || !btn || btn.disabled) return;
        const act = btn.dataset.act, p = ed.prog, i = Number(btn.dataset.ex), list = day();
        let focusNewExercise = false;

        if (act === 'cancel') return cancel();
        if (act === 'save') return save();

        if (act === 'week') { ed.w = btn.dataset.value; ed.d = keysOf(p.weeks[ed.w])[0]; }
        else if (act === 'day') ed.d = btn.dataset.value;
        else if (act === 'add-week') {
            // An empty week with the same days as the one on screen.
            const k = nextKey(p.weeks);
            p.weeks[k] = Object.fromEntries(keysOf(p.weeks[ed.w]).map(d => [d, []]));
            ed.w = k; ed.d = keysOf(p.weeks[k])[0];
        } else if (act === 'dup-week') {
            const k = nextKey(p.weeks);
            p.weeks[k] = clone(p.weeks[ed.w]);
            ed.w = k;
        } else if (act === 'del-week') {
            if (!await showConfirm('Delete week?', `Week ${ed.w} and everything in it will be removed, and later weeks move up.`, 'Delete week', 'Cancel', true)) return;
            const at = keysOf(p.weeks).indexOf(ed.w);
            delete p.weeks[ed.w];
            p.weeks = renumber(p.weeks);
            const weeks = keysOf(p.weeks);
            ed.w = weeks[Math.min(at, weeks.length - 1)];
            ed.d = keysOf(p.weeks[ed.w])[0];
        } else if (act === 'add-day') {
            const k = nextKey(p.weeks[ed.w]);
            p.weeks[ed.w][k] = [];
            ed.d = k;
        } else if (act === 'del-day') {
            if (!await showConfirm('Delete day?', `Day ${ed.d} of week ${ed.w} will be removed, and later days move up.`, 'Delete day', 'Cancel', true)) return;
            const at = keysOf(p.weeks[ed.w]).indexOf(ed.d);
            delete p.weeks[ed.w][ed.d];
            p.weeks[ed.w] = renumber(p.weeks[ed.w]);
            const days = keysOf(p.weeks[ed.w]);
            ed.d = days[Math.min(at, days.length - 1)];
        } else if (act === 'copy-day') {
            if (!await showConfirm('Copy to every week?', `Day ${ed.d} of every other week will be replaced with this one.`, 'Copy', 'Cancel')) return;
            keysOf(p.weeks).forEach(w => { if (w !== ed.w) p.weeks[w][ed.d] = clone(list); });
        } else if (act === 'add-ex') {
            list.push({ name: '', type: 'accessory', blocks: [{ sets: 3, reps: 10, type: 'acc', targetRpe: null, pct: null }] });
            focusNewExercise = true;
        } else if (act === 'ex-del') list.splice(i, 1);
        else if (act === 'ex-up' && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
        else if (act === 'ex-down' && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
        else if (act === 'ex-type') {
            list[i].type = btn.dataset.value;
        } else if (act === 'add-block') {
            const blocks = list[i].blocks = list[i].blocks || [];
            const last = blocks[blocks.length - 1];
            blocks.push(last ? clone(last) : { sets: 3, reps: 10, type: 'acc', targetRpe: null, pct: null });
        } else if (act === 'block-del') list[i].blocks.splice(Number(btn.dataset.b), 1);
        else return;

        if (!ed) return; // closed while a confirm was open
        render();
        if (focusNewExercise) {
            const names = root.querySelectorAll('.pe-ex-name');
            if (names.length) names[names.length - 1].focus();
        }
    }

    // ── Save ─────────────────────────────────────────────────────────────────
    function validate(p) {
        if (!String(p.name || '').trim()) return { msg: 'Give the program a name.' };
        let any = false;
        for (const w of keysOf(p.weeks)) for (const d of keysOf(p.weeks[w])) {
            const at = { w, d }, where = `Week ${w}, day ${d}`;
            for (const ex of p.weeks[w][d]) {
                any = true;
                const name = String(ex.name || '').trim();
                if (!name) return { ...at, msg: `${where}: an exercise has no name.` };
                if (!Array.isArray(ex.blocks) || !ex.blocks.length) return { ...at, msg: `${where}, ${name}: add at least one block.` };
                for (const b of ex.blocks) {
                    if (!(Number(b.sets) >= 1)) return { ...at, msg: `${where}, ${name}: sets must be 1 or more.` };
                    if (!b.durationMin && !(Number(b.reps) >= 1)) return { ...at, msg: `${where}, ${name}: reps must be 1 or more.` };
                    if (b.targetRpe != null && b.targetRpe !== '' && !(b.targetRpe >= 1 && b.targetRpe <= 10)) return { ...at, msg: `${where}, ${name}: RPE goes from 1 to 10.` };
                    if (b.pct != null && !(b.pct > 0 && b.pct <= 1.5)) return { ...at, msg: `${where}, ${name}: the percentage goes from 1 to 150.` };
                }
            }
        }
        return any ? null : { msg: 'Add at least one exercise.' };
    }

    async function save() {
        const bad = validate(ed.prog);
        if (bad) {
            ed.error = bad.msg;
            if (bad.w) { ed.w = bad.w; ed.d = bad.d; }
            render();
            root.querySelector('.pe-body').scrollTop = 0;
            return;
        }
        ed.error = '';
        const p = ed.prog, id = ed.id;
        p.name = p.name.trim();
        keysOf(p.weeks).forEach(w => keysOf(p.weeks[w]).forEach(d => p.weeks[w][d].forEach(ex => {
            ex.name = ex.name.trim();
            ex.blocks.forEach(b => { b.sets = Number(b.sets); if (!b.durationMin) b.reps = Number(b.reps); if (b.targetRpe === '') b.targetRpe = null; });
        })));

        // Progress is keyed by week and day number: a changed layout orphans it.
        if (!ed.isNew && layoutOf(p) !== ed.layout && hasProgress(id)) {
            const ok = await showConfirm('Start the program again?', 'You changed its weeks or days, and it has logged progress. Saving starts it again from week 1. Your history is kept.', 'Save and restart', 'Keep editing', true);
            if (!ok || !ed) return;
            resetProgress(id);
        }

        const store = safeParse(STORE_KEY, {});
        store[id] = p;
        localStorage.setItem(STORE_KEY, JSON.stringify(store));
        db[id] = clone(p);
        close();

        if (currentProgram === id) {
            if (!db[id].weeks[selectedWeek]) { selectedWeek = keysOf(db[id].weeks)[0]; selectedDay = null; }
            renderWeekPills();
            renderDayPills();
            renderWorkout();
        }
        updateLibraryUI();
        updateDashboard();
        const folder = document.getElementById('custom-folder');
        if (folder) folder.open = true;
    }
})();
