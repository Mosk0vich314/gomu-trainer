// Experimental, dependency-free plate tracking and personal RPE calibration.
// All thresholds below are engineering gates, not validated accuracy claims.
export function grayscale(image) {
    const out = new Uint8Array(image.data.length / 4);
    for (let i = 0; i < out.length; i++) {
        const j = i * 4;
        out[i] = Math.round(image.data[j] * .299 + image.data[j + 1] * .587 + image.data[j + 2] * .114);
    }
    return out;
}

export function makeTemplate(frame, width, height, x, y, radius) {
    const offsets = [], values = [];
    // Include the rim and a small surrounding region; a flat hub alone is ambiguous.
    const extent = radius * 1.15;
    for (let row = -7; row <= 7; row++) for (let col = -7; col <= 7; col++) {
        const dx = Math.round(col * extent / 7), dy = Math.round(row * extent / 7);
        const px = Math.round(x) + dx, py = Math.round(y) + dy;
        if (px < 0 || py < 0 || px >= width || py >= height) throw new Error('Keep the whole plate and a little space around it in the frame.');
        offsets.push([dx, dy]); values.push(frame[py * width + px]);
    }
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const centered = values.map(v => v - mean);
    const energy = centered.reduce((a, b) => a + b * b, 0);
    if (energy / values.length < 100) throw new Error('The plate has too little visible detail to track. Try a brighter clip with a clearly visible rim.');
    return { offsets, centered, energy, extent: Math.ceil(extent) };
}

export function trackPlate(frame, width, height, template, previous, searchRadius) {
    const scoreAt = (x, y) => {
        const e = template.extent;
        if (x < e || y < e || x >= width - e || y >= height - e) return -1;
        let sum = 0, squares = 0, dot = 0;
        for (let i = 0; i < template.offsets.length; i++) {
            const [dx, dy] = template.offsets[i], value = frame[(y + dy) * width + x + dx];
            sum += value; squares += value * value; dot += value * template.centered[i];
        }
        const variance = squares - sum * sum / template.offsets.length;
        return variance > 1 ? dot / Math.sqrt(template.energy * variance) : -1;
    };
    const cx = Math.round(previous.x), cy = Math.round(previous.y);
    let best = { x: cx, y: cy, score: scoreAt(cx, cy) };
    for (let dy = -searchRadius; dy <= searchRadius; dy += 3) for (let dx = -searchRadius; dx <= searchRadius; dx += 3) {
        const score = scoreAt(cx + dx, cy + dy);
        if (score > best.score) best = { x: cx + dx, y: cy + dy, score };
    }
    const coarse = best;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const score = scoreAt(coarse.x + dx, coarse.y + dy);
        if (score > best.score) best = { x: coarse.x + dx, y: coarse.y + dy, score };
    }
    return best;
}

export function summarizeTrack(points, metersPerPixel) {
    if (points.length < 12 || !Number.isFinite(metersPerPixel) || metersPerPixel <= 0) throw new Error('Not enough tracking data.');
    const ys = points.map((p, i) => {
        const a = points.slice(Math.max(0, i - 1), Math.min(points.length, i + 2)).map(p => p.y).sort((a, b) => a - b);
        return a[Math.floor(a.length / 2)];
    });
    const threshold = .025 / metersPerPixel;
    const reps = [];
    let bottom = 0, top = 0, rising = false;
    const addRep = () => {
        const duration = points[top].t - points[bottom].t;
        const distance = (ys[bottom] - ys[top]) * metersPerPixel;
        if (duration >= .25 && duration <= 8 && distance >= .12 && distance <= .8) {
            reps.push({ start: points[bottom].t, end: points[top].t, duration, distance, velocity: distance / duration });
        }
    };
    for (let i = 1; i < points.length; i++) {
        if (!rising) {
            if (ys[i] >= ys[bottom]) bottom = i;
            if (ys[bottom] - ys[i] >= threshold) { rising = true; top = i; }
        } else {
            if (ys[i] < ys[top]) top = i;
            if (ys[i] - ys[top] >= threshold) { addRep(); rising = false; bottom = i; }
        }
    }
    // A clip cut during the final press must not count as a completed repetition.
    if (rising && points[points.length - 1].t - points[top].t >= .15) addRep();
    if (!reps.length) throw new Error('No complete presses found. Include the lowering, press, and a short hold at the final lockout.');
    const fastest = Math.max(...reps.map(r => r.velocity)), lastVelocity = reps[reps.length - 1].velocity;
    return { reps, lastVelocity, fastestVelocity: fastest, velocityLoss: Math.max(0, (1 - lastVelocity / fastest) * 100), meanScore: points.reduce((s, p) => s + p.score, 0) / points.length };
}

