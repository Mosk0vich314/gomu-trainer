# Bench video prototype

Use **Analyze video** on a barbell bench exercise during a workout or its preview.
Pick the set, choose a local video, trim to one complete set, and mark the plate
centre and rim on the first frame. Enter the actual plate diameter and choose
paused or touch-and-go. Workout load and actual rep count must already be filled.

The camera must be stationary, with a clear view of the plate face. Trim out the
unrack/rerack and retain a short final lockout hold. Slow-motion exports, assisted
reps, and deliberate slow-tempo presses are unsupported. Clips may be up to
150 MB / 10 minutes, but the selected analysis interval is limited to 45 seconds.

## What it measures

- Browser decoding and canvas processing; no video leaves the device.
- A user-seeded, fixed normalized-correlation plate template, sampled at 20 Hz.
- Mean **vertical** concentric speed, vertical travel, press duration, and loss
  of speed from the fastest to the last press. These are approximate 2D measures.
- Tracking failure, inconsistent motion, or a rep-count mismatch blocks saving.
- The user must review the full overlay before saving. Correlation is not proof
  of correct tracking; a static/background feature can still fool the tracker.

This is an experimental engineering prototype. Automated tests use synthetic
trajectories and an encoded synthetic plate video. They do not establish accuracy
on gym footage or validate any RPE prediction. Real paired video/velocity data and
held-out lifter sessions are needed before making accuracy claims.

## Personal RPE suggestion

There is no universal speed-to-RPE lookup table. The prototype fits a negative
linear relationship between last-press speed and the user's own RPE ratings.
Only the same named exercise and pause style, loads within 20%, and rep counts
within two are compared. Minimum gates: six different clips, three training days,
and a two-point RPE spread. The current clip is excluded; file fingerprints prevent
repeated saves from multiplying calibration observations.

It withholds estimates outside the observed speed range, with the wrong slope,
or with leave-one-training-day-out mean absolute error above one RPE point. A
returned range is deliberately broad (at least ±1 before clipping to RPE 6–10).
It is a heuristic suggestion, **not** a validated confidence interval. The counts,
thresholds, and error checks are engineering choices, not research-proven limits.
Self-ratings are noisy labels and cannot establish true repetitions in reserve.

## Storage and integration

- Video object URLs are revoked on replacement/close; videos are never persisted.
- Reviewed metrics live at `${rowId}_video` in the workout session, then in
  `set.videoAnalysis` in IndexedDB history. Editing load/reps invalidates the
  associated live-session analysis; set reindexing carries its suffix normally.
- Optional self-ratings live in `videoRpeCalibration` (up to 100 distinct clips).
  The canonical backup preference path includes them. Session measurements and
  history already use the shared backup/merge paths. Factory reset removes them.
- Saving does not check off a set, change PRs, change loads, or fill RPE by default.
  The explicit checkbox can fill the user's entered rating in an unchecked set.
- The service worker precaches all three analysis assets. No new backend, npm
  installation, API key, or runtime CDN dependency is needed by the application.

## Verification

Run `node --test tools/review_video_core_test.mjs tools/review_workout_test.cjs`.
For real browser decoding and save/cancel/backup checks, run
`node tools/review_video_browser_test.cjs` with Playwright available on `NODE_PATH`
and Edge installed. `tools/review_technique_test.cjs` also checks offline loading.
