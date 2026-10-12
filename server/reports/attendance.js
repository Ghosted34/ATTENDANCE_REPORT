import { query } from "../db/pool.js";
import { classifyColumn, EVENT_COLUMNS, isDateShapeError, PEOPLE_COLUMNS, withDateShapeHint } from "../doctor.js";

/**
 * Times are stored in UTC. @tz shifts them to local time, and the UTC window is derived from
 * the local first/last day so an index on the time column is still usable; rows are grouped
 * per person *and* local calendar day, so a range never merges days.
 *
 * Error 241 ("The conversion of a varchar/nvarchar value to a datetime2 was out of range /
 * could not be parsed") is the reason this query looks the way it does:
 *
 *  1. The window never travels as a date *string*. The days are bound as integers
 *     (@startYmd/@endYmd, e.g. 20261005) and rebuilt inside SQL with a typed *FROMPARTS
 *     function, so no date format, no SET LANGUAGE/DATEFORMAT and no collation of the
 *     session can decide how a literal is read. The datetime column gets a DATETIME window;
 *     the text-safe expression gets a DATETIME2(3) window.
 *  2. EventHistory.EventUTCTime is a real date/time column on newer installs and legacy text
 *     on older ones. The type is read once per run from INFORMATION_SCHEMA.COLUMNS and only the
 *     matching statement is used; the text variant reads the column with TRY_CONVERT, which
 *     skips values it cannot parse instead of failing the whole report.
 *  3. The remaining filters never convert either: the event category is compared through
 *     TRY_CONVERT(int, …) and the Employee ID/card number as trimmed text.
 *
 *  4. Absence needs the people who are *not* in the swipe rows. A second, equally parameterized
 *     query reads the active roster (dbo.p_people.IsActive = 1). Absent rows are then produced
 *     in application code: one per eligible person per local day with no granted swipe, never
 *     for a day after today. That keeps the SQL to one day-grouping statement and one roster.
 *
 * Rows are ordered in application code, once, for the screen and the exports alike: by department
 * (the report's grouping column), then by date, and within a day the Present rows before the Absent
 * ones. Every row carries the weekday of its local date ("day"), which is also a column of every
 * period — a single date names its weekday in the subtitle instead, since it has no Date column.
 *
 * Every value still arrives as a bound parameter; nothing from the request is concatenated.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH = /^(\d{4})-(\d{2})$/;
const MODES = new Set(["single", "range", "month"]);
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

// The columns this report touches. The doctor checks the same allowlist, so what it prints is
// literally what a run reads; these names are constants, never input, and are only ever compared
// against catalog values.
export const REPORTED_COLUMNS = Object.freeze([...EVENT_COLUMNS, ...PEOPLE_COLUMNS]);

/** Whole-day local dates become integers (2026-10-05 -> 20261005) so SQL never parses a string. */
const toYmd = (isoDate) => Number(isoDate.replace(/-/g, ""));

/** True only for a real calendar date written as YYYY-MM-DD (rejects 2026-02-31). */
export function isIsoDate(value) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * "YYYY-MM" as the first and last day of that calendar month, or null. Month lengths come from
 * Date.UTC arithmetic (day 0 of the next month), so leap years are handled without any parsing
 * of a date string on the SQL side.
 */
export function monthBounds(value) {
  const match = ISO_MONTH.exec(typeof value === "string" ? value : "");
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 1900 || year > 9999 || month < 1 || month > 12) return null;
  const pad = (n) => String(n).padStart(2, "0");
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { year, month, start: `${year}-${pad(month)}-01`, end: `${year}-${pad(month)}-${pad(lastDay)}` };
}

/** Whole calendar days between two validated dates, inclusive of both ends. */
export function rangeDays(start, end) {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;
}

/**
 * Validates the API/UI parameters and resolves them to the local window the query needs.
 * "single" (the default) and "month" are expressed as a first..last day range so SQL has one
 * code path. The period is always inclusive of both ends.
 */
