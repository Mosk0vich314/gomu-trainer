// Run: node --test tools/review_video_core_test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeTemplate, trackPlate, summarizeTrack, estimateRpe } from '../scripts/video-analysis-core.js';

function plateFrame(cx, cy, width = 180, height = 220) {
    const frame = new Uint8Array(width * height).fill(25);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const r = Math.hypot(x - cx, y - cy);
        if (r <= 25) frame[y * width + x] = r < 5 ? 225 : r > 22 ? 190 : 65 + ((x - cx + 50) % 9) * 7;
    }
    return frame;
}

function trajectory(durations = [1, 1.25, 1.5], truncated = false) {
    const points = []; let time = 0;
    const move = (a, b, seconds) => {
        for (let i = 0; i < Math.round(seconds * 20); i++) { points.push({ t: time, x: 90, y: a + (b - a) * i / Math.round(seconds * 20), score: .99 }); time += .05; }
    };
    move(60, 60, .5);
    durations.forEach((duration, i) => {
        move(60, 160, .6); move(160, 160, .25);
        if (truncated && i === durations.length - 1) { move(160, 110, duration / 2); return; }
        move(160, 60, duration); move(60, 60, .3);
    });
    return points;
}

test('plate tracker follows known 2D translation and rejects blank images', () => {
    const template = makeTemplate(plateFrame(80, 90), 180, 220, 80, 90, 25);
    let previous = { x: 80, y: 90 };
    for (const [x, y] of [[83, 100], [86, 110], [88, 102], [90, 90]]) {
        const p = trackPlate(plateFrame(x, y), 180, 220, template, previous, 18);
        assert(Math.abs(p.x - x) <= 1 && Math.abs(p.y - y) <= 1);
        assert(p.score > .95); previous = p;
    }
    assert(trackPlate(new Uint8Array(180 * 220), 180, 220, template, previous, 18).score < .72);
    assert.throws(() => makeTemplate(new Uint8Array(180 * 220), 180, 220, 80, 90, 25), /too little/);
    assert.throws(() => makeTemplate(plateFrame(80, 90), 180, 220, 5, 5, 25), /whole plate/);
});

test('complete presses recover known travel, velocity, and slowdown', () => {
    const result = summarizeTrack(trajectory(), .003);
    assert.equal(result.reps.length, 3);
    assert(Math.abs(result.reps[0].distance - .3) < .005);
    assert(Math.abs(result.reps[0].velocity - .3) < .02);
    assert(Math.abs(result.lastVelocity - .2) < .02);
    assert(Math.abs(result.velocityLoss - 33.3) < 3);
});

test('partial final press and stationary footage do not become complete reps', () => {
    assert.equal(summarizeTrack(trajectory([1, 1.25], true), .003).reps.length, 1);
    assert.throws(() => summarizeTrack(Array.from({ length: 100 }, (_, i) => ({ x: 90, y: 90, t: i / 20, score: 1 })), .003), /No complete/);
});

const samples = [.5, .45, .4, .35, .3, .375].map((v, i) => ({ version: 1, id: String(i), exercise: 'Bench Press', style: 'paused', day: `2026-10-${20 + i % 3}`, load: 100, reps: 5, lastVelocity: v, rpe: 16 - 20 * v }));
const current = { id: 'new', exercise: 'Bench Press', style: 'paused', load: 100, reps: 5, lastVelocity: .4 };
test('personal model requires distinct days and samples and never extrapolates', () => {
    assert.equal(estimateRpe(current, []).available, false);
    assert.equal(estimateRpe(current, samples.map(s => ({ ...s, day: '2026-10-20' }))).available, false);
    assert.equal(estimateRpe(current, [...samples.slice(0, 3), ...samples.slice(0, 3)]).available, false);
    assert.equal(estimateRpe({ ...current, id: '0' }, samples).available, false);
    assert.equal(estimateRpe({ ...current, lastVelocity: .1 }, samples).available, false);
    assert.equal(estimateRpe({ ...current, style: 'touch-go' }, samples).available, false);
    assert.equal(estimateRpe({ ...current, exercise: 'Close Grip Bench Press' }, samples).available, false);
    assert.equal(estimateRpe({ ...current, load: 150 }, samples).available, false);
});
test('consistent personal data produces a broad estimate, inconsistent data is withheld', () => {
    const result = estimateRpe(current, samples);
    assert.equal(result.available, true);
    assert.equal(result.value, 8);
    assert.equal(result.low, 7); assert.equal(result.high, 9);
    assert.equal(estimateRpe(current, samples.map(s => ({ ...s, rpe: 16 - s.rpe }))).available, false);
});
