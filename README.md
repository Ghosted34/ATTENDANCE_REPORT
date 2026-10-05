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

Set `DB_CONNECTION_STRING` in `.env` to the full SQL Server connection string — it is the only database setting:

```ini
DB_CONNECTION_STRING=Server=192.168.1.10,1433;Database=VIAC;User Id=reports;Password=…;TrustServerCertificate=True
```

The app splits that string internally with the SQL Server driver: `Server`, `Database` and `User Id` are used for logs and messages, the port comes from the server value (default `1433`), and the password stays inside the string — it is never copied into a field of its own. `TZ_OFFSET_HOURS` defaults to Nigeria's `1`.

Quoting note: `.env` follows dotenv rules, so if the password contains `#`, wrap the whole value in double quotes, for example `DB_CONNECTION_STRING="Server=…;Password=pa#ss;…"`. Passwords containing `;`, `{`, `}` or `"` can be wrapped in `{braces}` exactly as ADO.NET expects.

Start the local server with file watching:

```bash
npm run dev
```

Or start it once without a watcher:

```bash
npm run serve
```

Open **http://127.0.0.1:3000**. The server tests the database connection before it starts and binds to `127.0.0.1` only. Press **Ctrl+C** to stop it. `npm run dev` watches `server/`, `brand.json`, and `.env`; refresh the browser after renderer changes.

The local server uses the same reports and UI as Electron. Excel, CSV and PDF exports are all supported; local PDF export is rendered by PDFKit, while Electron continues to use Chromium's PDF renderer with the same template (page setup, columns and footer).

The current sign-in is a development placeholder: `admin` / `admin`. Do not expose the app or use that credential for a production deployment.

## Electron desktop mode

```bash
npm start
```

On first launch, paste the database connection string into the desktop setup window and set the UTC offset. The app tests the connection before saving. Later, use **File → Database settings…** to update it: the saved string is shown with the password masked, and leaving the box empty keeps it.

Electron saves settings as JSON under Electron's app-specific `userData` folder. Because the connection string holds the password, it is stored as one `safeStorage`-encrypted value (`connectionStringEnc`) next to the readable UTC offset; the settings window never receives the decrypted string back. Desktop settings saved by earlier versions (separate host/port/user/database fields with an encrypted password) are read once and rewritten in the new format on the next save.

**Electron does not read or write the local `.env` file**, whether run from source or installed. This keeps local development credentials separate from desktop settings.

Build the Windows installer with:

```bash
npm run dist
```

## Running the daily attendance report

The report form has a **Report for** choice:

- **Single date** (default) — pick one day; the table shows Name, ID number, Card no., First entry, Last entry, Duration and Swipes, grouped by department.
- **Date range** — pick a **Start date** and an **End date**; results get a leading **Date** column and contain one row per person per local calendar day, so the same person's days are never merged into a single row.

**ID number** (optional) limits a run to one person. It matches `dbo.EventHistory.PeopleID` exactly; leave it blank for everyone.

Both modes use the same parameterized SQL, the same `TZ_OFFSET_HOURS` shift, and the same one-row-per-person-per-local-day grouping; a single date is simply a one-day range. Invalid dates (for example `2026-02-31`), ranges whose start is after the end, and ID numbers containing anything but letters, digits, dashes or underscores are refused in the browser and by the API with HTTP `400`, so exports cannot be produced from bad input either. A database-side date conversion failure (`SQL Server error 241`) points at `npm run doctor`, which explains which column or row is responsible — see **If a report fails with error 241**.

The toolbar's query string is the whole API contract, and both browser and Electron mode use it:

| Parameter | Used by | Description |
| --- | --- | --- |
| `mode` | Both | `single` (default when omitted) or `range` |
| `date` | `mode=single` | Local day as `YYYY-MM-DD` |
| `start`, `end` | `mode=range` | Local first and last day as `YYYY-MM-DD` |
| `idNumber` | Both | Optional `PeopleID` filter |

The **Excel**, **CSV** and **PDF** buttons export whatever the form currently holds, so the filters always match the screen. Exports repeat the grouping column (**Department**) per row, which keeps a filtered or sorted sheet readable, and are named for the window they cover:

| Mode | Excel | CSV | PDF |
| --- | --- | --- | --- |
| Single date | `attendance-2026-10-05.xlsx` | `attendance-2026-10-05.csv` | `attendance-2026-10-05.pdf` |
| Date range | `attendance-2026-10-04_to_2026-10-06.xlsx` | `attendance-2026-10-04_to_2026-10-06.csv` | `attendance-2026-10-04_to_2026-10-06.pdf` |

## Report template

Every report is one definition in `server/reports/`, rendered through a shared template in `renderer/app/js/template.js` and, for exports, `server/reports/export.js` plus `server/reports/print-template.js`.

**Inputs.** A report declares its own fields (`params`), and the template renders them for it:

