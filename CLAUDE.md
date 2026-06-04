# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Gomu Trainer** is a password-protected PWA for personal powerlifting/strength program tracking. It is a fully static app (no backend, no Node.js/npm) that runs on GitHub Pages. The database is AES-256-GCM encrypted at build time and decrypted client-side with a coach password.

## First-time setup on a fresh clone

`scripts/database.js` is gitignored. `scripts/database.enc` (the encrypted version) IS committed. To restore the plaintext database on a new machine:

1. Create `password.txt` in the project root with the vault password (gitignored, never commit).
2. Run the decryption inline:
```python
python -c "
import os, base64
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes
password = open('password.txt').read().strip()
blob = base64.b64decode(open('scripts/database.enc').read().strip())
salt, iv, ct = blob[:16], blob[16:28], blob[28:]
kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=100_000)
key = kdf.derive(password.encode())
plaintext = AESGCM(key).decrypt(iv, ct, None)
open('scripts/database.js', 'w', encoding='utf-8').write(plaintext.decode('utf-8'))
print('Decrypted', len(plaintext), 'bytes')
"
```

## Commands

### Deploy
```bash
python tools/deploy.py "optional commit message"
```
Encrypts the database, bumps the version in `index.html`, `scripts/app.js`, and `sw.js`, commits, and pushes to GitHub. **Always run this instead of manually committing.**

### Encrypt database only
```bash
python tools/encrypt_db.py
```
Encrypts `scripts/database.js` → `scripts/database.enc` using AES-256-GCM with the password from `password.txt`.

### Build a workout program from screenshots (AI OCR)
```bash
python tools/build_database.py <FOLDER_NAME>
```
Uses Gemini-2.5-Pro vision to OCR workout screenshots into a JSON program file. Requires `api_key.txt` with a Google Gemini API key.

### Inject a program into the database

**IMPORTANT — three-step process:**

**Step 1 — Inject JSON into `database.js`.**
The correct injection format is a named entry in the `window.db` object. Never inject raw JSON — it must be wrapped:
```js
"KEY": { name: "Display Name", weeks: /* KEY_START */
{...json...}
/* KEY_END */ }
```
Use this Python snippet to inject (replace existing content between markers if re-injecting):
```python
import re
content = open('scripts/database.js', 'r', encoding='utf-8').read()
new_json = open('Programs/KEY_database.json', 'r', encoding='utf-8').read().strip()
# If re-injecting existing key:
pattern = re.compile(r'(/\* KEY_START \*/)(.*?)(/\* KEY_END \*/)', re.DOTALL)
content = pattern.sub(r'\1\n' + new_json + r'\n\3', content)
# If adding a new key (append before closing };):
# Replace the last }; with the new entry + };
open('scripts/database.js', 'w', encoding='utf-8').write(content)
```

**Step 2 — Add program card to `index.html`.**
Library screen cards are **hardcoded** — NOT auto-generated from database keys. Find the correct folder `<details>` block and add:
```html
<div class="program-card" data-program-id="KEY" onclick="startProgram('KEY')">
  <h3 class="program-title">Display Name</h3>
  <p class="program-desc">Folder / Subtitle</p>
</div>
```

**Step 3 — Deploy.**

### Create a sanitized (no data) copy
```bash
python tools/strip_db.py
```
Outputs `clean_app.html` with all plaintext database content removed.

## Architecture

The entire app lives in two files:
- **`index.html`** — All HTML structure. Contains workout program data injected as JSON comments between `/* PROGRAM_NAME_START */` / `/* PROGRAM_NAME_END */` markers.
- **`scripts/app.js`** — All application logic (~5700 lines). No build step, no bundler.

**`styles/styles.css`** — Dark-theme CSS using CSS variables (`--accent` orange, `--teal`, `--bg`, `--card`, `--border`, `--text-main`, `--text-muted`, `--danger`).

**`sw.js`** — Service worker for offline/PWA support. Cache name is version-stamped; update the version constant when deploying.

### Storage layers
| Layer | What's stored |
|---|---|
| `sessionStorage` | Decrypted database key during session |
| `localStorage` | UI state, settings, preferences, PRs, warmup routine |
| `IndexedDB` (`GomuTrainerDB`) | Workout history (primary persistent store) |
| `scripts/database.enc` | Encrypted workout programs + exercise library |

