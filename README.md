# Reports Desk

Attendance reports over a SQL Server door-access database. It runs **two ways**: as a plain web app in your browser for local development, and as a packaged Electron desktop app.

## What runs where

| Part | Path | Role |
| --- | --- | --- |
| Electron main process | `main/` | splash, settings window, app window, menus — desktop only |
| Express server + API | `server/` | serves the UI and the report API; runs inside Electron **or** standalone |
| Renderer | `renderer/app/` | plain HTML + vanilla JS, served by that Express server |

The renderer never touches SQL — it calls `/api/...` on the server, which is the same code in both phases.

---

## The two phases

| | **Phase 1 — local dev** | **Phase 2 — desktop app** |
| --- | --- | --- |
| Command | `npm run dev` | `npm start` (from source) or the installer |
| Runs in | your browser at `http://127.0.0.1:3000` | an Electron window |
| nodemon | yes — restarts the server | not used, not needed |
| Config source | `.env` | `config.json` in `<userData>` (or `.env` if run unpackaged) |
| API token | none — open, so it stays on loopback | random per-launch secret injected by Electron |
| PDF export | unavailable (501) — needs Electron's `printToPDF` | works |
| Settings UI | none — edit `.env` | File → Database settings… (Ctrl+,) |

---

## Phase 1 — local development in the browser

```bash
npm install
cp .env.example .env     # fill in DB_HOST, DB_NAME, DB_USER, DB_PASSWORD
npm run dev              # nodemon -> node server/start.js
```

Open **http://127.0.0.1:3000** and sign in with `admin` / `admin` (the mock login in `server/auth.js`).

- **nodemon watches `server/`, `brand.json` and `.env`** (see `nodemon.json`) and restarts on change. It does *not* watch `renderer/` — the browser reloads those, so just refresh.
- `npm run serve` starts the same server without watching.
- If SQL Server is unreachable at boot, the server prints the real error and exits; nodemon waits for you to fix `.env` rather than spinning.
- **Excel export works. PDF returns 501** — it is produced by Electron's `printToPDF`, which doesn't exist here. Test PDFs in Phase 2.
- The dev server has no API token, so keep `HOST` on `127.0.0.1` (the default). Setting `HOST=0.0.0.0` puts an unauthenticated window onto your database.

## Phase 2 — the desktop app

```bash
npm start        # run the desktop shell from source
npm run dist     # build a Windows NSIS x64 installer into dist/
```

- First launch: splash → **Database settings** → fill in Server / Port / Database / Username / Password / *Hours ahead of UTC* → **Test and save** (it runs `SELECT 1` first, and only saves if it connects).
- Later: **File → Database settings…** (Ctrl+,). Saving recycles the connection pool — no restart needed. The window tells you which file it will write to.
- **View → Toggle DevTools** is available when running unpackaged.
- `npm run dist` currently only defines a `win` target in `electron-builder.json`.

---

## Environment / configuration

| How you run it | Settings read from | Password stored as |
| --- | --- | --- |
| `npm run dev` / `npm run serve` | **`.env`** | plaintext — dev only, gitignored |
| `npm start` (unpackaged) | **`.env`** if present, else `config.json` | plaintext / `safeStorage`-encrypted |
| Installed app | **`<userData>/config.json`** | encrypted with Electron `safeStorage` |

```bash
cp .env.example .env
```

| Variable | Required | Default |
| --- | --- | --- |
| `DB_HOST` | yes | — |
| `DB_NAME` | yes | — |
| `DB_USER` | yes | — |
| `DB_PASSWORD` | yes (may be empty) | — |
| `DB_PORT` | no | `1433` |
| `TZ_OFFSET_HOURS` | no | `1` (Nigeria / WAT) |
| `PORT` | no | `3000` — dev server only |
| `HOST` | no | `127.0.0.1` — dev server only |

Rules, all in `server/env.js`:

- **Precedence: shell variables > `.env` > `config.json`.** `DB_HOST=10.0.0.5 npm run dev` retargets without editing anything.
- A **partial or invalid** `.env` (missing a required key, `DB_PORT=99999`, `TZ_OFFSET_HOURS=99`) is ignored with a warning in the terminal instead of being half-applied.
- `.env` is **never packaged** — the `files` allowlist in `electron-builder.json` ships only `main/`, `server/`, `renderer/` and `brand.json`. Dropping a `.env` next to the installed exe does nothing.
- The installed app writes `<userData>/config.json`: `%APPDATA%\reports-desk\config.json` on Windows, `~/Library/Application Support/reports-desk/config.json` on macOS, `~/.config/reports-desk/config.json` on Linux. To start over, delete it and relaunch.
- That file is per machine and per OS user, so copying it elsewhere won't decrypt — use the settings window there.

---

## What the database needs to look like

The attendance report (`server/reports/attendance.js`) expects:

- **`dbo.EventHistory`** — `PeopleID`, `CardNumber`, `EventCategory`, `EventDescription`, `EventUTCTime`
- **`dbo.p_people`** — `PeopleID`, `Firstname`, `Lastname`, `Department` (LEFT JOINed; people missing from it show as "Unknown" / "Unassigned")

Rows are filtered to `EventCategory = 10001 AND EventDescription = 'Access Granted' AND CardNumber IS NOT NULL AND CardNumber <> 0`, then grouped per person for the selected local day.

Also worth knowing:

- **Times are stored in UTC** and shifted by `TZ_OFFSET_HOURS`.
- The login needs **SELECT on those two tables**, nothing more.
- Connection options (`server/db/pool.js`): `trustServerCertificate: true`, 5 s connect timeout, 30 s query timeout, pool of 10.
- In the desktop app an unreachable database gives you an **Open settings / Quit** dialog instead of starting half-broken.

## Adding a report

Create `server/reports/<name>.js` with the same shape as `attendance.js` (`id`, `title`, `params`, `columns`, `run()`) and add it to the map in `server/reports/registry.js`. It appears in the UI automatically, in both phases.

## Gotchas

- **Electron needs a display.** On a headless Linux box, run `xvfb-run npm start`.
- **Only one desktop instance at a time** — a second launch just focuses the open window.
- `renderer/setup/setup.html` is the Electron settings window; it talks to the main process over a preload bridge, so it does nothing in the browser. In Phase 1, edit `.env` instead.
- Login is mocked (`admin` / `admin`) in both phases — see `server/auth.js`.
- If the Electron binary won't download (proxy, blocked GitHub releases): `npm config set electron_mirror https://npmmirror.com/mirrors/electron/`
