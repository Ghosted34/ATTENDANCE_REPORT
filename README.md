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

The installer is an NSIS, per-user, x64 build of **Reports Desk** (`com.reportsdesk.app`), configured in `electron-builder.json`. The build must run on Windows (or a Windows-capable CI runner); the configuration itself is checked by `npm test`.

### Upgrading an installed copy

Install the new build **over the existing installation**; no uninstall is needed. This keeps the same settings:

- **Same identity.** The app ID (`com.reportsdesk.app`) and product name (`Reports Desk`) do not change. electron-builder derives the installer's uninstall entry from the app ID, so the new build replaces the old one in place. Changing either value would install a second copy and point at a different settings folder.
- **Settings are not touched.** Desktop settings live in Electron's per-user `userData` folder for the product (on Windows, `%APPDATA%\Reports Desk\config.json`). The installer does not remove it on upgrade or uninstall: `nsis.deleteAppDataOnUninstall` is `false`.
- **Each PC and Windows user has its own settings.** The connection string is encrypted with `safeStorage`, which is tied to the Windows user on that PC, so it cannot be read elsewhere. Do not copy `config.json` between PCs or users; on a new PC or for a new user, the first launch asks for the connection string again.
- **Dev runs use a different folder.** `npm start` runs unpackaged, so Electron names its `userData` folder from `package.json`'s `name` (`reports-desk`), not from the product name. Settings saved while developing are therefore separate from the installed app's.

## Running the daily attendance report

The report form has a **Report for** choice:

- **Single date** (default) — pick one day. The subtitle names its weekday, for example `Attendance for 2026-10-05 (Monday)`.
- **Date range** — pick a **Start date** and an **End date** (both included). Results get a leading **Date** column and one row per person per local calendar day, so the same person's days are never merged.
- **Month** — pick a calendar month (`YYYY-MM`). It covers the first to the last day of that month, with the same Date column as a range.

