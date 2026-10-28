# Reports Desk

Attendance reports for a SQL Server access-control database (`dbo.EventHistory` swipes and the
`dbo.p_people` staff list). It runs as a Windows desktop app (Electron) or as a local web server
you open in a browser. Both use the same reports and screens.

## Run it

Requirements: Node.js 20+, and a SQL Server with `dbo.EventHistory` and `dbo.p_people`.

```bash
npm install
```

| What | Command | Settings come from |
| --- | --- | --- |
| Desktop app | `npm start` | The app's setup window (**File → Database settings…**), saved encrypted per Windows user |
| Browser mode | `npm run serve` (or `npm run dev` to restart on changes), then open http://127.0.0.1:3000 | `.env` (copy `.env.example`) |
| Build the Windows installer | `npm run dist` (on Windows) | — creates `dist/Reports Desk Setup <version>.exe` |
| Diagnose the database | `npm run doctor` | `.env` |

`.env` needs one line, the full connection string (wrap it in double quotes if the password has a `#`):

```ini
DB_CONNECTION_STRING=Server=192.168.1.10,1433;Database=VIAC;User Id=reports;Password=…;TrustServerCertificate=True
TZ_OFFSET_HOURS=1
```

Sign-in is a placeholder for now: `admin` / `admin` (`server/auth.js`).

**Upgrading:** install the new `.exe` over the old one. Settings are kept, as long as `appId`
and `productName` in `electron-builder.json` stay the same. Bump `version` in `package.json` for
each build you send out.

## The rules the reports follow

- **Who is on record:** people with `dbo.p_people.IsActive = 1` **and** a card (the card on file in
  `p_people.CardNumber`, or the latest card seen on their swipes; a card of `0` is no card).
  Nobody else appears in any report, as present or absent.
- **Present** on a day = at least one event with `EventCategory = 10001` and
  `EventDescription = 'Access Granted'` that day (local time).
- **Swipes are read from both `dbo.EventHistory` and `dbo.Events`** (recent events may not have
  been archived yet), so any date, range or month is covered whichever table holds it. An event
  found in both tables is counted once. A table missing any of `PeopleID`, `CardNumber`,
  `EventCategory`, `EventDescription`, `EventUTCTime` is skipped; `npm run doctor` says which
  tables were used.
- **Absent** = on record, a working day, and no such swipe that day.
- **Working days are Monday to Friday.** Nobody is marked Absent on a Saturday or Sunday, though a
  weekend swipe still shows as Present. Switch: `WORKING_DAYS_ONLY` in `server/reports/lib/period.js`.
- **Future days are never reported.** Today is included, so today's absences are provisional.
- Times are stored in UTC and shifted by `TZ_OFFSET_HOURS` (1 for Nigeria).
- A period is a single date, a date range (max 366 days) or a month. For a range or month, the
  **Days** picker (Sun–Sat, Mon–Fri on by default) limits the report to the picked weekdays;
  none picked means every day.

The two reports:

- **Daily attendance:** who came in (first/last entry, duration, swipes), grouped per department.
  **Show → Present and absent** adds the Absent rows too.
- **Absentees:** only the Absent rows, grouped per department.

Excel, CSV and PDF exports always contain the full report in the order shown on screen.

**Big periods:** the server keeps a finished run for 10 minutes and sends the screen one page at
a time (50 rows by default), so a two-month report is as light on screen as a single day. Paging,
sorting and grouping re-use that run; **Run report** always reads the database again.

## Where things are

```
main/                 Electron: windows, menu, settings store, PDF printing
server/
  app.js              HTTP API: /api/reports, /api/reports/<id>/{data,xlsx,csv,pdf}
  auth.js             sign-in (placeholder)
  db/pool.js          SQL Server connection
  doctor.js           `npm run doctor`
  reports/
    registry.js       the list of reports shown in the app   <- add/remove reports here
    attendance.js     Daily attendance report definition
    absentees.js      Absentees report definition
    lib/period.js     the shared "Report for" date picker, validation, Date/Day columns, subtitle
    lib/dates.js      calendar helpers (weekday, working days, months)
    lib/attendance-data.js  the swipe + staff SQL and the Present/Absent rules
    export.js, pdf.js, print-template.js   Excel/CSV/PDF output (shared by all reports)
renderer/app/         the screens (index.html, js/app.js, js/template.js, css/styles.css)
```

To add, change or remove a report, see **[REPORTS.md](REPORTS.md)**.

## When a report fails or looks wrong

Run `npm run doctor` against the same database (it only reads). It prints the column types, any
unreadable dates, a 7-day dry run with present/absent counts, and the most common event types,
which shows whether swipes really are recorded as `10001` / `Access Granted`. If it reports
`FAIL Present`, nobody matched that rule, and the filter in `lib/attendance-data.js` needs the
codes your database uses.