export function normalizeParams(values = {}) {
  const mode = String(values.mode ?? "").trim() || "single";
  if (!MODES.has(mode)) throw badRequest('Choose "Single date", "Date range" or "Month".');

  const idNumber = String(values.idNumber ?? "").trim();
  if (idNumber && !/^[A-Za-z0-9_-]{1,64}$/.test(idNumber)) {
    throw badRequest("Employee ID can only contain letters, digits, dashes and underscores.");
  }

  if (mode === "month") {
    const month = String(values.month ?? "").trim();
    const bounds = monthBounds(month);
    if (!bounds) throw badRequest("Pick a valid month (YYYY-MM).");
    return { mode, month, start: bounds.start, end: bounds.end, idNumber };
  }

  if (mode === "single") {
    const date = String(values.date ?? "").trim();
    if (!isIsoDate(date)) throw badRequest("Pick a valid date.");
    return { mode, date, start: date, end: date, idNumber };
  }

  const start = String(values.start ?? "").trim();
  const end = String(values.end ?? "").trim();
  if (!isIsoDate(start) || !isIsoDate(end)) throw badRequest("Pick a valid start date and end date.");
  if (start > end) throw badRequest("The start date must be on or before the end date.");
  if (rangeDays(start, end) > MAX_PERIOD_DAYS) throw badRequest(`A date range can cover at most ${MAX_PERIOD_DAYS} days.`);
  return { mode, start, end, idNumber };
}

/** Absence is counted on every calendar day unless this is switched on (Saturdays and Sundays skipped). */
export const ABSENCE_SKIP_WEEKENDS = false;

/** Longest range a single run may expand: one row per person per day is produced for absences. */
export const MAX_PERIOD_DAYS = 366;

/**
 * The period fields the attendance and absentee reports share. `mode` picks which one is used;
 * the template hides the others, and the server validates only the one that arrives.
 */
export const periodParams = Object.freeze([
  {
    name: "mode",
    label: "Report for",
    type: "select",
    default: "single",
    options: [
      { value: "single", label: "Single date" },
      { value: "range", label: "Date range" },
      { value: "month", label: "Month" },
    ],
  },
  { name: "date", label: "Date", type: "date", mode: "single" },
  { name: "start", label: "Start date", type: "date", mode: "range" },
  { name: "end", label: "End date", type: "date", mode: "range" },
  { name: "month", label: "Month", type: "month", mode: "month" },
  {
    name: "idNumber", label: "Employee ID", type: "text", optional: true, placeholder: "All",
    hint: "Leave blank for everyone.",
  },
]);

/** Date and range periods (and months) list one row per day, so they carry a Date column. */
const spansDays = (params = {}) =>
  params.mode ? params.mode !== "single" : Boolean(params.start && params.end && params.start !== params.end);

// Screen columns. Status makes absence explicit: "Present" when the person swiped that day,
// "Absent" when an active employee did not. Department is a column of its own as well as the
// section heading, so a row keeps saying where its person works however the table is read.
const COLUMNS = [
  { key: "name", label: "Name" },
  { key: "idNumber", label: "Employee ID" },
  { key: "department", label: "Department" },
  { key: "status", label: "Status" },
  { key: "cardNumber", label: "Card no." },
  { key: "firstEntry", label: "First entry" },
  { key: "lastEntry", label: "Last entry" },
  { key: "duration", label: "Duration" },
  { key: "accessCount", label: "Swipes", align: "right" },
];

const DATE_COLUMN = { key: "date", label: "Date" };
const DAY_COLUMN = { key: "day", label: "Day" };

/**
 * Every period leads with the weekday (**Day**, e.g. "Monday") and a period covering more than one
 * day adds **Date** in front of it, so the two halves of a row's date stay next to each other. A
 * single date has no Date column — its weekday is in the subtitle as well.
 */
export const periodColumnsFor = (columns, params = {}) =>
  (spansDays(params) ? [DATE_COLUMN, DAY_COLUMN, ...columns] : [DAY_COLUMN, ...columns]);

export const columnsFor = (params = {}) => periodColumnsFor(COLUMNS, params);

/**
 * Screen and exports use one column list: Department is on screen too, so there is nothing left to
 * insert into an exported sheet for it. Exports still read `exportColumnsFor` when a report has
 * one, which is what lets the printable template differ from the table.
 */
export const exportColumnsFor = (params = {}) => columnsFor(params);

/**
 * "Attendance for …" / "Absentees for …", naming the day, the range or the month and its length.
 * A single date has no Date column to read a weekday from, so the subtitle names it:
 * "Attendance for 2026-10-05 (Monday)".
 */
