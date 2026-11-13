/* Technique guide for the three lifts: a side-view schematic drawn to the lifter's
   own proportions, a setup sequence and glanceable cues. One file, no build step.
   Storage: techniqueBody (measurements + variants) and techniqueCues (pinned cues),
   both listed in BACKUP_PREFERENCES in app.js. */
(() => {
    const LIFTS = ['squat', 'bench', 'deadlift'];
    const BODY_KEY = 'techniqueBody', CUES_KEY = 'techniqueCues', MAX_PINS = 2;
    const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v)), r0 = v => Math.round(v);
    const ease = x => x < .5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
    const lerp = (a, b, t) => a + (b - a) * t;
    const RINGS = 81; // cm between the bar's ring marks; also the IPF max bench grip

    window.getTechniqueLift = function(name) {
        const canonical = typeof normalizeExName === 'function' ? normalizeExName(name) : name;
        const n = String(canonical || '').toLowerCase().replace(/[-_]/g, ' ');
        // These movements need their own instruction, not the competition-lift guide.
        if (/\b(romanian|rdl|stiff|single|split|bulgarian|goblet|hack|machine|smith|dumbbell|db|row|fly|step|dips?|hip thrust)\b/.test(n)) return null;
        if (/\bbench\b|\((bench)\)$/.test(n) || /\b(larsen|spoto|board) press\b/.test(n)) return 'bench';
        if (/\bsquat\b/.test(n)) return 'squat';
        if (/\bdeadlift\b/.test(n)) return 'deadlift';
        return null;
    };

    /* ---------- body ---------- */
    // h height, f thigh, t torso (hip to shoulder), a arm (shoulder to fist), b shoulder width. cm.
    // f/t/a/b are null until the lifter sets them, and follow height until then.
    const FIELDS = {
        h: { label: 'Height', min: 150, max: 210, hint: 'Barefoot.' },
        f: { label: 'Thigh', min: 32, max: 58, avg: h => .245 * h, hint: 'Bony bump at the side of the hip to the outside of the knee joint.' },
        t: { label: 'Torso', min: 40, max: 66, avg: h => .288 * h, hint: 'Same hip bump straight up to the bony tip of the shoulder.' },
        a: { label: 'Arm', min: 50, max: 80, avg: h => .385 * h - 6, hint: 'Shoulder tip to the middle of your closed fist, arm straight.' },
        b: { label: 'Shoulders', min: 32, max: 50, avg: h => .23 * h, hint: 'Bony tip to bony tip across the back. Not the widest part of the delts.' }
    };
    // w holds grip and stance widths the lifter has tuned by hand, keyed like 'bg' (bench grip).
    // A missing key follows the start computed from the body.
    const store = { v: 2, h: 178, f: null, t: null, a: null, b: null, low: true, sumo: false, arch: 1, w: {} };

    function loadBody() {
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem(BODY_KEY) || 'null'); } catch (e) { /* keep defaults */ }
        if (!saved || typeof saved !== 'object') return;
        const num = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };
        if (saved.v === 2) {
            Object.keys(FIELDS).forEach(k => { const n = num(saved[k]); if (n !== null) store[k] = clamp(n, FIELDS[k].min, FIELDS[k].max); });
            store.low = saved.low !== false; store.sumo = saved.sumo === true;
            store.arch = [0, 1, 2].includes(saved.arch) ? saved.arch : 1;
            if (saved.w && typeof saved.w === 'object') Object.keys(saved.w).forEach(k => { const n = num(saved.w[k]); if (/^[a-z]{2,3}$/.test(k) && n !== null) store.w[k] = n; });
        } else if (saved.inH !== undefined) {
            // First guide stored the raw form (wingspan, sitting height). Convert once.
            const H = num(saved.inH), W = num(saved.inW), B = num(saved.inB), F = num(saved.inF), S = num(saved.inS);
            if (H) store.h = clamp(H, FIELDS.h.min, FIELDS.h.max);
            if (F) store.f = clamp(F, FIELDS.f.min, FIELDS.f.max);
            if (S) store.t = clamp(S - .232 * store.h, FIELDS.t.min, FIELDS.t.max);
            if (B) store.b = clamp(B, FIELDS.b.min, FIELDS.b.max);
            if (W) store.a = clamp((W - (B || .23 * store.h)) / 2 - 6, FIELDS.a.min, FIELDS.a.max);
            if (saved.inArch !== undefined) { const ar = num(saved.inArch); store.arch = ar >= 10 ? 2 : ar >= 5 ? 1 : 0; }
        }
    }
    function saveBody() { try { localStorage.setItem(BODY_KEY, JSON.stringify(store)); } catch (e) { /* storage full or blocked */ } }
    function body() {
        const H = store.h, val = k => store[k] === null ? clamp(FIELDS[k].avg(H), FIELDS[k].min, FIELDS[k].max) : store[k];
        const F = val('f'), T = val('t'), A = val('a'), B = val('b');
        const W = 2 * A + B + 12; // wingspan implied by arm and shoulders
        return { H, F, T, A, B, Ls: .246 * H, W, Lu: .186 * W, ratio: F / T, ape: W / H };
    }

    /* ---------- pinned cues ---------- */
    let pins = { squat: [], bench: [], deadlift: [] };
    function loadPins() {
        try {
            const saved = JSON.parse(localStorage.getItem(CUES_KEY) || 'null');
            if (saved && typeof saved === 'object') LIFTS.forEach(l => {
                if (Array.isArray(saved[l])) pins[l] = saved[l].filter(id => typeof id === 'string' && cueById(l, id)).slice(-MAX_PINS);
            });
        } catch (e) { /* keep empty */ }
    }
    function savePins() { try { localStorage.setItem(CUES_KEY, JSON.stringify(pins)); } catch (e) { /* ignore */ } }

    /* ---------- kinematics (cm, x toward the toes, y up) ---------- */
    function ik2(a, b, l1, l2, flip) {
        const dx = b[0] - a[0], dy = b[1] - a[1], D0 = Math.hypot(dx, dy) || 1e-6;
        const D = clamp(D0, Math.abs(l1 - l2) + .01, l1 + l2 - .01);
        const aa = (l1 * l1 - l2 * l2 + D * D) / (2 * D), h = Math.sqrt(Math.max(0, l1 * l1 - aa * aa)), s = flip ? -1 : 1;
        return [a[0] + aa * dx / D0 + s * h * dy / D0, a[1] + aa * dy / D0 - s * h * dx / D0];
    }
    // Squat: solve the torso angle that keeps the bar over midfoot.
    function sqCalc(Lt, Lb, Ls, shinDeg, depDeg, low, ph) {
        const a = rad(shinDeg * ph), phi = rad(-90 + (90 + depDeg) * ph), A = [0, 8], MF = 7;
        const K = [Ls * Math.sin(a), A[1] + Ls * Math.cos(a)];
        const H = [K[0] - Lt * Math.cos(phi), K[1] - Lt * Math.sin(phi)];
        const d = low ? Lb - 5 : Lb + 2, o = low ? 7 : 6;
        const bar = b => [H[0] + d * Math.sin(b) - o * Math.cos(b), H[1] + d * Math.cos(b) + o * Math.sin(b)];
        let lo = rad(-10), hi = rad(88);
        for (let i = 0; i < 46; i++) { const m = (lo + hi) / 2; if (bar(m)[0] < MF) lo = m; else hi = m; }
        const b = (lo + hi) / 2;
        return { A, K, H, B: bar(b), Sh: [H[0] + Lb * Math.sin(b), H[1] + Lb * Math.cos(b)], tor: b, MF };
    }
    // Deadlift: bar rises over midfoot, hip found from knee and shoulder.
    function dlCalc(arm, Lt0, Lb, Ls, sumo, ph) {
        const A = [0, 8], MF = 7, by0 = 22.5, c45 = Math.cos(rad(45)), Lt = sumo ? Lt0 * (c45 + (1 - c45) * ph) : Lt0;
        let a0;
        if (sumo) a0 = rad(4);
        else { let lo = 0, hi = rad(40); for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2, dd = (MF - A[0]) * Math.cos(m) - (by0 - A[1]) * Math.sin(m); if (dd > 5) lo = m; else hi = m; } a0 = (lo + hi) / 2; }
        const a = a0 * Math.max(0, 1 - ph / .5);
        const K = [Ls * Math.sin(a), A[1] + Ls * Math.cos(a)];
        const delta = 2 - 9 * ph, vy = Math.sqrt(arm * arm - delta * delta);
        const byLock = 8 + Ls + Lt0 + Lb - vy;
        let by = by0 + (byLock - by0) * ph, Sh = [MF + delta, by + vy];
        const reach = Lt + Lb, dx = Sh[0] - K[0];
        if (Math.hypot(dx, Sh[1] - K[1]) > reach) { Sh = [Sh[0], K[1] + Math.sqrt(Math.max(0, reach * reach - dx * dx))]; by = Sh[1] - vy; }
        const c1 = ik2(K, Sh, Lt, Lb, false), c2 = ik2(K, Sh, Lt, Lb, true), H = c1[0] < c2[0] ? c1 : c2;
        return { A, K, H, Sh, B: [MF, by], MF, tor: Math.atan2(Sh[0] - H[0], Sh[1] - H[1]), travel: byLock - by0 };
    }
    const ARCH = [2, 7, 12]; // cm of sternum lift for Flat / Arch / Big arch
    function benchGrip(b) { return clamp(r0(2 * (b.B / 2 - 2 + .55 * b.Lu - 4) + 4), 40, RINGS); }
    function bpCalc(b, lift, ph) {
        const PAD = 45, S = [0, PAD + 7.5], grip = pick('bg', benchGrip(b), 40, RINGS);
        const lat = Math.max(0, grip / 2 + 4 - (b.B / 2 - 2));
        const hLock = Math.sqrt(Math.max(1, b.A * b.A - lat * lat));
        const hip = [b.T - lift * .5, PAD + 7.5], ctrl = [hip[0] * .45, S[1] + lift / .44];
        const curve = t => [2 * t * (1 - t) * ctrl[0] + t * t * hip[0], (1 - t) * (1 - t) * S[1] + 2 * t * (1 - t) * ctrl[1] + t * t * hip[1]];
        const c = curve(.33), touch = [c[0], c[1] + 10], lock = [1, S[1] + hLock];
        const k = [lerp(lock[0], touch[0], .25), lerp(touch[1], lock[1], .25)]; // J path: back toward the face first
        const at = t => [(1 - t) * (1 - t) * lock[0] + 2 * t * (1 - t) * k[0] + t * t * touch[0], (1 - t) * (1 - t) * lock[1] + 2 * t * (1 - t) * k[1] + t * t * touch[1]];
        // Seen from the side the forearm is vertical for the whole rep: the elbow sits under the bar.
        // How far out the elbow is (e, toward the viewer) is the free variable; solve its height so
        // both the upper arm and the forearm keep their real length.
        const bar = at(ph), Lf = b.A - b.Lu, bx = bar[0] - S[0];
        const reach = Math.sqrt(Math.max(1, b.Lu * b.Lu - bx * bx));
        const miss = y => { const e = Math.sqrt(Math.max(0, reach * reach - (y - S[1]) * (y - S[1]))); return (bar[1] - y) * (bar[1] - y) + (lat - e) * (lat - e) - Lf * Lf; };
        const y0 = S[1] - reach, y1 = Math.min(bar[1], S[1] + reach);
        let lo = y0, hi = null, ey = y0, least = Math.abs(miss(y0));
        for (let i = 1; i <= 96 && hi === null; i++) {
            const y = y0 + (y1 - y0) * i / 96, m = miss(y);
            if (Math.abs(m) < least) { least = Math.abs(m); ey = y; }
            if (m <= 0) hi = y; else lo = y;
        }
        if (hi !== null) { for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (miss(m) > 0) lo = m; else hi = m; } ey = (lo + hi) / 2; }
        const elbow = [bar[0], ey];
        const ankle = [hip[0] + .55 * b.F - lift, 8], knee = ik2(hip, ankle, b.F, b.Ls, true);
        return { PAD, S, hip, ctrl, bar, at, elbow, ankle, knee, lock, touch, grip, rom: lock[1] - touch[1] };
    }
    const squatPose = (b, ph) => sqCalc(b.F * .9, b.T, b.Ls, store.low ? 27 : 34, 6, store.low, ph);
    const deadPose = (b, ph, sumo = store.sumo) => dlCalc(b.A, b.F, b.T, b.Ls, sumo, ph);

    /* ---------- drawing ---------- */
    const pt = p => `${p[0].toFixed(1)},${(-p[1]).toFixed(1)}`;
    const line = (pts, cls) => `<polyline class="${cls}" points="${pts.map(pt).join(' ')}"/>`;
    const dot = (p, r, cls) => `<circle class="${cls}" cx="${p[0].toFixed(1)}" cy="${(-p[1]).toFixed(1)}" r="${r}"/>`;
    const footShape = (ax, dir = 1) => `<polygon class="tg-foot" points="${[[ax - 7 * dir, 0], [ax + 20 * dir, 0], [ax + 18 * dir, 3], [ax + 3 * dir, 8], [ax - 5 * dir, 8]].map(pt).join(' ')}"/>`;
    const barbell = B => dot(B, 22.5, 'tg-disc') + dot(B, 2.6, 'tg-bar');

    function drawStanding(b, pose, trace, arms) {
        const { A, K, H, Sh, B, MF, tor } = pose, u = [Math.sin(tor), Math.cos(tor)];
        const head = [Sh[0] + u[0] * .085 * b.H + 2 * u[1], Sh[1] + u[1] * .085 * b.H - 2 * u[0]];
        let s = line([[-58, 0], [60, 0]], 'tg-ground') + line([[MF, 0], [MF, b.H * 1.03]], 'tg-guide') + line(trace, 'tg-trace');
        s += dot(B, 22.5, 'tg-disc');
        if (Math.abs(B[0] - H[0]) > 3) s += line([H, [B[0], H[1]]], 'tg-arm-line');
        s += footShape(A[0]) + line([A, K, H], 'tg-bone tg-leg') + line([H, Sh], 'tg-bone tg-torso') + line([Sh, head], 'tg-bone tg-neck');
        s += dot(head, (.058 * b.H).toFixed(1), 'tg-head') + line(arms(pose, u), 'tg-bone tg-limb');
        s += dot(K, 1.8, 'tg-joint') + dot(H, 1.8, 'tg-joint') + dot(Sh, 1.6, 'tg-joint') + dot(B, 2.6, 'tg-bar');
        return s;
    }
    const DRAW = {
        squat(b, ph) {
            const trace = []; for (let i = 0; i <= 16; i++) trace.push(squatPose(b, i / 16).B);
            return drawStanding(b, squatPose(b, ph), trace, (p, u) => [p.Sh, [p.B[0] - 13 * u[0] - 9 * u[1], p.B[1] - 13 * u[1] + 9 * u[0]], p.B]);
        },
        deadlift(b, ph) {
            const trace = []; for (let i = 0; i <= 16; i++) trace.push(deadPose(b, i / 16).B);
            return drawStanding(b, deadPose(b, ph), trace, p => [p.Sh, p.B]);
        },
        bench(b, ph) {
            const m = bpCalc(b, ARCH[store.arch], ph), r = .058 * b.H, head = [-(r + 5), m.PAD + r + .5];
            const trace = []; for (let i = 0; i <= 16; i++) trace.push(m.at(i / 16));
            const padL = -(2 * r + 14), padR = m.hip[0] + 12;
            let s = line([[-40, 0], [128, 0]], 'tg-ground');
            s += `<rect class="tg-pad" x="${padL.toFixed(1)}" y="${-m.PAD}" width="${(padR - padL).toFixed(1)}" height="5" rx="2"/>`;
            s += line([[padL + 10, m.PAD - 5], [padL + 10, 0]], 'tg-post') + line([[padR - 10, m.PAD - 5], [padR - 10, 0]], 'tg-post');
            s += line([[m.lock[0], m.S[1]], [m.lock[0], m.lock[1] + 26]], 'tg-guide') + line(trace, 'tg-trace') + dot(m.bar, 22.5, 'tg-disc');
            s += footShape(m.ankle[0]) + line([m.hip, m.knee, m.ankle], 'tg-bone tg-leg');
            s += `<path class="tg-bone tg-chest" d="M${pt(m.S)} Q${pt(m.ctrl)} ${pt(m.hip)}"/>` + dot(head, r.toFixed(1), 'tg-head');
            s += line([m.S, m.elbow, m.bar], 'tg-bone tg-limb') + dot(m.S, 1.6, 'tg-joint') + dot(m.elbow, 1.6, 'tg-joint') + dot(m.bar, 2.6, 'tg-bar');
            return s;
        }
    };
    // Framed on the lifter, so a taller body fills the stage the same way a shorter one does.
    const standingView = b => { const top = Math.round(b.H * 1.03 + 6); return `-62 ${-top} 126 ${top + 4}`; };
    const VIEW = { squat: standingView, deadlift: standingView, bench: b => { const top = Math.round(52.5 + b.A + 30); return `-42 ${-top} 172 ${top + 4}`; } };

    /* ---------- content ---------- */
    const mine = v => `<b class="tg-mine">${v}</b>`;

    /* ---------- grip and stance ---------- */
    // Every grip is measured between the index fingers, every stance between the heels.
    const HAND = 8.5; // cm across four fingers
    function pick(key, start, min, max) { return clamp(store.w[key] == null ? r0(start) : store.w[key], min, max); }
    // Where the ring mark falls on the hand, which is how a width is found on a real bar.
    function ringMark(v) {
        const d = (RINGS - v) / 2;
        if (d < -1.2) return `Index finger ${r0(-d)} cm outside the ring`;
        if (d < 1.2) return 'Index finger on the ring';
        if (d < 3.3) return 'Middle finger on the ring';
        if (d < 5.5) return 'Ring finger on the ring';
        if (d < 7.7) return 'Pinky on the ring';
        if (d < 10) return 'Pinky just inside the ring';
        return `Index finger ${r0(d)} cm inside the ring`;
    }
    const armTilt = (v, b) => deg(Math.asin(clamp((v / 2 + HAND / 2 - (b.B / 2 - 2)) / b.A, -1, 1)));
    function armRead(v, b) {
        const a = Math.abs(armTilt(v, b));
        return a < 2.5 ? 'Arms hang straight down.' : `Arms ${r0(a)}° off vertical, which adds ${(b.A * (1 - Math.cos(rad(a)))).toFixed(1)} cm to the pull.`;
    }
    const benchElbow = b => b.B / 2 - 2 + .55 * b.Lu; // elbow, out from the midline, with the bar on the chest
    function widths(lift, b) {
        const out = {}, x = n => (n).toFixed(1);
        const add = (name, m) => { m.v = pick(m.key, m.start, m.min, m.max); m.start = clamp(r0(m.start), m.min, m.max); out[name] = m; return m; };
        if (lift === 'bench') {
            const start = benchGrip(b), Lf = b.A - b.Lu;
            add('grip', {
                key: 'bg', label: 'Grip', how: 'between index fingers', min: 40, max: RINGS, start, lo: start - 4, hi: Math.min(RINGS, start + 6), mark: ringMark,
                read(v) {
                    const t = deg(Math.asin(clamp((v / 2 + 2 - benchElbow(b)) / Lf, -1, 1))), rom = r0(bpCalc(b, ARCH[store.arch], 1).rom);
                    const stack = Math.abs(t) < 3 ? 'Forearms vertical at the chest.' : `Wrists ${r0(Math.abs(t))}° ${t > 0 ? 'outside' : 'inside'} the elbows at the chest.`;
                    return `${stack} Bar travel ${rom} cm.` + (v >= RINGS ? ' This is the widest legal grip.' : '');
                },
                why: 'The start is where your forearms are vertical at the chest: your shoulder width plus how far your elbows travel out.',
                wider: 'You are slow off the chest, your arms are long, and your shoulders are happy. Watch the bar travel above as you move it.',
                narrower: 'The front of the shoulder aches, the wrists bend back, or lockout is your strong point.',
                check: 'Film from the head or the feet. At the touch the wrist sits over the elbow. Move one finger at a time and keep each width for two weeks.'
            });
            out.feet = { label: 'Feet', how: 'no single number', fixed: 'Wider than your hips, as far back as you can with the heels still down.',
                why: 'The feet are there to push you up the bench and hold the arch, so position matters more than width.',
                check: 'Push hard through the floor. The glutes stay on the bench and the feet do not slide. If the glutes lift, move the feet wider or further forward.' };
        } else if (lift === 'squat') {
            const low = store.low, gLo = b.B * (low ? 1.5 : 1.3), gHi = b.B * (low ? 2 : 1.7);
            const sLo = b.B * (low ? 1.05 : .95), sHi = b.B * (low ? 1.25 : 1.1), long = clamp((b.ratio - .78) / .14, 0, 1);
            const s = add('stance', {
                key: low ? 'ssl' : 'ssh', label: 'Stance', how: 'between the heels', min: 25, max: 90, start: lerp(sLo, sHi, .25 + .5 * long), lo: sLo, hi: sHi,
                mark: v => `Toes out about ${5 * Math.round((15 + 15 * clamp((v - sLo) / (sHi - sLo), 0, 1)) / 5)}°`,
                read: v => `${x(v / b.B)} × your shoulder width.` + (v > sHi + 4 ? ' Wide: a shorter squat, but depth and knee tracking get harder.' : v < sLo - 4 ? ' Narrow: more knee travel and a longer squat.' : ''),
                why: `Wide enough for the hips to drop between the thighs, narrow enough for the knees to track over the toes. ${long > .7 ? 'Yours starts toward the wide end because your thighs are long for your torso.' : long < .3 ? 'Yours starts toward the narrow end because your thighs are short for your torso.' : 'Yours starts mid-range.'}`,
                wider: 'The hips pinch at the bottom, you fold forward, or you cannot reach depth without the lower back tucking under.',
                narrower: 'The knees cave in, the groin aches, or you lose the bounce out of the bottom.',
                check: 'Sit in the bottom of a bodyweight squat and shuffle your feet until the hips sink freely. From the front, each thigh points where its toes point.'
            });
            s.toes = +s.mark(s.v).match(/\d+/)[0];
            add('grip', {
                key: low ? 'sgl' : 'sgh', label: 'Grip', how: 'between index fingers', min: 45, max: 120, start: b.B * (low ? 1.75 : 1.5), lo: gLo, hi: gHi, mark: ringMark,
                read: v => `${x(v / b.B)} × your shoulder width. ` + (v < gLo ? 'Narrow: a very tight back, hard on elbows and shoulders.' : v > gHi ? 'Wide: easy on the shoulders, but the upper back is harder to keep tight.' : 'A tight upper back without forcing the shoulders.'),
                why: `As narrow as your shoulders allow with straight wrists. A narrow grip squeezes the upper back into a shelf for the bar${low ? ', and low bar needs a little more room than high bar' : ''}.`,
                wider: 'Elbows, wrists or the front of the shoulder hurt, or you cannot keep the wrists straight.',
                narrower: 'The bar moves on your back, or the upper back goes soft out of the bottom.',
                check: 'Wrists straight, elbows under the bar or just behind it, and no elbow ache the day after. Bring it in one finger at a time as your shoulders loosen.'
            });
        } else if (store.sumo) {
            const ideal = clamp(.45 * b.B + 1.3 * b.F, 1.6 * b.B, 2.2 * b.B);
            const s = add('stance', {
                key: 'dss', label: 'Stance', how: 'between the heels', min: 50, max: 120, start: ideal, lo: ideal - 8, hi: ideal + 8,
                mark: v => `Toes out about ${5 * Math.round((30 + 15 * clamp((v - ideal + 8) / 16, 0, 1)) / 5)}°`,
                read: v => v > ideal + 6 ? 'Wide for your thighs: the knees end up inside the ankles unless your hips open a lot.' : v < ideal - 6 ? 'Semi-sumo: the shins lean in a little. Easier off the floor, longer pull.' : 'Shins vertical at the start, seen from the front.',
                why: 'Wide enough that the shins are vertical seen from the front, with the knees over the ankles. The start comes from your thigh length.',
                wider: 'It leaves the floor easily but your back takes over, and your hips can open further without pain.',
                narrower: 'It is glued to the floor, the knees cave in, or the hips hurt.',
                check: 'Film the start from the front: shins vertical, knees over the ankles, hips close to the bar. Knees inside the ankles means too wide.'
            });
            s.toes = +s.mark(s.v).match(/\d+/)[0];
            add('grip', {
                key: 'dgs', label: 'Grip', how: 'between index fingers', min: 25, max: 70, start: b.B - 10, lo: b.B - 12, hi: b.B - 2, mark: ringMark,
                read: v => armRead(v, b),
                why: 'Straight down from the shoulders, inside the knees. Any wider only makes the pull longer.',
                wider: 'Your hands rub the inside of your thighs at lockout.',
                narrower: 'Your arms angle out, or your forearms push against your knees.',
                check: 'From the front the arms hang plumb. On many bars this puts the hands where the knurling starts.'
            });
        } else {
            const s = add('stance', {
                key: 'dsc', label: 'Stance', how: 'between the heels', min: 15, max: 55, start: b.B * .65, lo: b.B * .55, hi: b.B * .75,
                mark: () => 'Toes out about 10°',
                read: v => v > b.B * .8 ? 'Wider than your hips: the knees crowd your arms and push the grip out.' : v < b.B * .5 ? 'Very narrow: little room for the belly, harder to balance.' : `${x(v / b.B)} × your shoulder width.`,
                why: 'Feet under the hip joints, where you would stand to jump as high as you can.',
                wider: 'Your belly or thighs block the start position, or your hips feel jammed.',
                narrower: 'The knees push into your arms, or the grip has to go wide to clear them.',
                check: 'Jump straight up three times and look at where your feet land. Start there.'
            });
            s.toes = 10;
            const gStart = Math.max(b.B - 10, s.v + 16);
            add('grip', {
                key: 'dgc', label: 'Grip', how: 'between index fingers', min: 30, max: RINGS, start: gStart, lo: gStart - 1, hi: gStart + 6, mark: ringMark,
                read: v => (v < s.v + 13 ? 'Too narrow for this stance: your hands land on your knees. ' : '') + armRead(v, b),
                why: 'As narrow as your legs allow, so the arms hang straight and the pull is as short as it can be. It follows your stance.',
                wider: 'Your knees push your elbows out, or your thumbs scrape your thighs.',
                narrower: 'There is a gap between your arms and your legs.',
                check: 'Thumbs brush the outside of the thighs on the way up. Arms straight, not bowed around the knees.'
            });
        }
        return out;
    }
    // Front view, to scale across: the bar with its rings, the lifter's shoulders, hands and feet.
    function widthPlan(lift, b, m) {
        const n = v => v.toFixed(1), both = fn => fn(1) + fn(-1), sj = b.B / 2 - 2, g = m.grip.v;
        const seg = (cls, x1, y1, x2, y2) => `<line class="${cls}" x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}"/>`;
        const bar = (y, label = true) => seg('tg-w-shaft', -67, y, 67, y) + both(s => seg('tg-w-sleeve', s * 68, y, s * 88, y) + seg('tg-w-collar', s * 67, y - 5, s * 67, y + 5)
            + seg('tg-w-ring', s * RINGS / 2, y - 5.5, s * RINGS / 2, y + 5.5) + (label ? `<text class="tg-w-label" x="${n(s * RINGS / 2)}" y="${n(y - 8)}">ring</text>` : ''));
        const hands = y => both(s => `<rect class="tg-w-hand" x="${n(s > 0 ? g / 2 : -g / 2 - HAND)}" y="${n(y - 4.5)}" width="${HAND}" height="9" rx="2.5"/>`);
        // Footprints seen from above, toes up the page: heel on the stance line (the number is
        // heel to heel), narrow heel, wide toe end, turned out. Drawn toes-down, the old capsules
        // read as pigeon-toed.
        const FOOT = 'M-3.4 0C-3.6 -8 -5.4 -15 -5.4 -20C-5.4 -25 -2.8 -27 0 -27C2.8 -27 5.4 -25 5.4 -20C5.4 -15 3.6 -8 3.4 0C3.4 2.4 1.8 3.4 0 3.4C-1.8 3.4 -3.4 2.4 -3.4 0Z';
        const feet = (y, st) => both(s => `<path class="tg-w-foot" d="${FOOT}" transform="translate(${n(s * st.v / 2)} ${n(y + 20)}) rotate(${s * st.toes})"/>`);
        const head = y => `<circle class="tg-w-head" cx="0" cy="${y}" r="7.5"/>`;
        let s = '', h;
        if (lift === 'bench') {
            const yb = 14, ex = benchElbow(b), lx = g / 2 + 2, Lf = b.A - b.Lu, ye = yb + Math.sqrt(Math.max(1, Lf * Lf - (lx - ex) * (lx - ex))), ys = ye - 9;
            s += both(k => seg('tg-w-plumb', k * ex, yb - 9, k * ex, ye)) + seg('tg-w-body', -sj, ys, sj, ys);
            s += both(k => seg('tg-w-arm', k * sj, ys, k * ex, ye) + seg('tg-w-arm', k * ex, ye, k * lx, yb) + `<circle class="tg-w-joint" cx="${n(k * ex)}" cy="${n(ye)}" r="1.5"/>`);
            s += bar(yb) + hands(yb); h = ye + 7;
        } else if (lift === 'squat') {
            const yb = 24, yf = 54;
            s += head(11) + both(k => seg('tg-w-plumb', k * b.B / 2, yb + 4, k * b.B / 2, yf + 24)) + seg('tg-w-body', -b.B / 2 + 4, yb + 4, b.B / 2 - 4, yb + 4);
            s += feet(yf, m.stance) + bar(yb) + hands(yb); h = yf + 28;
        } else {
            const ys = 22, hx = g / 2 + HAND / 2, yb = ys + Math.sqrt(Math.max(1, b.A * b.A - (hx - sj) * (hx - sj)));
            s += head(9) + both(k => seg('tg-w-plumb', k * sj, ys, k * sj, yb)) + seg('tg-w-body', -b.B / 2 + 4, ys, b.B / 2 - 4, ys);
            s += feet(yb - 9, m.stance) + both(k => seg('tg-w-arm', k * sj, ys, k * hx, yb)) + bar(yb, Math.abs(m.stance.v / 2 - RINGS / 2) > 16) + hands(yb); h = yb + 22;
        }
        return { svg: s, box: `-88 -2 176 ${Math.round(h + 2)}` };
    }
    const BRACE = { t: 'Settle, then brace', d: 'Let the bar stop moving. Small exhale to drop the ribs, then one big breath into the belt: front, sides and back.' };

    const GUIDE = {
        squat: {
            label: 'Squat',
            variants: () => [['Low bar', store.low], ['High bar', !store.low]],
            setVariant: i => { store.low = i === 0; },
            timeline: [[500, 0, 0], [1700, 0, 1], [450, 1, 1], [1400, 1, 0], [600, 0, 0]], introEnd: 2200, rest: 1,
            phases: { top: 'Top', down: 'Down', bottom: 'Bottom', up: 'Up' },
            phaseAt: (ph, dir) => ph <= .02 ? 'top' : ph >= .98 ? 'bottom' : dir < 0 ? 'up' : 'down',
            poseOf: { top: 0, down: .5, bottom: 1, up: .5 },
            legend: 'Dashed line: the bar stays over midfoot. Short line: how far your hips sit behind it.',
            stats(b) {
                const p = squatPose(b, 1);
                return [[r0(deg(p.tor)) + '°', 'torso lean at the bottom'], [r0(Math.abs(p.B[0] - p.H[0])) + ' cm', 'hips behind the bar'], [r0(Math.max(0, p.K[0] - p.B[0])) + ' cm', 'knees ahead of it']];
            },
            insight(b) {
                const lean = r0(deg(squatPose(b, 1).tor));
                if (b.ratio > .92) return `Long thighs for your torso. You lean about ${lean}° at the bottom, more than most, and that is your build, not a fault. Heeled shoes or a slightly wider stance sit you more upright.`;
                if (b.ratio < .78) return `Short thighs for your torso. You can stay upright (about ${lean}°), and a narrower stance will work well.`;
                return `About ${lean}° of lean at the bottom is what a balanced squat looks like on your proportions. Don't fight it to look more upright.`;
            },
            setup: b => { const w = widths('squat', b); return [
                { t: 'Wedge under the bar', d: `Index fingers ${mine(w.grip.v + ' cm')} apart (${w.grip.mark(w.grip.v).toLowerCase()}), wrists straight. ${store.low ? 'Bar on the shelf your rear delts make when you squeeze the upper back.' : 'Bar on top of the traps.'} Pull it into you until it feels like part of your back.` },
                { t: 'Both feet under it, stand up', d: 'Big breath, hips through, lift it with both legs. Never from a split stance.' },
                { t: 'Three steps', d: 'Back, back, adjust. Then stop moving your feet.' },
                { t: 'Find your stance', d: `Heels ${mine(w.stance.v + ' cm')} apart, toes out about ${w.stance.toes}°.` },
                BRACE,
                { t: 'Meet day', d: 'Wait for “Squat”. Hip crease below the top of the knee. Stand still, knees locked, for “Rack”.', meet: true }
            ]; },
            cues: [
                { id: 'sq-feet', ph: 'top', t: 'Grip the floor', d: 'Big toe, little toe, heel. Weight stays midfoot.' },
                { id: 'sq-air', ph: 'top', t: 'Big air into the belt', d: 'Brace before you move, hold it to the top.' },
                { id: 'sq-break', ph: 'down', t: 'Hips and knees break together', d: 'Sitting back first throws the bar forward.' },
                { id: 'sq-sit', ph: 'down', t: 'Sit between your heels', d: 'Knees out over the toes, hips straight down.' },
                { id: 'sq-hole', ph: 'bottom', t: 'Tight in the hole', d: 'Just below parallel. No relaxing, no second bounce.' },
                { id: 'sq-back', ph: 'up', t: 'Back into the bar', d: 'Chest and hips rise at the same speed.' },
                { id: 'sq-floor', ph: 'up', t: 'Push the floor away', d: 'Drive through the whole foot, knees stay out.' }
            ],
            fixes: [
                ['Hips shoot up first', '“Back into the bar.” Add pause squats and quad work.'],
                ['Knees cave on the way up', '“Spread the floor.” Turn the toes out a little more.'],
                ['Bar drifts toward the toes', 'Break hips and knees together and keep the upper back tight. Film from the side.'],
                ['Depth changes rep to rep', 'Same descent speed every rep. Pause squats, and film your top sets.'],
                ['Elbows or wrists hurt', 'Widen the grip, thumbs over the bar. Your back holds the bar, not your hands.']
            ]
        },
        bench: {
            label: 'Bench',
            variants: () => [['Flat', store.arch === 0], ['Arch', store.arch === 1], ['Big arch', store.arch === 2]],
            setVariant: i => { store.arch = i; },
            timeline: [[500, 0, 0], [1500, 0, 1], [800, 1, 1], [1300, 1, 0], [600, 0, 0]], introEnd: 2000, rest: 1,
            phases: { start: 'Start', down: 'Down', touch: 'Touch', press: 'Press' },
            phaseAt: (ph, dir) => ph <= .02 ? 'start' : ph >= .98 ? 'touch' : dir < 0 ? 'press' : 'down',
            poseOf: { start: 0, down: .5, touch: 1, press: .5 },
            legend: 'Dashed line: lockout is over the shoulder joint. The bar touches low and travels back toward your face.',
            stats(b) {
                const m = bpCalc(b, ARCH[store.arch], 1);
                return [[m.grip + ' cm', 'grip, index to index'], [r0(m.rom) + ' cm', 'bar travel'], [r0(m.touch[0]) + ' cm', 'touch below the shoulder line']];
            },
            insight(b) {
                const rom = r0(bpCalc(b, ARCH[store.arch], 1).rom);
                if (b.ape > 1.03) return `Long arms: the bar travels about ${rom} cm, so grip width and arch buy you more than they buy most lifters. Lockout strength matters for you.`;
                if (b.ape < .98) return `Short arms: a ${rom} cm stroke is already short. You can afford a slightly narrower, triceps-friendly grip.`;
                return `This grip puts your forearms vertical at the bottom. A few centimetres wider shortens the ${rom} cm stroke if your shoulders are happy with it.`;
            },
            setup: b => {
                const g = widths('bench', b).grip.v;
                return [
                    { t: 'Eyes under the bar', d: 'So the unrack is a short pull, not a reach.' },
                    { t: 'Shoulder blades back and down', d: 'Pinch them together and tuck them toward your back pockets. They stay there the whole set.' },
                    { t: 'Take your grip', d: `${mine(g + ' cm')} between index fingers (${ringMark(g).toLowerCase()}). Bar low in the palm, over the wrist, thumbs around.` },
                    { t: 'Feet down, chest up', d: 'Plant the feet and push yourself toward your head. Chest high, glutes on the bench. Keep that leg tension until the bar is racked.' },
                    { t: 'Breathe, pull it out', d: 'Big breath, then pull the bar out over the shoulders with straight arms. Pressing it out of the hooks unpacks your shoulders.' },
                    { t: 'Meet day', d: '“Start”, hold it still on the chest for “Press”, lock out for “Rack”. Head, shoulders and glutes stay down, feet flat. Elbows must drop to shoulder-joint height.', meet: true }
                ];
            },
            cues: [
                { id: 'bp-bend', ph: 'start', t: 'Bend the bar', d: 'Turns the lats on before it moves.' },
                { id: 'bp-chest', ph: 'start', t: 'Chest to the ceiling', d: 'Big breath, ribs high, blades pinned.' },
                { id: 'bp-pull', ph: 'down', t: 'Pull the bar to you', d: 'Row it down. Don’t let it fall.' },
                { id: 'bp-stack', ph: 'down', t: 'Wrists over elbows', d: 'Forearms vertical when it touches.' },
                { id: 'bp-touch', ph: 'touch', t: 'Same spot, stay tight', d: 'Lower sternum. Touch it, don’t sink it.' },
                { id: 'bp-away', ph: 'press', t: 'Push yourself away from the bar', d: 'Drive your back down into the bench.' },
                { id: 'bp-legs', ph: 'press', t: 'Heels down, drive back', d: 'Legs push you toward your head. Glutes stay down.' },
                { id: 'bp-face', ph: 'press', t: 'Back toward your face', d: 'The bar finishes over the shoulders, elbows flaring as it rises.' }
            ],
            fixes: [
                ['Glutes lift off the bench', 'Drive toward your head, not up. Move the feet further back or wider.'],
                ['Slow off the chest', 'Stay tight on the pause. Long-pause bench and Spoto press.'],
                ['Stalls halfway up', 'The bar drifted over your belly. Press back toward your face and let the elbows flare.'],
                ['Misses at lockout', 'Close-grip bench and triceps work. Check the bar ends over the shoulders.'],
                ['Front of the shoulder hurts', 'Your blades slipped. Reset them, tuck the elbows more, go a little narrower.']
            ]
        },
        deadlift: {
            label: 'Deadlift',
            variants: () => [['Conventional', !store.sumo], ['Sumo', store.sumo]],
            setVariant: i => { store.sumo = i === 1; },
            timeline: [[700, 0, 0], [2000, 0, 1], [600, 1, 1], [1500, 1, 0], [500, 0, 0]], introEnd: 5300, rest: 0,
            phases: { start: 'Start', floor: 'Off the floor', knees: 'Past the knees', lock: 'Lockout', lower: 'Lower' },
            phaseAt: (ph, dir) => ph <= .02 ? 'start' : ph >= .98 ? 'lock' : dir < 0 ? 'lower' : ph < .3 ? 'floor' : 'knees',
            poseOf: { start: 0, floor: .15, knees: .6, lock: 1 },
            legend: 'Dashed line: the bar rises straight over midfoot. Short line: how far your hips start behind it.',
            stats(b) {
                const p = deadPose(b, 0);
                return [[r0(deg(p.tor)) + '°', 'torso lean at the start'], [r0(Math.abs(p.B[0] - p.H[0])) + ' cm', 'hips behind the bar'], [r0(p.travel - (store.sumo ? 8 : 0)) + ' cm', 'bar travel']];
            },
            insight(b) {
                const tc = r0(deg(deadPose(b, 0, false).tor)), ts = r0(deg(deadPose(b, 0, true).tor));
                if (tc >= 66) return `Conventional starts you nearly flat, at about ${tc}°. Sumo keeps you at about ${ts}°, so it is worth testing on your build.`;
                if (tc <= 56) return `Conventional suits your build: you start fairly upright, at about ${tc}° (sumo would be ${ts}°).`;
                return `Neither style has a clear edge on your build (${tc}° conventional, ${ts}° sumo). Run both for a few weeks and keep the one that moves more at the same effort.`;
            },
            setup: b => { const w = widths('deadlift', b); return (store.sumo ? [
                { t: 'Feet wide, bar over midfoot', d: `Heels ${mine(w.stance.v + ' cm')} apart, toes out about ${w.stance.toes}°, shins vertical when seen from the front.` },
                { t: 'Grip straight down', d: `Index fingers ${mine(w.grip.v + ' cm')} apart, arms hanging plumb inside the knees. Don’t move the bar.` },
                { t: 'Knees out, hips to the bar', d: 'Open the knees over the toes and sit in until your hips are close to the bar.' }
            ] : [
                { t: 'Bar over midfoot', d: `Two or three centimetres from your shins as you stand. Heels ${mine(w.stance.v + ' cm')} apart.` },
                { t: 'Grip without moving the bar', d: `Hinge down. Index fingers ${mine(w.grip.v + ' cm')} apart, just outside the legs.` },
                { t: 'Shins to the bar', d: 'Bend the knees until the shins touch it. Don’t roll it.' }
            ]).concat([
                { t: 'Brace, flex your armpits', d: 'Big breath into the belt. Lats pull the bar into you.' },
                { t: 'Pull the slack out', d: `Lift until the bar clicks against the plates and bends. Chest up, hips wedged in. ${store.sumo ? 'Sumo is slow off the floor: build tension, never jerk it.' : 'You are already pulling before it leaves the floor.'}` },
                { t: 'Meet day', d: 'No start signal. Stand tall, knees locked, shoulders back, and hold for “Down”. Follow the bar down with both hands.', meet: true }
            ]); },
            cues: [
                { id: 'dl-lats', ph: 'start', t: 'Flex your armpits', d: 'Lats on. The bar stays against you.' },
                { id: 'dl-slack', ph: 'start', t: 'Slack out, chest up', d: 'Hear the click before you pull.' },
                { id: 'dl-push', ph: 'floor', only: 'conv', t: 'Push the floor away', d: 'Leg press it. Back angle doesn’t change yet.' },
                { id: 'dl-spread', ph: 'floor', only: 'sumo', t: 'Spread the floor', d: 'Knees stay out. Be patient, it breaks slowly.' },
                { id: 'dl-drag', ph: 'knees', t: 'Bar up the legs', d: 'In contact all the way.' },
                { id: 'dl-hips', ph: 'knees', t: 'Hips to the bar', d: 'Once it passes the knees, drive the hips through.' },
                { id: 'dl-tall', ph: 'lock', t: 'Stand tall', d: 'Glutes finish it. No leaning back.' }
            ],
            fixes: [
                ['Hips shoot up first', 'Start with the hips a little higher and pull the slack out before you go. “Push the floor.”'],
                ['Bar swings away from the shins', '“Flex your armpits.” Start with the bar over midfoot, not the toes.'],
                ['Back rounds as it leaves the floor', 'You pulled before the slack was out. Brace, wedge, then go. Pause just off the floor in training.'],
                ['Stuck at the knees', 'Keep the bar on your legs. Pauses below the knee and Romanian deadlifts.'],
                ['Soft lockout or hitching', '“Hips to the bar” sooner. Block pulls and hip thrusts.'],
                ['Grip opens', 'Hook or mixed grip, chalk, bar in the fingers rather than the palm.']
            ]
        }
    };
    const cueShown = (lift, c) => !c.only || (lift === 'deadlift' && (c.only === 'sumo') === store.sumo);
    function cueById(lift, id) { return GUIDE[lift].cues.find(c => c.id === id); }

    loadBody(); loadPins();

    /* Label for the workout card: the pinned cues, or "Technique" when none are pinned. */
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    window.techniqueCueHtml = function(lift) {
        const list = (pins[lift] || []).map(id => cueById(lift, id)).filter(Boolean);
        return list.length ? list.map(c => `<span class="tq-cue">${esc(c.t)}</span>`).join('') : '<span>Technique</span>';
    };
    function refreshCards() {
        document.querySelectorAll('[data-technique-cue]').forEach(el => {
            const lift = el.dataset.techniqueCue;
            if (GUIDE[lift]) { el.innerHTML = window.techniqueCueHtml(lift); el.classList.toggle('has-cue', pins[lift].length > 0); }
        });
    }

    /* ---------- dialog ---------- */
    let dialog, $, opener, previousOverflow;
    const view = { lift: 'squat', tab: 'cues', ph: 1, dir: 1, raf: 0, phase: '' };
    const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const PIN_SVG = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6ZM12 14v7"/></svg>';

    function build() {
        dialog = document.createElement('dialog');
        dialog.id = 'technique-guide';
        dialog.setAttribute('aria-label', 'Technique guide');
        dialog.setAttribute('data-no-tab-swipe', '');
        dialog.innerHTML = `
        <div class="tg">
            <header class="tg-head">
                <div class="tg-lifts" role="tablist" aria-label="Lift">
                    ${LIFTS.map(l => `<button type="button" role="tab" data-lift="${l}">${GUIDE[l].label}</button>`).join('')}
                    <span class="tg-plate" aria-hidden="true"></span>
                </div>
                <button type="button" class="tg-close" aria-label="Close technique guide"><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
            </header>
            <div class="tg-body">
                <section class="tg-model" aria-label="Schematic">
                    <div class="tg-stage">
                        <svg class="tg-svg" role="img" preserveAspectRatio="xMidYMax meet"></svg>
                        <dl class="tg-stats"></dl>
                        <span class="tg-phase"></span>
                    </div>
                    <div class="tg-transport">
                        <button type="button" class="tg-play" aria-pressed="false">Play rep</button>
                        <input type="range" class="tg-scrub" min="0" max="100" value="100" aria-label="Rep position">
                    </div>
                    <div class="tg-options">
                        <div class="tg-seg" role="group" aria-label="Style"></div>
                        <button type="button" class="tg-body-btn" aria-expanded="false" aria-controls="tg-bodyform">My body</button>
                    </div>
                    <form class="tg-bodyform" id="tg-bodyform" hidden>
                        ${Object.entries(FIELDS).map(([k, f]) => `<label class="tg-field"><span class="tg-field-top"><span>${f.label}</span><output data-out="${k}"></output></span><input type="range" data-field="${k}" min="${f.min}" max="${f.max}" step="1"><small>${f.hint}</small></label>`).join('')}
                        <button type="button" class="tg-reset">Use averages for my height</button>
                    </form>
                    <p class="tg-insight"></p>
                    <p class="tg-legend"></p>
                </section>
                <section class="tg-read">
                    <div class="tg-tabs" role="tablist" aria-label="Guide">
                        ${[['setup', 'Setup'], ['cues', 'Cues'], ['width', 'Width'], ['fixes', 'Fixes']].map(([id, label]) => `<button type="button" role="tab" data-tab="${id}">${label}</button>`).join('')}
                    </div>
                    <div class="tg-panel" role="tabpanel" tabindex="-1"></div>
                </section>
            </div>
        </div>`;
        document.body.append(dialog);
        $ = sel => dialog.querySelector(sel);

        dialog.addEventListener('click', event => {
            if (event.target === dialog) { dialog.close(); return; }
            const hit = sel => event.target.closest(sel);
            let el;
            if (hit('.tg-close')) dialog.close();
            else if ((el = hit('[data-lift]'))) showLift(el.dataset.lift, true);
            else if ((el = hit('[data-tab]'))) { view.tab = el.dataset.tab; renderPanel(); }
            else if ((el = hit('[data-variant]'))) { GUIDE[view.lift].setVariant(+el.dataset.variant); saveBody(); stop(); renderAll(); }
            else if (hit('.tg-play')) { if (view.raf) stop(); else play(false); }
            else if (hit('.tg-body-btn')) toggleBody();
            else if (hit('.tg-reset')) { ['f', 't', 'a', 'b'].forEach(k => { store[k] = null; }); saveBody(); syncBodyForm(); renderAll(); }
            else if ((el = hit('[data-pin]'))) togglePin(el.dataset.pin);
            else if ((el = hit('[data-width-reset]'))) { delete store.w[el.dataset.widthReset]; saveBody(); renderModel(); syncWidths(); }
            else if ((el = hit('[data-pose]'))) { stop(); view.dir = el.dataset.pose === 'up' || el.dataset.pose === 'press' ? -1 : 1; setPose(GUIDE[view.lift].poseOf[el.dataset.pose]); }
        });
        dialog.addEventListener('input', event => {
            const field = event.target.dataset.field, wkey = event.target.dataset.width;
            if (wkey) { store.w[wkey] = +event.target.value; saveBody(); renderModel(); syncWidths(); }
            else if (field) { store[field] = +event.target.value; saveBody(); syncBodyForm(); renderAll(); }
            else if (event.target.classList.contains('tg-scrub')) { stop(); const v = event.target.value / 100; view.dir = v < view.ph ? -1 : 1; setPose(v); }
        });
        $('.tg-bodyform').addEventListener('submit', event => event.preventDefault());
        dialog.addEventListener('close', () => {
            stop();
            document.body.style.overflow = previousOverflow;
            refreshCards();
            if (opener && opener.isConnected) opener.focus({ preventScroll: true });
        });
        document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
    }

    function toggleBody(force) {
        const form = $('.tg-bodyform'), open = force !== undefined ? force : form.hidden;
        form.hidden = !open;
        $('.tg-body-btn').setAttribute('aria-expanded', String(open));
        if (open) syncBodyForm();
    }
    function syncBodyForm() {
        const b = body(), shown = { h: b.H, f: b.F, t: b.T, a: b.A, b: b.B };
        Object.keys(FIELDS).forEach(k => {
            $(`[data-field="${k}"]`).value = r0(shown[k]);
            $(`[data-out="${k}"]`).textContent = r0(shown[k]) + ' cm' + (k !== 'h' && store[k] === null ? ', average' : '');
        });
    }

    /* ---------- rendering ---------- */
    function drawFigure() {
        const g = GUIDE[view.lift];
        $('.tg-svg').innerHTML = DRAW[view.lift](body(), view.ph);
        const phase = g.phaseAt(view.ph, view.dir);
        if (phase !== view.phase) {
            view.phase = phase;
            $('.tg-phase').textContent = g.phases[phase];
            dialog.querySelectorAll('[data-pose]').forEach(el => el.classList.toggle('on', el.dataset.pose === phase));
        }
    }
    function setPose(ph) {
        view.ph = clamp(ph, 0, 1);
        $('.tg-scrub').value = Math.round(view.ph * 100);
        drawFigure();
    }
    function renderModel() {
        const g = GUIDE[view.lift], b = body();
        const svg = $('.tg-svg');
        svg.setAttribute('viewBox', VIEW[view.lift](b));
        svg.setAttribute('aria-label', `${g.label}, side view, drawn to your proportions`);
        $('.tg-stats').innerHTML = g.stats(b).map(([v, label]) => `<div><dd>${v}</dd><dt>${label}</dt></div>`).join('');
        $('.tg-seg').innerHTML = g.variants().map(([label, on], i) => `<button type="button" data-variant="${i}" aria-pressed="${on}">${label}</button>`).join('');
        $('.tg-insight').textContent = g.insight(b);
        $('.tg-legend').textContent = g.legend;
        view.phase = '';
        drawFigure();
    }
    function renderPanel() {
        const g = GUIDE[view.lift], b = body(), panel = $('.tg-panel');
        dialog.querySelectorAll('[data-tab]').forEach(el => el.setAttribute('aria-selected', String(el.dataset.tab === view.tab)));
        if (view.tab === 'setup') {
            panel.innerHTML = `<ol class="tg-steps">${g.setup(b).map(s => `<li class="${s.meet ? 'tg-meet' : ''}"><h3>${s.t}</h3><p>${s.d}</p></li>`).join('')}</ol>
                <p class="tg-note">Highlighted numbers come from your body; tune grip and stance under Width. Meet rules are IPF-style; check your federation’s rulebook.</p>`;
        } else if (view.tab === 'cues') {
            const groups = Object.keys(g.poseOf).map(ph => {
                const cues = g.cues.filter(c => c.ph === ph && cueShown(view.lift, c));
                return `<div class="tg-cue-group" data-pose="${ph}"><button type="button" class="tg-cue-phase" aria-label="Show ${g.phases[ph]} on the schematic">${g.phases[ph]}</button><ul>${cues.map(c => {
                    const on = pins[view.lift].includes(c.id);
                    return `<li><div><strong>${c.t}</strong><span>${c.d}</span></div><button type="button" class="tg-pin" data-pin="${c.id}" aria-pressed="${on}" aria-label="${on ? 'Unpin' : 'Pin'} “${c.t}”">${PIN_SVG}</button></li>`;
                }).join('')}</ul></div>`;
            }).join('');
            panel.innerHTML = groups + `<p class="tg-note">Pin up to two. Pinned cues show on the lift’s card in your workout, because one or two is all you can hold under the bar.</p>`;
            view.phase = ''; drawFigure();
        } else if (view.tab === 'width') {
            const m = widths(view.lift, b), tune = (dt, dd) => dd ? `<div><dt>${dt}</dt><dd>${dd}</dd></div>` : '';
            panel.innerHTML = `<figure class="tg-w-plan"><svg class="tg-w-svg" role="img" aria-label="${g.label}: bar, hands${m.stance ? ' and feet' : ''} from the front, to scale" preserveAspectRatio="xMidYMid meet"></svg>
                <figcaption>Front view, to scale. Orange is you: hands${m.stance ? ' and feet' : ''}. Teal is what you line up with: the rings, 81 cm apart, and ${view.lift === 'bench' ? 'your elbows' : 'your shoulders'}.</figcaption></figure>`
                + Object.values(m).map(w => `<section class="tg-w"${w.key ? ` data-w="${w.key}"` : ''}>
                    <div class="tg-w-top"><h3>${w.label}</h3><span>${w.how}</span></div>
                    ${w.key ? `<div class="tg-w-val"><output class="tg-w-num"></output><span class="tg-w-mark"></span></div>
                    <div class="tg-w-slider"><input type="range" data-width="${w.key}" min="${w.min}" max="${w.max}" step="1" aria-label="${g.label} ${w.label.toLowerCase()}, centimetres ${w.how}"><div class="tg-w-scale"><i class="tg-w-band"></i><i class="tg-w-start"></i></div></div>
                    <p class="tg-w-read"></p><button type="button" class="tg-w-reset" data-width-reset="${w.key}" hidden></button>` : `<p class="tg-w-read">${w.fixed}</p>`}
                    <p class="tg-w-why">${w.why}</p>
                    <dl class="tg-w-tune">${tune('Go wider if', w.wider)}${tune('Go narrower if', w.narrower)}${tune('Check', w.check)}</dl>
                </section>`).join('')
                + `<p class="tg-note">The teal band under each slider is the usual range for your build, and the tick is where to start. Your settings are saved and used in Setup. Finger landmarks assume a hand about 9 cm wide and rings 81 cm apart; some squat and deadlift bars are marked differently.</p>`;
            syncWidths();
        } else {
            panel.innerHTML = `<dl class="tg-fixes">${g.fixes.map(([see, fix]) => `<div><dt>${see}</dt><dd>${fix}</dd></div>`).join('')}</dl>`;
        }
    }
    // Fills the Width tab's numbers and drawing in place, so a slider keeps its drag.
    function syncWidths() {
        if (view.tab !== 'width') return;
        const m = widths(view.lift, body()), plan = widthPlan(view.lift, body(), m), svg = $('.tg-w-svg');
        if (!svg) return;
        svg.setAttribute('viewBox', plan.box); svg.innerHTML = plan.svg;
        Object.values(m).filter(w => w.key).forEach(w => {
            const el = $(`[data-w="${w.key}"]`); if (!el) return;
            const q = sel => el.querySelector(sel), pct = v => clamp((v - w.min) / (w.max - w.min) * 100, 0, 100), input = q('input');
            if (document.activeElement !== input) input.value = w.v;
            q('.tg-w-num').textContent = w.v + ' cm';
            q('.tg-w-mark').textContent = w.mark(w.v);
            q('.tg-w-read').textContent = w.read(w.v);
            q('.tg-w-band').style.cssText = `left:${pct(w.lo).toFixed(1)}%;width:${(pct(w.hi) - pct(w.lo)).toFixed(1)}%`;
            q('.tg-w-start').style.left = pct(w.start).toFixed(1) + '%';
            const reset = q('.tg-w-reset'); reset.hidden = w.v === w.start; reset.textContent = `Back to my start, ${w.start} cm`;
        });
    }
    function renderAll() { renderModel(); renderPanel(); }

    function togglePin(id) {
        const list = pins[view.lift], i = list.indexOf(id);
        if (i >= 0) list.splice(i, 1); else { list.push(id); while (list.length > MAX_PINS) list.shift(); }
        savePins(); renderPanel();
        const again = $(`[data-pin="${id}"]`); if (again) again.focus({ preventScroll: true });
    }

    /* ---------- rep player ---------- */
    function stop() {
        if (!dialog) return;
        cancelAnimationFrame(view.raf); view.raf = 0;
        const btn = $('.tg-play'); btn.setAttribute('aria-pressed', 'false'); btn.textContent = 'Play rep';
    }
    function play(intro) {
        const g = GUIDE[view.lift], total = g.timeline.reduce((s, x) => s + x[0], 0), t0 = performance.now();
        const btn = $('.tg-play'); btn.setAttribute('aria-pressed', 'true'); btn.textContent = 'Pause';
        const frame = now => {
            const ms = now - t0;
            if (intro && ms >= g.introEnd) { stop(); view.dir = 1; setPose(g.rest); return; }
            let t = ms % total;
            for (const [d, a, b] of g.timeline) {
                if (t <= d) { view.dir = b < a ? -1 : 1; setPose(a + (b - a) * ease(t / d)); break; }
                t -= d;
            }
            view.raf = requestAnimationFrame(frame);
        };
        cancelAnimationFrame(view.raf);
        view.raf = requestAnimationFrame(frame);
    }

    function showLift(lift, focus) {
        if (!GUIDE[lift]) return;
        stop();
        view.lift = lift; view.ph = GUIDE[lift].rest; view.dir = 1;
        const tabs = $('.tg-lifts');
        tabs.style.setProperty('--tg-i', LIFTS.indexOf(lift));
        tabs.querySelectorAll('[data-lift]').forEach(el => el.setAttribute('aria-selected', String(el.dataset.lift === lift)));
        $('.tg-scrub').value = Math.round(view.ph * 100);
        renderAll();
        $('.tg-body').scrollTop = 0;
        if (focus) tabs.querySelector(`[data-lift="${lift}"]`).focus({ preventScroll: true });
        if (!reducedMotion()) play(true); // one rep on arrival, then it rests on the key position
    }

    window.openTechniqueGuide = function(lift, trigger) {
        if (!GUIDE[lift]) return;
        if (!dialog) build();
        if (!dialog.open) {
            opener = trigger || document.activeElement;
            previousOverflow = document.body.style.overflow;
            document.body.style.overflow = 'hidden';
            toggleBody(false);
            dialog.showModal();
        }
        showLift(lift, false);
        $('.tg-close').focus({ preventScroll: true });
    };
})();