### Key localStorage keys
- `actualBests` — `{ [exName]: { weight, reps, e1rm, date } }` — all-time heaviest lifts
- `prHistory` — `{ [exName]: [{ weight, reps, e1rm, date }, ...] }` — PR timeline (max 30 per exercise)
- `global1RMs` — manually overridden 1RMs
- `completedDays` — `{ [workoutKey]: true }` — heatmap/streak source. Key format: `${programId}_w${week}_d${day}`
- `warmupRoutine` — `[{ text: string }, ...]` — editable warmup list
- `bwHistory` — `[{ d: dateStr, w: kg, ts: timestamp }, ...]` — bodyweight history (one entry per day)
- `preferredUnit` — `'kg'` or `'lbs'`
- `workoutHistory` — legacy; primary store is IndexedDB
- `activeProgram` — currently active program ID
- `programSwaps_${programId}` — `{ [originalExName]: newName }` — program-level exercise swaps (see Program-level propagation)
- `programModes_${programId}` — `{ [originalExName]: modeObj }` — program-level Myo-rep / Drop Set conversions (see Program-level propagation)

### Security model
- `scripts/database.js` (plaintext) is gitignored — never commit it.
- `password.txt` is gitignored — never commit it.
- Decryption uses Web Crypto API (PBKDF2 → AES-GCM) entirely client-side.
- `tools/encrypt_db.py` must be run before any deploy to keep `database.enc` current.

### App screens (by DOM ID)
`login-screen` → `home-screen` → `library-screen` → `workout-screen` → `summary-screen` → `history-screen` → `stats-screen`

Screen transitions use `switchTab(tabId)` which applies directional slide animations (`TAB_ORDER` array controls left/right direction). **Do not use CSS `transform` on `.app-screen` animations** — it breaks `position: fixed` children (FAB timer button). Use `left` property instead.

### Workout program JSON format
```json
{
  "WEEK_NUM": {
    "DAY_NUM": [
      {
        "name": "Squat",
        "type": "main",
        "notes": "Coach cues",
        "blocks": [
          { "sets": 3, "reps": 5, "type": "top", "targetRpe": 8.0, "pct": 0.80 }
        ]
      }
    ]
  }
}
```

Block types: `"top"` (working/peak sets), `"backoff"` (lighter volume after peak), `"acc"` (accessory, `pct: null`). Both `targetRpe` and `pct` can coexist on the same block — `pct` acts as a reference/fallback.

**AMRAP is a per-SET property, not per-block.** Add `"amrap": true` to a block to mark its **last set** as AMRAP, or `"amrap": <n>` to mark a specific 1-based set index within the block (e.g. a `sets:2` block where only set 2 is AMRAP — see Compact Force W5 D4 Bench). The flagged set is always rendered at **RPE 10** with its reps input **empty** (placeholder `AMRAP`) for the lifter to log achieved reps. The RTS rep-based weight preload is skipped for that set (no known rep count) so its load falls back to `pct` → last-used. An AMRAP set logged without reps counts as 0 reps in the summary. If the whole block is a single AMRAP set (`sets:1`), the block header reads `1 x AMRAP @ … | RPE 10.0`; otherwise the header keeps its normal rep count and appends `· set N AMRAP`. Resolved via `amrapSetIndex(block)` (returns the 1-based AMRAP set index or null), used in both `renderWorkout` and the summary tally.

### Weight suggestion priority (buildSetRow)
Order: **RPE-first → pct fallback → last-used weight memory**
1. If `block.targetRpe` is set and a 1RM exists → use RTS table to calculate load
2. Else if `block.pct` is set and a 1RM exists → use `resolved1RM * block.pct`
3. Else → use `lastUsedWeights[ex.name]` from session memory

This was intentionally changed from pct-first to RPE-first to support Panash programs (Meta 5/3/1, etc.) which mix RPE and percentage prescriptions — RPE takes priority when available.

## Key helpers (app.js)

- `safeParse(key, fallback)` — localStorage get with JSON parse + fallback
- `localDateKey()` — timezone-safe YYYY-MM-DD string for today
- `getUnit()` / `unitSuffix()` / `kgDisp(kg, dec)` — unit conversion (kg ↔ lbs)
- `fmtDuration(ms)` — formats milliseconds to `"1h 23m"` or `"45m"`
- `fmtShortDate(ts)` — formats timestamp to `"Mar 17, '26"`
- `dotsLevel(score)` — returns `{ label, color }` for DOTS strength classification
- `showUndoToast(label, onCommit, onUndo)` — shows a 4-second dismissible toast; calls `onCommit` on timeout, `onUndo` if tapped. Used by all swipe-delete flows.

## UI patterns

### Swipe-to-delete
Four separate implementations for different card types — all follow the same pattern: `.swipe-wrapper` (red bg) + `.swipable-element` (the card) + `.swipe-delete-bg` (trash icon). Implementations:
- Exercise blocks: `setupSwipeToDelete()` → `.exercise-container.swipable`
- Stats PR rows (non-SBD): `setupStatsSwipe()` → `.stat-swipable` — calls `deleteTopPR(exName)`
- Stats SBD cards: also use `.stat-swipable` inside `.swipe-wrapper.sbd-swipe`
- History cards: `setupHistorySwipe()` → `.hist-swipable` (blocks details toggle on swipe via `el.dataset.swipeMoved`)

