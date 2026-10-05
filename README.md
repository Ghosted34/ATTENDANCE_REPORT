# Reports Desk

Attendance Reports runs in two modes: a standalone local web server opened in your browser, or the Electron desktop app. **Their configuration is separate:** local browser mode reads `.env`; Electron always uses its JSON settings store.

## Requirements

- Node.js 20 or newer and npm
- Access to a SQL Server database containing `dbo.EventHistory` and `dbo.p_people`

## Local browser mode (separate from Electron)

From the repository root:

```bash
npm install
```

Copy the example environment file and edit it with your SQL Server connection details:

```bash
# macOS / Linux
cp .env.example .env

# Windows PowerShell
Copy-Item .env.example .env
```

Set `DB_HOST`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD` in `.env`. The defaults are SQL Server port `1433` and Nigeria's UTC offset `1`.

Start the local server with file watching:

```bash
npm run dev
```

Or start it once without a watcher:

```bash
npm run serve
```

Open **http://127.0.0.1:3000**. The server tests the database connection before it starts and binds to `127.0.0.1` only. Press **Ctrl+C** to stop it. `npm run dev` watches `server/`, `brand.json`, and `.env`; refresh the browser after renderer changes.

The local server uses the same reports and UI as Electron. Excel export is supported; local PDF export is rendered by PDFKit, while Electron continues to use Chromium's PDF renderer.

The current sign-in is a development placeholder: `admin` / `admin`. Do not expose the app or use that credential for a production deployment.

## Electron desktop mode

```bash
npm start
```

On first launch, enter the database settings in the desktop setup window. The app tests the connection before saving. Later, use **File → Database settings…** to update it. Electron saves settings as JSON under Electron's app-specific `userData` folder; the password is encrypted with Electron `safeStorage`.

**Electron does not read or write the local `.env` file**, whether run from source or installed. This keeps local development credentials separate from desktop settings.

Build the Windows installer with:

```bash
npm run dist
```

## Local environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DB_HOST` | Yes | — | SQL Server hostname or IP address |
| `DB_NAME` | Yes | — | Database containing the attendance tables |
| `DB_USER` | Yes | — | SQL Server login |
| `DB_PASSWORD` | Yes | — | SQL Server password |
| `DB_PORT` | No | `1433` | SQL Server port |
| `TZ_OFFSET_HOURS` | No | `1` | Local time offset from UTC, in whole hours |
| `PORT` | No | `3000` | Local web server port |

Shell environment variables override values from `.env`. Do not commit `.env`; it is git-ignored. The local server intentionally does not bind to other network interfaces because it has no Electron app token.

## Database expectations

The attendance report (`server/reports/attendance.js`) expects:

- `dbo.EventHistory`: `PeopleID`, `CardNumber`, `EventCategory`, `EventDescription`, `EventUTCTime`
- `dbo.p_people`: `PeopleID`, `Firstname`, `Lastname`, `Department`

It filters for granted access events and groups results by person for the selected local day. Event times are stored in UTC and shifted by `TZ_OFFSET_HOURS`.
