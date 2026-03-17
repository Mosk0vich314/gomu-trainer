# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Gomu Trainer** is a password-protected PWA for personal powerlifting/strength program tracking. It is a fully static app (no backend, no Node.js/npm) that runs on GitHub Pages. The database is AES-256-GCM encrypted at build time and decrypted client-side with a coach password.

## Commands

### Deploy
```bash
python tools/deploy.py "optional commit message"
```
Encrypts the database, bumps the version in `index.html`, `scripts/app.js`, and `sw.js`, commits, and pushes to GitHub. Always run this instead of manually committing.

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

### Inject a program into the HTML
```bash
python tools/inject_db.py <PROGRAM_NAME>
```

### Create a sanitized (no data) copy
```bash
python tools/strip_db.py
```
Outputs `clean_app.html` with all plaintext database content removed.

## Architecture

The entire app lives in two files:
- **`index.html`** — All HTML structure. Contains workout program data injected as JSON comments between `/* PROGRAM_NAME_START */` / `/* PROGRAM_NAME_END */` markers.
- **`scripts/app.js`** — All application logic (~5500 lines). No build step, no bundler.

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
- `completedDays` — `{ [workoutKey]: true }` — heatmap/streak source
- `warmupRoutine` — `[{ text: string }, ...]` — editable warmup list
- `bwHistory` — `[{ d: dateStr, w: kg, ts: timestamp }, ...]` — bodyweight history (one entry per day)
- `preferredUnit` — `'kg'` or `'lbs'`
- `workoutHistory` — legacy; primary store is IndexedDB

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

## Key helpers (app.js)

- `safeParse(key, fallback)` — localStorage get with JSON parse + fallback
- `localDateKey()` — timezone-safe YYYY-MM-DD string for today
- `getUnit()` / `unitSuffix()` / `kgDisp(kg, dec)` — unit conversion (kg ↔ lbs)
- `fmtDuration(ms)` — formats milliseconds to `"1h 23m"` or `"45m"`
- `fmtShortDate(ts)` — formats timestamp to `"Mar 17, '26"`
- `dotsLevel(score)` — returns `{ label, color }` for DOTS strength classification

## UI patterns

### Swipe-to-delete
Three separate implementations for different card types — all follow the same pattern: `.swipe-wrapper` (red bg) + `.swipable-element` (the card) + `.swipe-delete-bg` (trash icon). Implementations:
- Exercise blocks: `setupSwipeToDelete()` → `.exercise-container.swipable`
- Stats PR rows: `setupStatsSwipe()` → `.stat-swipable`
- History cards: `setupHistorySwipe()` → `.hist-swipable` (wraps `<details>` element; blocks details toggle on swipe via `el.dataset.swipeMoved`)

### PR system
PRs are tracked when a set's e1RM exceeds the stored best. On PR:
1. `actualBests[exName]` is updated with `{ weight, reps, e1rm, date }`
2. Entry is appended to `prHistory[exName]` array (capped at 30)

PR timeline is toggled by clicking the exercise card (`window.togglePRTimeline`). Individual PR entries can be deleted via `window.deletePREntry(exName, date)` — if the deleted entry was the current best, `actualBests` is recalculated from remaining history.

### Charts
`drawChart(exName)` in `history-screen`: groups e1RM data by day (`localDateKey`), takes last 7 data points, renders SVG with gradient fill + animated draw (`stroke-dashoffset`). Empty state shows an SVG icon + italic message.

### Stats screen sections (in order)
1. Lifter Profile — DOTS trophy card (score + level), bodyweight trend mini-chart, BW input
2. Manual 1RM overrides — swipable rows
3. All-Time Heaviest Lifts — SBD 3-card row (clickable, expands PR timeline) + non-SBD swipable rows (clickable, expand PR timeline)
4. Physique Tracking — privacy-gated photo gallery

## Key conventions
- Version format: `YYYY.MM.DD.HHMM` — generated automatically by `deploy.py`.
- All programs live in `Programs/` and are listed in `Programs/manifest.json`.
- `scripts/app.js` is not minified or bundled — edit it directly.
- There are no tests and no linter configured.
- Fonts: **DM Sans** (body), **Space Grotesk** (display numbers, headings). Both loaded from Google Fonts.
- Z-index layers: nav bar `1500`, data sheet overlay `1600`, data sheet `1601`, modals above that.