**All swipe deletes use `showUndoToast` — there are no `showConfirm` dialogs on swipe.** The underlying delete functions (`deleteTopPR`, `deleteCustomExercise`, `deleteSetFromBlock`, `deleteHistoryLog`) perform the deletion directly without any confirmation prompt.

**SBD swipe layout note:** SBD cards are in a flex row (`.pr-sbd-row`). Each card is wrapped in `.swipe-wrapper.sbd-swipe` which has `display: flex` so the inner `.pr-sbd-card` stretches to full height. Without `display: flex` on the wrapper the red background bleeds out at the bottom.

### Themes
Themes are defined in the `THEMES` array at the top of `app.js`. Each theme object:
```js
{ name: 'Name', accent: '#hex', teal: '#hex', bg: '#hex', card: '#hex', inputBg: '#hex', border: '#hex',
  textMain: '#hex',   // optional — overrides --text-main (default #f4f4f5)
  textMuted: '#hex'   // optional — overrides --text-muted (default #a1a1aa)
}
```
`applyTheme()` sets all 8 CSS variables. `textMain`/`textMuted` fall back to defaults if not specified.

**bg/card contrast principle:** `bg` should be near-black (perceivably black, <15 in all RGB channels) with a faint hue tint. `card` should be the first place the theme's color identity is visible. Never make `bg` and `card` too similar — the contrast step is what makes cards readable.

### PR system
PRs are tracked when a set's e1RM exceeds the stored best. On PR:
1. `actualBests[exName]` is updated with `{ weight, reps, e1rm, date }`
2. Entry is appended to `prHistory[exName]` array (capped at 30)

PR timeline is toggled by clicking the exercise card (`window.togglePRTimeline`). Individual PR entries can be deleted via `window.deletePREntry(exName, date)` — if the deleted entry was the current best, `actualBests` is recalculated from remaining history.

`window.deleteTopPR(exName)` — swipe action for both SBD and non-SBD cards. Deletes only the current best entry, falls back to next-best.

`rebuildPRHistoryFromWorkouts()` — called at the top of `renderStats()`. Scans `workoutHistoryCache` (oldest-first), recomputes e1RM for every logged set using the RTS table, and fills in `prHistory` for any exercise that is missing it. localStorage flag `prHistoryRTS_v2` gates a one-time wipe of old prHistory built with the wrong RTS table.

### RTS table
There is **one canonical RTS table** used throughout the app. The correct first row is:
`10: [1.000, 0.960, 0.920, 0.890, 0.860, 0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.690]`
Any deviation from this (e.g. `0.950, 0.925` in the RPE-10 row) is the **old wrong table** — do not use it. All six occurrences of the RTS table in app.js must match.

### Session journal
History entries have an optional `note` field (`string`). It is saved from a textarea on the summary screen via `window.saveSessionNote(val)` (debounced 600ms). Displayed as italic text in the history card summary row (`.history-note`). Stored in IndexedDB with the rest of the workout entry.

### Switch Program
`window.openSwitchProgramModal()` — opens a modal listing all non-custom programs except the current one. Shows whether the target week/day exists in the new program or where it will clamp.

`window.switchToProgram(id)` — switches `currentProgram`, carries over `selectedWeek`/`selectedDay` (clamped to valid range), and **backfills `completedDays`** for all days before the target position in the new program. This is required so the "next workout" pointer and progress bar land correctly after a switch.

### Program-level propagation (swaps + Myo/Drop modes)
Two transformations propagate across the **whole program**, keyed by an exercise's **DB-original name** (`ex._originalName`, tagged at the top of `getActiveExercises` before any rename). Because they key by name, the same exercise on the corresponding day of *every* week is affected — this is the propagation the user expects ("swap one, swap all").

- **`programSwaps_${programId}`** = `{ [originalName]: newName }`. Applied early in `getActiveExercises` (renames `ex.name`). Set by `submitSwapExercise()`.
- **`programModes_${programId}`** = `{ [originalName]: modeObj }`. Applied **last** in `getActiveExercises` (so it defines final block structure). For each matched exercise it calls `buildModeBlocks(ex, modeObj)` and sets `ex._mode = modeObj.type`.

Both are cleared together on program reset and on program completion (`allDone`).

`modeObj` shapes:
- Myo: `{ type:'myo', actReps, actSets, backSets, backReps }`
- Drop: `{ type:'dropset', actReps, actSets, drops, stripPct }`