export function periodSubtitle(params = {}, label = "Attendance") {
  if (params.mode === "month") {
    const bounds = monthBounds(params.month);
    if (bounds) {
      const days = rangeDays(bounds.start, bounds.end);
      return `${label} for ${MONTH_NAMES[bounds.month - 1]} ${bounds.year} (${bounds.start} to ${bounds.end}, ${days} days)`;
    }
  }
  if (!spansDays(params)) {
    const date = params.date ?? params.start ?? "";
    return isIsoDate(date) ? `${label} for ${date} (${weekdayOf(date)})` : `${label} for ${date}`;
  }
  const days = rangeDays(params.start, params.end);
  return `${label} from ${params.start} to ${params.end} (${days} day${days === 1 ? "" : "s"})`;
}

export const subtitle = (params = {}) => periodSubtitle(params, "Attendance");

/**
 * The local day as 'YYYY-MM-DD' text. Grouping by *text* rather than by a formatted date keeps
 * the day boundaries independent of any style code or language setting.
 */
const localDayExpr = (timeExpr) =>
  `CONCAT(RIGHT('000' + CAST(YEAR(${timeExpr}) AS VARCHAR(4)), 4), '-', ` +
  `RIGHT('0' + CAST(MONTH(${timeExpr}) AS VARCHAR(2)), 2), '-', ` +
  `RIGHT('0' + CAST(DAY(${timeExpr}) AS VARCHAR(2)), 2))`;

/** Clock time as 'HH:MM:SS' text, built from parts so no CONVERT style is involved. */
const clockExpr = (timeExpr) =>
  `CONCAT(LEFT('0' + CAST(DATEPART(HOUR, ${timeExpr}) AS VARCHAR(2)), 2), ':', ` +
  `LEFT('0' + CAST(DATEPART(MINUTE, ${timeExpr}) AS VARCHAR(2)), 2), ':', ` +
  `LEFT('0' + CAST(DATEPART(SECOND, ${timeExpr}) AS VARCHAR(2)), 2))`;

/**
 * The one statement template, built from two expressions: `time` reads EventUTCTime in local
 * time (for the day and the clock columns) and `timeUtc` reads it in UTC. For time-bearing
 * columns, `timeUtc` is the raw column in the window predicate, so its index can still be used;
 * text and date-only columns use TRY_CONVERT(datetime2(3)) instead. `time` is the same value
 * shifted by the constant @tz.
 */
const ymdParts = (parameter) =>
  `${parameter} / 10000, ${parameter} % 10000 / 100, ${parameter} % 100`;

// These signatures and return types are from SQL Server 2012+ Transact-SQL documentation:
// DATETIMEFROMPARTS takes 7 arguments and returns datetime; DATETIME2FROMPARTS takes 8 and
// returns datetime2(precision). Unlike DATEFROMPARTS, both builders carry a time component, so
// DATEADD(HOUR, ...) is legal and preserves the type needed by the window comparison.
const datetimeMidnight = (parameter) => `DATETIMEFROMPARTS(${ymdParts(parameter)}, 0, 0, 0, 0)`;
const datetime2Midnight = (parameter) => `DATETIME2FROMPARTS(${ymdParts(parameter)}, 0, 0, 0, 0, 3)`;

const template = (time, timeUtc, windowType, midnightFor) => `
DECLARE @from ${windowType} = DATEADD(HOUR, -@tz, ${midnightFor("@startYmd")});
DECLARE @to   ${windowType} = DATEADD(DAY, 1, DATEADD(HOUR, -@tz, ${midnightFor("@endYmd")}));

SELECT
  eh.PeopleID, pp.Firstname, pp.Lastname, pp.Department,
  ${localDayExpr(time)} AS LocalDate,
  MIN(eh.CardNumber) AS CardNumber,
  ${clockExpr(`MIN(${timeUtc})`)} AS FirstEntry,
  ${clockExpr(`MAX(${timeUtc})`)} AS LastEntry,
  DATEDIFF(MINUTE, MIN(${timeUtc}), MAX(${timeUtc})) AS DurationMin,
  COUNT(*) AS AccessCount
FROM dbo.EventHistory AS eh
LEFT JOIN dbo.p_people AS pp ON eh.PeopleID = pp.PeopleID
WHERE TRY_CONVERT(int, eh.EventCategory) = 10001
  AND eh.EventDescription = N'Access Granted'
  AND eh.CardNumber IS NOT NULL AND LTRIM(RTRIM(CONVERT(VARCHAR(64), eh.CardNumber))) <> '0'
  AND ${timeUtc} >= @from AND ${timeUtc} < @to
  -- Optional ID-number filter; empty means everyone. Compared as text so any PeopleID type works.
  AND (@idNumber = '' OR LTRIM(RTRIM(CONVERT(VARCHAR(64), eh.PeopleID))) = @idNumber)
GROUP BY eh.PeopleID, pp.Firstname, pp.Lastname, pp.Department, ${localDayExpr(time)};`;