export function validCalibration(sample) {
    return sample && sample.version === 1 && typeof sample.id === 'string' && typeof sample.exercise === 'string'
        && ['paused', 'touch-go'].includes(sample.style) && /^\d{4}-\d{2}-\d{2}$/.test(sample.day)
        && Number.isFinite(sample.load) && sample.load > 0 && sample.load < 1000
        && Number.isInteger(sample.reps) && sample.reps >= 1 && sample.reps <= 20
        && Number.isFinite(sample.lastVelocity) && sample.lastVelocity >= .03 && sample.lastVelocity <= 2
        && Number.isFinite(sample.rpe) && sample.rpe >= 6 && sample.rpe <= 10;
}

function fit(samples) {
    const n = samples.length;
    const x = samples.reduce((s, p) => s + p.lastVelocity, 0) / n, y = samples.reduce((s, p) => s + p.rpe, 0) / n;
    const variance = samples.reduce((s, p) => s + (p.lastVelocity - x) ** 2, 0);
    if (variance < .0001) return null;
    const slope = samples.reduce((s, p) => s + (p.lastVelocity - x) * (p.rpe - y), 0) / variance;
    return slope < 0 ? { slope, intercept: y - slope * x } : null;
}

export function estimateRpe(current, history) {
    // Match the exercise variant, pause style, similar load and repetition range.
    // Exclude this clip so repeated saves cannot train on the observation being predicted.
    const samples = [...new Map(history.filter(validCalibration).map(s => [s.id, s])).values()].filter(s =>
        s.id !== current.id && s.exercise === current.exercise && s.style === current.style
        && Math.abs(s.load / current.load - 1) <= .2 && Math.abs(s.reps - current.reps) <= 2);
    const no = reason => ({ available: false, reason, count: samples.length });
    if (samples.length < 6 || new Set(samples.map(s => s.day)).size < 3) return no('Build your profile with at least 6 self-rated, comparable sets across 3 training days.');
    if (Math.max(...samples.map(s => s.rpe)) - Math.min(...samples.map(s => s.rpe)) < 2) return no('Your ratings need a wider effort range. Keep recording normal training sets; do not change your program for calibration.');
    const model = fit(samples);
    if (!model) return no('Your ratings do not yet show a consistent relationship with speed.');
    const speeds = samples.map(s => s.lastVelocity);
    if (current.lastVelocity < Math.min(...speeds) || current.lastVelocity > Math.max(...speeds)) return no('This press speed is outside your recorded range.');
    // Leave out entire days, not just reps from the same session, to check consistency.
    const errors = [];
    for (const day of new Set(samples.map(s => s.day))) {
        const heldOut = samples.filter(s => s.day === day), model = fit(samples.filter(s => s.day !== day));
        if (!model) return no('More training days are needed to check consistency.');
        heldOut.forEach(s => errors.push(Math.abs(model.intercept + model.slope * s.lastVelocity - s.rpe)));
    }
    const mae = errors.reduce((a, b) => a + b, 0) / errors.length;
    if (mae > 1) return no('Your recorded ratings vary too much for a useful estimate yet.');
    const value = model.intercept + model.slope * current.lastVelocity;
    if (value < 6 || value > 10) return no('The estimate is outside the supported RPE 6–10 range.');
    // This is a deliberately broad heuristic range, NOT a statistical confidence interval.
    const spread = Math.max(1, 2 * mae), half = n => Math.round(n * 2) / 2;
    return { available: true, value: half(value), low: half(Math.max(6, value - spread)), high: half(Math.min(10, value + spread)), count: samples.length, mae };
}
