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
- **`index.html`** — All HTML structure (~38 KB). Contains workout program data injected as JSON comments between `/* PROGRAM_NAME_START */` / `/* PROGRAM_NAME_END */` markers.
- **`scripts/app.js`** — All application logic (~285 KB, ~5000 lines). No build step, no bundler.

**`styles/styles.css`** — Dark-theme CSS using CSS variables (`--accent`, `--bg-main`, `--text-main`, etc.).

**`sw.js`** — Service worker for offline/PWA support. Cache name is version-stamped; update the version constant when deploying.

### Storage layers
| Layer | What's stored |
|---|---|
| `sessionStorage` | Decrypted database key during session |
| `localStorage` | UI state, settings, preferences |
| `IndexedDB` (`GomuTrainerDB`) | Workout history (primary persistent store) |
| `scripts/database.enc` | Encrypted workout programs + exercise library |

### Security model
- `scripts/database.js` (plaintext) is gitignored — never commit it.
- `password.txt` is gitignored — never commit it.
- Decryption uses Web Crypto API (PBKDF2 → AES-GCM) entirely client-side.
- `tools/encrypt_db.py` must be run before any deploy to keep `database.enc` current.

### App screens (by DOM ID)
`login-screen` → `home-screen` → `library-screen` → `workout-screen` → `summary-screen` → `history-screen` → `stats-screen`

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

## Key conventions
- Version format: `YYYY.MM.DD.HHMM` — generated automatically by `deploy.py`.
- All programs live in `Programs/` and are listed in `Programs/manifest.json`.
- `scripts/app.js` is not minified or bundled — edit it directly.
- There are no tests and no linter configured.