/** Time-bearing datetime column: preserve its raw value for index-friendly comparisons. */
export const statementFor = (kind) => (kind === "datetime"
  ? template(
    "DATEADD(HOUR, @tz, eh.EventUTCTime)",
    "eh.EventUTCTime",
    "DATETIME",
    datetimeMidnight,
  )
  : template(
    "DATEADD(HOUR, @tz, TRY_CONVERT(datetime2(3), eh.EventUTCTime))",
    "TRY_CONVERT(datetime2(3), eh.EventUTCTime)",
    "DATETIME2(3)",
    datetime2Midnight,
  ));

/** The statement used when the column type could not be read: the text-safe one, never fatal. */
export const TEXT_SAFE_STATEMENT = statementFor("text");

const TYPE_SQL = `
SELECT DATA_TYPE AS kind
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'EventHistory' AND COLUMN_NAME = 'EventUTCTime';`;

/**
 * Who can be marked absent: active people only. dbo.p_people.IsActive is 1 for active staff and 0
 * for inactive or not-yet-employed people. Anything that is not 1 (including NULL or unreadable
 * text) is not eligible, so an unknown status can never produce an absence. Like the attendance
 * statement, the ID filter is a bound parameter compared as trimmed text.
 */
export const ROSTER_SQL = `
SELECT pp.PeopleID, pp.Firstname, pp.Lastname, pp.Department
FROM dbo.p_people AS pp
WHERE TRY_CONVERT(int, pp.IsActive) = 1
  AND (@idNumber = '' OR LTRIM(RTRIM(CONVERT(VARCHAR(64), pp.PeopleID))) = @idNumber);`;

/**
 * Reads EventUTCTime's declared type once per run. Anything unreadable — no row, an error, an
 * unexpected type — is reported as "text" so the run keeps the TRY_CONVERT statement: slower to
 * aggregate, but it cannot raise a conversion error.
 */
export async function readEventTimeType(queryFn = query) {
  try {
    const rows = await queryFn(TYPE_SQL, {});
    const kind = classifyColumn(rows?.[0]?.kind);
    return kind === "unknown" ? "text" : kind;
  } catch {
    return "text";
  }
}

/* ---------- Absence ---------- */

const DAY_MS = 86400000;
const dayNumber = (ymd) => Date.parse(`${ymd}T00:00:00Z`) / DAY_MS;
const ymdOf = (number) => new Date(number * DAY_MS).toISOString().slice(0, 10);

/** Every local day from start to end inclusive, as YYYY-MM-DD, counted in whole days. */
export function daysInPeriod(start, end) {
  const days = [];
  for (let n = dayNumber(start); n <= dayNumber(end); n += 1) days.push(ymdOf(n));
  return days;
}

/**
 * Weekday of a local calendar day, from the date text alone (`2026-10-05` -> "Monday"). The
 * report's days are already local (`@tz` was applied in SQL), so no time zone is involved and the
 * machine clock cannot move a row's weekday.
 */
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const weekdayIndex = (ymd) => new Date(`${ymd}T00:00:00Z`).getUTCDay();

export const weekdayOf = (ymd) => WEEKDAY_NAMES[weekdayIndex(ymd)];

/** Saturday and Sunday, by calendar day (no time zone involved: the text is already local). */
export const isWeekend = (ymd) => [0, 6].includes(weekdayIndex(ymd));

/** The local "today" for the configured offset, so the cut-off matches the report's day boundaries. */
export function localToday(now = new Date(), tzOffsetHours = 0) {
  const offset = Number(tzOffsetHours) || 0;
  return new Date(now.getTime() + offset * 3600000).toISOString().slice(0, 10);
}

/** The matching key for the same person in the swipe rows and the roster: trimmed text. */
const personKey = (id) => (id === null || id === undefined ? null : String(id).trim());

const nameOf = (row) => [row.Lastname, row.Firstname].filter(Boolean).join(" ") || "Unknown";

