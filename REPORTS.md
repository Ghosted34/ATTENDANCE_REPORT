# Adding, changing and removing reports

Every report is **one file** in `server/reports/` plus **one line** in `server/reports/registry.js`.
The app builds the form, table, grouping, sorting, paging and Excel/CSV/PDF exports from that file.
You never need to touch the screens (`renderer/`) to add a report.

After any change: run `npm start` (desktop) or `npm run dev` (browser) to try it, then
`npm run dist` to build a new installer. Bump `"version"` in `package.json` first.

---

## 1. What a report file looks like

```js
// server/reports/my-report.js
import { query } from "../db/pool.js";

export default {
  id: "my-report",                 // used in the URL: #/reports/my-report. Lowercase, no spaces.
  title: "My report",              // shown on the home card and the report page
  description: "One sentence saying what it lists.",
  category: "Attendance",          // small label on the home card (optional)
  icon: "clock",                   // home card icon: calendar | user-x | clock | chart (optional)

  params: [ /* the form fields, see section 3 */ ],
  columns: [ /* the table columns, see section 4 */ ],
  groupBy: "department",           // optional: a column key, or a list like ["department", "status"]

  subtitle: (params) => "Text under the title, e.g. the date",
  normalize: (values) => values,   // optional: check/clean the form input, throw to refuse it
  run: async (params, { tz }) => [ /* rows: one object per row, keys = column keys */ ],
};
```

`run` is the only part that talks to the database. It gets the (normalized) form values and the
UTC offset `tz`, and returns an array of plain objects. **The order you return is the order
shown and exported.**

---

## 2. Add a report (worked example: late arrivals)

Goal: people whose first swipe of the day was after 08:30, for any date / range / month.

**Step 1: create `server/reports/late-arrivals.js`:**

```js
import { runPeriod } from "./lib/attendance-data.js";
import { normalizePeriod, periodParams, periodSubtitle, withPeriodColumns } from "./lib/period.js";

const LATE_AFTER = "08:30:00"; // 24-hour, compared with firstEntrySort

const COLUMNS = [
  { key: "name", label: "Name", minWidth: 150 },
  { key: "idNumber", label: "Employee ID", minWidth: 80 },
  { key: "department", label: "Department", minWidth: 120 },
  { key: "firstEntry", label: "First entry", minWidth: 80 },
];

export default {
  id: "late-arrivals",
  title: "Late arrivals",
  description: `Employees whose first swipe was after ${LATE_AFTER.slice(0, 5)}.`,
  category: "Exceptions",
  icon: "clock",
  params: periodParams,                                   // the same Single date / Date range / Month picker
  columns: COLUMNS,
  columnsFor: (params) => withPeriodColumns(COLUMNS, params), // adds Date/Day in front
  groupBy: "department",
  normalize: normalizePeriod,
  subtitle: (params) => periodSubtitle(params, "Late arrivals"),
  run: async (params, options) => {
    const { present } = await runPeriod(params, options);  // reuse the attendance rules
    return present.filter((row) => row.firstEntrySort > LATE_AFTER);
  },
};
```

**Step 2: register it in `server/reports/registry.js`:**

```js
import attendance from "./attendance.js";
import absentees from "./absentees.js";
import lateArrivals from "./late-arrivals.js";

export const reports = new Map([attendance, absentees, lateArrivals].map((r) => [r.id, r]));
```

**Step 3:** run the app. The new card appears on the home screen.

### A report with its own SQL

If the attendance rules don't fit, query the database yourself. **Always pass values as
parameters** (`@name`); never paste user input into the SQL text.

```js
import { query } from "../db/pool.js";

export default {
  id: "departments",
  title: "Staff per department",
  description: "How many active employees each department has.",
  icon: "chart",
  params: [],
  columns: [
    { key: "department", label: "Department" },
    { key: "staff", label: "Active staff", align: "right" },
  ],
  subtitle: () => "All active employees",
  run: async () => {
    const rows = await query(`
      SELECT ISNULL(Department, 'Unassigned') AS department, COUNT(*) AS staff
      FROM dbo.p_people
      WHERE TRY_CONVERT(int, IsActive) = 1
      GROUP BY Department
      ORDER BY department;`, {});
    return rows;
  },
};
```

`query(sql, { name: value })` binds each `@name` safely; the SQL type follows the JavaScript value
(a number is sent as a number, a string as text). It returns the rows as objects named after the
`AS` aliases in your SELECT.

---

## 3. Form fields (`params`)