`buildModeBlocks(ex, mode)` reads the **activation RPE/pct from the exercise's own prescribed block**, so each week keeps its own target (the structure is imposed, the intensity is not). Block types it emits: `'work'` (activation), `'backoff'` (Myo), `'drop'` (drop set). Drop blocks carry `dropNum` (1-based within its group), `dropPct` (per-step strip %, for the label), and `dropFactor` (cumulative `(1-strip)^i` off that group's activation load).

**Drop set structure:** one `'work'` activation block (1 set) **per activation**, each immediately followed by its own `drops` `'drop'` blocks — so every activation+drops group is independently checkable. Render detection is **block-type based** (`isDropActivation = type!=='drop'`, `isDropSet = type==='drop'`), *not* `bIndex===0`, precisely so multiple activation groups are detected.

**Setup flow:** `toggleMyoRep`/`toggleDropset` (chips in the `.eq-cycle-chip` row, accessory-only / `!isMain`) → modal (`myo-setup-modal` / `drop-setup-modal`) → `submitMyoRep`/`submitDropset` → `setProgramMode(originalName, modeObj)` (write store + `renderWorkout()`). Toggling an active mode off calls `setProgramMode(name, null)`. Legacy notes-based Myo (exercises created via "Add Exercise" with `notes='myo'`) is **not** in `programModes`; `toggleMyoRep` still tears those down the old way via `applyMyoChange`.

**Weight cascade (`toggleCheck`):** only an Activation set (`data-myotype="activation"`) triggers the cascade; it walks subsequent load inputs until the next activation. Myo back-offs receive the same load; `data-myotype="drop"` targets receive `activationLoad * dropFactor` (read from `data-dropfactor`). Checking a drop never cascades. Render-time defaults mirror this and `myoActivationLoad` is refreshed at **each** activation so multi-activation groups strip from their own base. Rest timer is hijacked to 20s when the next set is a back-off or drop.

### fireConfetti
Single unified `window.fireConfetti()` function. Always fires a body-burst (works during workout for PR detection). Also appends `.confetti-piece` elements to `.summary-card` if that element is present on screen.

### Charts
`drawChart(exName)` in `history-screen`: groups e1RM data by day (`localDateKey`), takes last 7 data points, renders SVG with gradient fill + animated draw (`stroke-dashoffset`). Empty state shows an SVG icon + italic message.

### Stats screen sections (in order)
1. Lifter Profile — DOTS trophy card (score + level), bodyweight trend mini-chart, BW input
2. Manual 1RM overrides — swipable rows
3. All-Time Heaviest Lifts — SBD 3-card row (swipable + clickable, expands PR timeline) + non-SBD swipable rows (clickable, expand PR timeline)
4. Physique Tracking — privacy-gated photo gallery

### Exercise type / color logic
`ex.type === 'main'` → orange (`--accent`). `ex.type === 'accessory'` or anything else → teal (`--teal`). **Always check `ex.type` first.** Do not infer type from the exercise name (e.g. "Single Leg RDL (deadlift)" is accessory despite containing the word "deadlift"). The name-based fallback is only a last resort when `ex.type` is absent, and should only match exact SBD names.

### Exercise card header layout
`.ex-title-container` has **symmetric** `padding: 16px 60px 10px 60px`. Left side has one absolutely-positioned button (swap icon). Right side has one absolutely-positioned button (warmup/fire icon). 60px clears both comfortably.

The MYO and DROP toggles are **not** in the header — they live below the title in the same row as the equipment mode chip (`.eq-cycle-chip`), accessory-only. This keeps the title centered regardless of accessory vs main lift. See Program-level propagation for how they work.

### Timer
Rest timer counts down to 0, beeps, then continues counting up (overtime). The display always shows absolute value — no minus sign — so `00:30` means either "30 seconds left" or "30 seconds overtime" depending on context. The `.finished` class on the banner signals overtime.

### Overflow / mobile layout rules
- All `position: fixed` banners/toasts that size to content must have `max-width: calc(100vw - Xpx)` and `box-sizing: border-box`.
- Text nodes inside flex items that could be long must have `min-width: 0` on the flex item and `overflow: hidden; text-overflow: ellipsis; white-space: nowrap` on the text element.
- SBD swipe wrappers need `display: flex` to prevent red background bleeding below shorter cards in the same flex row.

## Key conventions
- Version format: `YYYY.MM.DD.HHMM` — generated automatically by `deploy.py`.
- All programs live in `Programs/` and are listed in `Programs/programs-list.json`.
- `scripts/app.js` is not minified or bundled — edit it directly.
- There are no tests and no linter configured.
- Fonts: **DM Sans** (body), **Space Grotesk** (display numbers, headings). Both loaded from Google Fonts.
- Z-index layers: nav bar `1500`, data sheet overlay `1600`, data sheet `1601`, modals above that, undo toast `1601`.