/**
 * One row per eligible person per local day with no granted swipe. Days after `today` are left
 * out, so a future day can never show as absent. Weekends are included unless
 * ABSENCE_SKIP_WEEKENDS is set. `roster` holds { key, name, idNumber, department }.
 */
export function absentRows({ start, end, today, roster, presentKeys, skipWeekends = ABSENCE_SKIP_WEEKENDS }) {
  const last = end < today ? end : today;
  const rows = [];
  if (start > last) return rows;
  for (const date of daysInPeriod(start, last)) {
    if (skipWeekends && isWeekend(date)) continue;
    for (const person of roster) {
      if (presentKeys.has(`${person.key}|${date}`)) continue;
      rows.push({
        date,
        day: weekdayOf(date),
        name: person.name,
        idNumber: person.idNumber,
        department: person.department,
        cardNumber: "—",
        firstEntry: "—",
        lastEntry: "—",
        duration: "—",
        accessCount: 0,
        status: "Absent",
      });
    }
  }
  return rows;
}

/* ---------- Run ---------- */

/** Date-shape errors keep their driver fields and gain the doctor hint; everything else passes through. */
const guard = async (fn) => {
  try {
    return await fn();
  } catch (error) {
    throw isDateShapeError(error) ? withDateShapeHint(error) : error;
  }
};

/**
 * Department first — the report groups by it, so a department's rows stay together — then date, so
 * the days run in order inside each department. On a day, everyone who swiped is listed before the
 * absentees, and each of those two blocks is alphabetical.
 */
const STATUS_ORDER = { Present: 0, Absent: 1 };

const sortRows = (rows) => rows.sort((a, b) =>
  a.department.localeCompare(b.department) ||
  a.date.localeCompare(b.date) ||
  (STATUS_ORDER[a.status] ?? 1) - (STATUS_ORDER[b.status] ?? 1) ||
  a.name.localeCompare(b.name));

/**
 * Runs the swipe query and the eligible roster for the same window and returns both sides of
 * the answer: the people who swiped (Present) and the active employees who did not (Absent).
 */
export async function runPeriod(params, { tz, queryFn = query, now = new Date() } = {}) {
  const normalized = normalizeParams(params);
  const { start, end, idNumber } = normalized;
  const kind = await readEventTimeType(queryFn);
  const values = { startYmd: toYmd(start), endYmd: toYmd(end), idNumber: idNumber ?? "", tz };

  const swipes = await guard(() => queryFn(statementFor(kind), values));
  const people = await guard(() => queryFn(ROSTER_SQL, { idNumber: idNumber ?? "" }));

  const present = swipes.map((r) => {
    const single = r.DurationMin === 0; // one swipe: no check-out to show
    const date = r.LocalDate ?? start;
    return {
      date,
      day: weekdayOf(date),
      name: nameOf(r),
      idNumber: r.PeopleID ?? "—",
      department: r.Department || "Unassigned",
      cardNumber: r.CardNumber,
      firstEntry: r.FirstEntry,
      lastEntry: single ? "—" : r.LastEntry,
      duration: single ? "—" : `${Math.floor(r.DurationMin / 60)}h ${String(r.DurationMin % 60).padStart(2, "0")}m`,
      accessCount: r.AccessCount,
      status: "Present",
    };
  });

  const byKey = new Map();
  for (const person of people) {
    const key = personKey(person.PeopleID);
    if (key && !byKey.has(key)) {
      byKey.set(key, { key, name: nameOf(person), idNumber: person.PeopleID, department: person.Department || "Unassigned" });
    }
  }
  const presentKeys = new Set(present.map((r) => `${personKey(r.idNumber)}|${r.date}`));
  const absent = absentRows({
    start,
    end,
    today: localToday(now, tz),
    roster: [...byKey.values()],
    presentKeys,
  });

  return { normalized, present: sortRows(present), absent: sortRows(absent) };
}

/** The attendance report: everyone who swiped plus every eligible employee with no swipe. */
async function run(params, options = {}) {
  const { present, absent } = await runPeriod(params, options);
  return sortRows([...present, ...absent]);
}

export default {
  id: "attendance",
  title: "Daily attendance",
  description: "Who swiped in on a day, date range or month, with first and last entry. Active employees with no swipe are listed as Absent.",
  params: periodParams,
  groupBy: "department",
  columns: COLUMNS,
  columnsFor,
  exportColumnsFor,
  normalize: normalizeParams,
  subtitle,
  run,
};