Each entry is one input on the report page. Its value arrives in `run(params)` under `name`.

| Property | Meaning |
| --- | --- |
| `name` | key in `params` and in the URL |
| `label` | text above the input |
| `type` | `"date"`, `"month"`, `"text"`, `"number"`, `"select"` (with `options: [{ value, label }]`) or `"weekdays"` (the Sun–Sat picker; value `"1,3,5"`) |
| `default` | starting value (date fields default to today, month fields to this month) |
| `optional: true` | may be left empty |
| `placeholder`, `hint` | grey text inside / under the input |
| `mode` | only show this field for that period mode; several are space-separated, e.g. `"range month"` |

Most reports should simply use `params: periodParams` and `normalize: normalizePeriod` from
`lib/period.js`. That gives the Single date / Date range / Month picker, the Sun–Sat **Days**
picker, the Employee ID filter and validation. You then get `params.start` and `params.end`
(both `YYYY-MM-DD`, inclusive), `params.idNumber`, and `params.days` (picked weekdays, 0 = Sunday;
empty = every day). `runPeriod` already applies `days`; in your own SQL report, filter with
`onPickedDay(params.days)` from `lib/period.js`.

To add a field of your own next to the period fields: `params: [...periodParams, myField]`, and
in `normalize` return `{ ...normalizePeriod(values), myField: values.myField }`. Daily attendance
does this for its **Show** option.

To refuse bad input, throw an error with `status: 400` from `normalize`; the message is shown
to the user:

```js
throw Object.assign(new Error("Pick a valid date."), { status: 400 });
```

---

## 4. Columns (`columns` / `columnsFor`)

```js
{ key: "firstEntry", label: "First entry", align: "right", wrap: true, minWidth: 80 }
```

- `key` is the property read from each row object; `label` is the header text.
- `align: "right"` for numbers; `wrap: true` for long text; `minWidth` in pixels on screen.
- Screen and exports use the same list, in the same order.
- `columnsFor(params)` (optional) returns a different list depending on the form, e.g.
  `withPeriodColumns(COLUMNS, params)` adds **Date** (for ranges/months) and **Day** in front.
- A row value of `"—"` is the convention for "no value".
- Times are shown as `3:21:05 PM`. To sort a column by something other than what it shows, put
  the sortable value on the row as `<key>Sort` (the attendance rows carry `firstEntrySort:
  "15:21:05"`), and the table and exports order by that.
- A column called `status` with values `Present` / `Absent` is drawn as a coloured pill.

## 5. Grouping (`groupBy`)

`groupBy: "department"` makes a heading per department, e.g. `Ops (12)`.
`groupBy: ["department", "status"]` makes `Ops — Present (10)`, `Ops — Absent (2)`.
Rows with the same heading are gathered together, and headings appear in the order of their
first row, so return your rows sorted by the grouping columns. Leave `groupBy` out for one flat table.

---

## 6. Change a report

| To change… | Edit |
| --- | --- |
| title, description, home-card label/icon | that report's file (`title`, `description`, `category`, `icon`) |
| which columns show, their order or headers | `COLUMNS` in that report's file |
| what counts as a swipe / present (event codes) | `swipeTemplate` in `lib/attendance-data.js` (`EventCategory = 10001`, `'Access Granted'`) |
| who is on record (active + card) | `runPeriod` in `lib/attendance-data.js` (the `onRecord` line) |
| no absences on weekends, on/off | `WORKING_DAYS_ONLY` in `lib/period.js` |
| Present-only vs Present-and-absent default | the `SHOW` field's `default` in `attendance.js` |
| longest allowed range | `MAX_PERIOD_DAYS` in `lib/period.js` |
| row order | `sortRows` in `lib/attendance-data.js` (or your own report's `run`) |
| PDF page size/margins/footer | `server/reports/print-template.js` |

Attendance and Absentees share `lib/attendance-data.js`, so a rule change there applies to both
and they can never disagree.

## 7. Remove a report

1. Delete its line (import and list entry) from `server/reports/registry.js`.
2. Delete its file from `server/reports/`.

Links people saved to that report will just open the home screen.

## 8. Checklist before you build

- [ ] `id` is unique and has no spaces.
- [ ] Every column `key` exists on the row objects `run` returns.
- [ ] SQL uses `@parameters`, never string-pasted input.
- [ ] Tried it with `npm start` (or `npm run dev`), including Excel/CSV/PDF.
- [ ] `version` bumped in `package.json`, then `npm run dist`.