- **Fixed inputs** — anything the report lists, with `type` `date`, `text` or `number`, or an `options` list. They are always rendered and always submitted; `default`, `optional`, `placeholder` and `hint` shape them.
- **Defaults** — a field's own `default` wins; date fields otherwise start on today, and `mode`-tagged fields are hidden and disabled until that mode is selected.
- **Dynamic (extra) inputs** — any *other* key in the page URL is passed straight through to the report on every run and export. That is how a URL such as `?mode=range&start=2026-08-16&end=2026-08-19&plant=Lagos` presets the window *and* keeps `plant=Lagos` travelling to the API, so a report can pick up parameters it needs beyond the visible fields. Extra keys are bounded as SQL parameters like every other value; nothing from the URL is ever concatenated into a statement.

**Presentation.** `groupBy` (default `department`) turns rows into sections with a heading and a count; `columns` — or `columnsFor(params)` for mode-dependent tables — are rendered in order, with `align: "right"` and `wrap: true` honoured by the screen, the CSV and the printable template. `exportColumnsFor(params)` lets exports carry a column the screen shows as a section heading instead (that is where Department comes from).

**API.** `GET /api/reports/<id>/data` returns `{ rows, subtitle, columns }`, `GET /api/reports/<id>/{xlsx,csv,pdf}` return the files. Both share one validated run, so the screen and the exports can never disagree.

## PDF and print template

`server/reports/print-template.js` holds the one page setup both PDF renderers use: **A4 landscape**, matching margins, and a footer with the report title, its window, the brand and *Page x of y*.

- Electron renders `toHtml(...)` through Chromium's `printToPDF` with `printOptions(...)` from that module, so the footer and margins come from the template rather than from defaults.
- The standalone server draws the same table with PDFKit (`server/reports/pdf.js`), with the same columns, group headings and subtitle.
- `toHtml(...)` carries the same page setup as a CSS `@page` rule, so printing the HTML by hand looks the same too.

## Local environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DB_CONNECTION_STRING` | Yes | — | Full SQL Server connection string (`Server`, `Database`, `User Id`, `Password`, optional port/`TrustServerCertificate`) |
| `DATABASE_URL` | No | — | Accepted as an alias when `DB_CONNECTION_STRING` is empty |
| `TZ_OFFSET_HOURS` | No | `1` | Local time offset from UTC, in whole hours |
| `PORT` | No | `3000` | Local web server port |

Shell environment variables override values from `.env`. Do not commit `.env`; it is git-ignored. The local server intentionally does not bind to other network interfaces because it has no Electron app token.

## Database expectations

The attendance report (`server/reports/attendance.js`) expects:

- `dbo.EventHistory`: `PeopleID`, `CardNumber`, `EventCategory`, `EventDescription`, `EventUTCTime`
- `dbo.p_people`: `PeopleID`, `Firstname`, `Lastname`, `Department`

It filters for granted access events and groups results by person **and local calendar day**. Event times are stored in UTC and shifted by `TZ_OFFSET_HOURS`; the queried UTC window runs from local midnight of the first selected day to local midnight after the last one. In range mode each row also carries its local date for the UI and the exports. The optional ID number filter compares `PeopleID` as text, so it works whether that column is numeric or a GUID.

`EventUTCTime` may be a real date/time column (`date`, `datetime`, `smalldatetime`, `datetime2`) or a legacy character column. The report reads its declared type from the catalog once per run and uses the matching statement: the plain column, so the index on it stays usable, or `TRY_CONVERT(datetime2(3), eh.EventUTCTime)`, which skips rows whose text cannot be parsed instead of failing the whole report. An unknown or unreadable type falls back to the text-safe statement.

The SQL is parameterized (`@startYmd`, `@endYmd`, `@tz`, `@idNumber`): no user input, including extra query-string parameters, is ever concatenated into a statement. The two dates travel as **integers** (`20261005`) and are rebuilt inside SQL with `DATEFROMPARTS`, and the category and card filters use `TRY_CONVERT`/trimmed text compares, so nothing in the run ever asks SQL Server to read a date from a character string — the source of error 241, and the part that `SET LANGUAGE`/`SET DATEFORMAT` could break.

## If a report fails with error 241

```bash
npm run doctor
```

`server/doctor.js` is a read-only diagnosis for exactly that case. It prints the connection string with the password masked, the column types the database *actually* has for every column the report reads, the time column's range and a few samples, the rows whose text cannot be read as a date/time (with examples and counts), and a dry run of the report over the last 7 whole local days through the normal code path. Exits non-zero when something is wrong; each line says which check failed.

It sends nothing but `SELECT`s, looks up only the columns listed under **Database expectations** (they are matched against the catalog, never interpolated), and never prints the password. It reads `.env` like the local server does; Electron keeps its settings in its own encrypted store, so run it from a terminal with a `.env` for the same database.

## Tests

```bash
npm test
```

Covers the shared connection-string configuration (`server/config.js`, `server/env.js`), the report's validation, its integer window and statement selection (including the text-safe fallback), columns, subtitles and rows, the Excel/CSV/HTML/PDF exports and the print template, the renderer's report template (URL presets, extra parameters, table and CSV rendering), the doctor's checks, its identifier allowlist and the 241 hint, plus the Express API's 400/401/403/404 behaviour. No external services are needed: every test runs against an injected query function, so a plain `npm install` is enough.