Every period shows the same columns: **Day** (the weekday of the row's local date, for example `Monday`), **Name**, **Employee ID**, **Department**, **Status** (`Present` or `Absent`), **Card no.**, **First entry**, **Last entry**, **Duration** and **Swipes**, grouped by department. A period covering more than one day adds **Date** in front of **Day**. Active employees who did not swipe on a day appear as `Absent` on that day (see **Absence** below), so the report lists everyone who should have been there, not only the people who swiped.

Rows run **by department, then by date**, so a department's days stay in order. Within one day, everyone who swiped (`Present`) is listed before that day's absentees (`Absent`), and each of those two blocks is alphabetical. The order is decided once, by the server, and every export follows it. **Department** is a column of its own as well as the section heading, so a row still says where its person works when the table is read out of context or sorted in a spreadsheet.

**Employee ID** (optional) limits a run to one person. It matches `dbo.EventHistory.PeopleID` (and `dbo.p_people.PeopleID`) exactly; leave it blank for everyone. The field keeps its database meaning; only the label on screen, in exports and here changed.

Every period uses the same parameterized SQL, the same `TZ_OFFSET_HOURS` shift and the same one-row-per-person-per-local-day grouping; a single date is a one-day range and a month is a range from its first to its last day. Invalid dates (for example `2026-02-31`), an invalid month (for example `2026-13`), ranges whose start is after the end, ranges longer than **366 days**, and Employee IDs containing anything but letters, digits, dashes or underscores are refused in the browser and by the API with HTTP `400`, so exports cannot be produced from bad input either. SQL Server date-shape errors (`241`, `242` or `9810`) point at `npm run doctor`, which explains the relevant column or rows — see **If a report fails with a SQL Server date-shape error**.

### Absentee report

The **Absentees** report is a separate entry on the report list. It takes the same **Report for** choices (single date, date range or month), the same optional Employee ID filter and the same absence rule, but returns only the `Absent` rows: **Name**, **Employee ID** and **Department**, with **Day** on every period and **Date** as well for a range or month. Rows run by department and date, exactly as they do on the attendance report. Because it shares the attendance report's code path — and its period columns — the two can never disagree about who is absent, or about which weekday a row falls on.

### Absence

- **Who can be absent:** only people whose `dbo.p_people.IsActive` is `1`. `0` (inactive, or not yet employed) is never marked absent, and neither is a `NULL` or unreadable value, so an unknown status is never reported as an absence. There is no hire-date rule: a person who has not started yet must have `IsActive = 0` until they do.
- **What counts as absent:** an eligible person with **no granted access swipe on that local day**. Denied or non-access events do not count as presence. Each person is reported once per day as either `Present` or `Absent`, never both.
- **Ranges and months:** absence is per person per day, so a 31-day month can give one row per absent day. The grain is a deliberate choice that keeps partial absences visible.
- **Weekends** count as absence days by default. To skip Saturdays and Sundays, set `ABSENCE_SKIP_WEEKENDS = true` in `server/reports/attendance.js`.
- **Future days are never reported.** Days after today (local date, from `TZ_OFFSET_HOURS`) are left out, so they cannot appear as absent. **Today is included**, so today's absences are provisional until the day has ended: someone who has not swiped yet this morning shows as `Absent` until they do.
- If the eligibility lookup fails, the report fails with an error. It never falls back to showing nobody as absent.

The toolbar's query string is the whole API contract, and both browser and Electron mode use it:

| Parameter | Used by | Description |
| --- | --- | --- |
| `mode` | Both | `single` (default when omitted), `range` or `month` |
| `date` | `mode=single` | Local day as `YYYY-MM-DD` |
| `start`, `end` | `mode=range` | Local first and last day as `YYYY-MM-DD` (inclusive, at most 366 days) |
| `month` | `mode=month` | Calendar month as `YYYY-MM` |
| `idNumber` | Both | Optional Employee ID (`PeopleID`) filter; the query parameter keeps its original name |

The absentee report uses the same parameters at `/api/reports/absentees/{data,xlsx,csv,pdf}`.

The **Excel**, **CSV** and **PDF** buttons export whatever the form currently holds, so the filters always match the screen. Exports carry exactly the same columns, in the same order, as the screen — **Date**, **Day**, **Name**, **Employee ID**, **Department**, **Status** and the rest — so a sheet cannot drift from the table it was printed from. They are named for the window they cover:

| Mode | Attendance (Excel, CSV, PDF) | Absentees |
| --- | --- | --- |
| Single date | `attendance-2026-10-05.*` | `absentees-2026-10-05.*` |
| Date range | `attendance-2026-10-04_to_2026-10-06.*` | `absentees-2026-10-04_to_2026-10-06.*` |
| Month | `attendance-2026-10.*` | `absentees-2026-10.*` |

## Report template

Every report is one definition in `server/reports/`, rendered through a shared template in `renderer/app/js/template.js` and, for exports, `server/reports/export.js` plus `server/reports/print-template.js`.

**Inputs.** A report declares its own fields (`params`), and the template renders them for it:

- **Fixed inputs** — anything the report lists, with `type` `date`, `text` or `number`, or an `options` list. They are always rendered and always submitted; `default`, `optional`, `placeholder` and `hint` shape them.
- **Defaults** — a field's own `default` wins; date fields otherwise start on today, and `mode`-tagged fields are hidden and disabled until that mode is selected.
- **Dynamic (extra) inputs** — any *other* key in the page URL is passed straight through to the report on every run and export. That is how a URL such as `?mode=range&start=2026-08-16&end=2026-08-19&plant=Lagos` presets the window *and* keeps `plant=Lagos` travelling to the API, so a report can pick up parameters it needs beyond the visible fields. Extra keys are bounded as SQL parameters like every other value; nothing from the URL is ever concatenated into a statement.

**Presentation.** `groupBy` (default `department`) turns rows into sections with a heading and a count; `columns` — or `columnsFor(params)` for mode-dependent tables — are rendered in order, with `align: "right"` and `wrap: true` honoured by the screen, the CSV and the printable template. The attendance and absentee reports use one list for both halves (`exportColumnsFor(params)` returns `columnsFor(params)`); a report that needs a printed column the table *hides* can still return a different list from `exportColumnsFor(params)`.

**Ordering.** A report returns its rows in the order they are shown and exported; the page never re-sorts them. The attendance reports order by department (their `groupBy` column), then by date, then by `Present` before `Absent`, then by name.

**API.** `GET /api/reports/<id>/data` returns `{ rows, subtitle, columns }`, `GET /api/reports/<id>/{xlsx,csv,pdf}` return the files. Both share one validated run, so the screen and the exports can never disagree.

## PDF and print template

`server/reports/print-template.js` holds the one page setup both PDF renderers use: **A4 landscape**, matching margins, and a footer with the report title, its window, the brand and *Page x of y*.

- Electron renders `toHtml(...)` through Chromium's `printToPDF` with `printOptions(...)` from that module, so the footer and margins come from the template rather than from defaults.
- The standalone server draws the same table with PDFKit (`server/reports/pdf.js`), with the same columns, group headings and subtitle.
- `toHtml(...)` carries the same page setup as a CSS `@page` rule, so printing the HTML by hand looks the same too.

### Why a big report is printed from a file

Electron used to hand the report to Chromium as a `data:text/html;charset=utf-8,…` URL. Chromium caps URLs at about **2 MB**, and a report is bigger than that well before a month is up: at roughly **5,000 rows** the encoded URL is already over 2 MB, and August 2026 with absentees (**18,517 rows**) encodes to about **8.6 MB**. Chromium then refuses to navigate with `ERR_INVALID_URL (-300)` and the PDF button fails without printing a page.

`main/print-report.js` now writes the same HTML into a temporary file (its own `reports-desk-print-*` folder under Electron's temp directory) and loads it with `loadFile`, so a report's size is no longer part of a URL. The folder is deleted as soon as the PDF has been rendered, and on the failure path too, so a failed print leaves nothing behind. Page setup and footer are still `printOptions(...)` from the template. The module takes `loadFile` and `printToPDF` as arguments, which is what lets `npm test` cover the whole path — including an 18,517-row report — without Electron, a browser or a database.

**Manual check** (the Electron runtime is not part of the test suite, so the desktop half is verified by hand on a machine that can run `npm start`):

1. Start the desktop app against a database you can print from, and run a period big enough to have failed before — a **Month** with absentees, or a date range of a few thousand rows.
2. Press **PDF**. The save dialog opens and the file is written; no error dialog, and nothing about `ERR_INVALID_URL` or `-300` in the log.
3. Open the PDF: every row is there (the total in the header matches the `Total` line on screen), the footer shows the report title, its window, the brand and *Page x of y*, and the pages are A4 landscape.
4. Repeat with a single date, to confirm the small reports still print.
5. Confirm no `reports-desk-print-*` folder is left in the temp directory (`%TEMP%` on Windows, `$TMPDIR` elsewhere) after printing, and none after deliberately failing a print (for example by cancelling the save dialog).

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
- `dbo.p_people`: `PeopleID`, `Firstname`, `Lastname`, `Department`, `IsActive` (1 = active; only active people can be absent)

It filters for granted access events and groups results by person **and local calendar day**. Absences come from a second, read-only query over the active roster (`TRY_CONVERT(int, pp.IsActive) = 1`), compared with the swipes in application code; see **Absence** above. Event times are stored in UTC and shifted by `TZ_OFFSET_HOURS`; the queried UTC window runs from local midnight of the first selected day to local midnight after the last one. Every row carries its local date and that date's weekday for the UI and the exports; the weekday is read from the calendar date alone, so the machine's clock and time zone cannot move it. The optional Employee ID filter compares `PeopleID` as text, so it works whether that column is numeric or a GUID.

`EventUTCTime` may be a real date/time column (`date`, `datetime`, `smalldatetime`, `datetime2`) or a legacy character column. The report reads its declared type from the catalog once per run and uses the matching statement: the plain column for time-bearing date/time types, so the index on it stays usable, or `TRY_CONVERT(datetime2(3), eh.EventUTCTime)`, which skips rows whose text cannot be parsed instead of failing the whole report. A date-only column also uses the datetime2-safe path so hour shifts are legal, but it contains no time-of-day: every stored entry time is midnight, so the report shows duration and last-entry fields as `—`. An unknown or unreadable type falls back to the text-safe statement.

The SQL is parameterized (`@startYmd`, `@endYmd`, `@tz`, `@idNumber`): no user input, including extra query-string parameters, is ever concatenated into a statement. The requested window dates travel as **integers** (`20261005`) and are rebuilt inside SQL with `DATETIMEFROMPARTS` for the datetime-column window or `DATETIME2FROMPARTS` for the text-safe window. These functions produce types that carry time before `DATEADD(HOUR, ...)`, so SQL Server never parses a request date string and `SET LANGUAGE`/`SET DATEFORMAT` cannot affect the window. Legacy text values are independently read with `TRY_CONVERT(datetime2(3), ...)`, which safely skips rows that cannot be parsed; the category and card filters use `TRY_CONVERT`/trimmed text compares.

## If a report fails with a SQL Server date-shape error (241, 242 or 9810)

```bash
npm run doctor
```

`server/doctor.js` is a read-only diagnosis for these errors. It prints the connection string with the password masked, the column types the database *actually* has for every column the report reads, the time column's range and a few samples, the rows whose text cannot be read as a date/time (with examples and counts), and a dry run of the report over the last 7 whole local days through the normal code path. It also warns when `EventUTCTime` is only a `date`, since that schema has no time-of-day and cannot produce real durations. Exits non-zero when something is wrong; each line says which check failed.

It sends nothing but `SELECT`s, looks up only the columns listed under **Database expectations** (they are matched against the catalog, never interpolated), and never prints the password. It reads `.env` like the local server does; Electron keeps its settings in its own encrypted store, so run it from a terminal with a `.env` for the same database.

## Tests

```bash
npm test
```

Covers the shared connection-string configuration (`server/config.js`, `server/env.js`), the attendance report's validation (single date, range and month, inclusive boundaries, leap years, the 366-day cap), the integer window and statement selection (including the text-safe and date-only paths), the Employee ID labels, the Date/Day/Department/Status columns and their alignment in every export, the weekday of every row and of a single-date subtitle, the row order (department, date, Present before Absent), absence (active roster only, one row per person per day, the future-day cut-off and the weekend setting), the absentee-only report, the Excel/CSV/HTML/PDF exports and the print template, the desktop PDF path (an 18,517-row report is printed from a temporary file, never a `data:` URL, and the file is deleted afterwards), the renderer's report template (URL presets, month fields, file names), the doctor's checks, its identifier allowlist and 241/242/9810 hint path, the installer configuration that keeps settings across an upgrade, plus the Express API's 400/401/403/404 behaviour. Nothing needs a database: every SQL call goes through an injected query function, and the print path takes its Chromium halves injected as well, so a plain `npm install` is enough. The Electron runtime is not downloaded by `npm install --ignore-scripts` and is not needed to run the suite; see **Manual check** for the one step that needs it.
