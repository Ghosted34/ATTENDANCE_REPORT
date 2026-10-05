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
 *     TRY_CONVERT(int, …) and the ID number/card number as trimmed text.
 *
 * Every value still arrives as a bound parameter; nothing from the request is concatenated.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MODES = new Set(["single", "range"]);
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

/** Whole calendar days between two validated dates, inclusive of both ends. */
export function rangeDays(start, end) {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;
}

/**
 * Validates the API/UI parameters and resolves them to the local window the query needs.
 * "single" (the default) is expressed as a one-day range so SQL has one code path.
 */
export function normalizeParams(values = {}) {
  const mode = String(values.mode ?? "").trim() || "single";
  if (!MODES.has(mode)) throw badRequest('Choose "Single date" or "Date range".');

  const idNumber = String(values.idNumber ?? "").trim();
  if (idNumber && !/^[A-Za-z0-9_-]{1,64}$/.test(idNumber)) {
    throw badRequest("ID number can only contain letters, digits, dashes and underscores.");
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
  return { mode, start, end, idNumber };
}

const isRange = (params = {}) =>
  params.mode ? params.mode === "range" : Boolean(params.start && params.end && params.start !== params.end);

const COLUMNS = [
  { key: "name", label: "Name" },
  { key: "idNumber", label: "ID number" },
  { key: "cardNumber", label: "Card no." },
  { key: "firstEntry", label: "First entry" },
  { key: "lastEntry", label: "Last entry" },
  { key: "duration", label: "Duration" },
  { key: "accessCount", label: "Swipes", align: "right" },
];

/** Range mode adds a Date column so the same person's days stay distinguishable. */
export const columnsFor = (params = {}) => (isRange(params) ? [{ key: "date", label: "Date" }, ...COLUMNS] : [...COLUMNS]);

/**
 * Printed/exported template: it repeats the grouping column per row, so a sheet that is
 * filtered or sorted still says who belongs to which department.
 */
export const exportColumnsFor = (params = {}) => {
  const cols = columnsFor(params);
  const at = cols.findIndex((c) => c.key === "idNumber") + 1;
  return [...cols.slice(0, at), { key: "department", label: "Department" }, ...cols.slice(at)];
};

export function subtitle(params = {}) {
  if (!isRange(params)) return `Attendance for ${params.date ?? params.start ?? ""}`;
  const days = rangeDays(params.start, params.end);
  return `Attendance from ${params.start} to ${params.end} (${days} day${days === 1 ? "" : "s"})`;
}

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

async function run(params, { tz, queryFn = query } = {}) {
  const { start, end, idNumber } = normalizeParams(params);
  const kind = await readEventTimeType(queryFn);
  const sql = statementFor(kind);
  const values = { startYmd: toYmd(start), endYmd: toYmd(end), idNumber: idNumber ?? "", tz };
  let rows;
  try {
    rows = await queryFn(sql, values);
  } catch (error) {
    // Date-shape errors (241 conversion, 242 range, 9810 unsupported datepart) are actionable
    // through the read-only doctor. Keep the driver's number/code fields on the same error object.
    throw isDateShapeError(error) ? withDateShapeHint(error) : error;
  }
  return rows
    .map((r) => {
      const single = r.DurationMin === 0; // one swipe: no check-out to show
      return {
        date: r.LocalDate ?? start,
        name: [r.Lastname, r.Firstname].filter(Boolean).join(" ") || "Unknown",
        idNumber: r.PeopleID ?? "—",
        department: r.Department || "Unassigned",
        cardNumber: r.CardNumber,
        firstEntry: r.FirstEntry,
        lastEntry: single ? "—" : r.LastEntry,
        duration: single ? "—" : `${Math.floor(r.DurationMin / 60)}h ${String(r.DurationMin % 60).padStart(2, "0")}m`,
        accessCount: r.AccessCount,
      };
    })
    .sort((a, b) =>
      a.date.localeCompare(b.date) ||
      a.department.localeCompare(b.department) ||
      a.name.localeCompare(b.name));
}

export default {
  id: "attendance",
  title: "Daily attendance",
  description: "Who swiped in on a single day or a date range, with first and last entry.",
  params: [
    {
      name: "mode",
      label: "Report for",
      type: "select",
      default: "single",
      options: [
        { value: "single", label: "Single date" },
        { value: "range", label: "Date range" },
      ],
    },
    { name: "date", label: "Date", type: "date", mode: "single" },
    { name: "start", label: "Start date", type: "date", mode: "range" },
    { name: "end", label: "End date", type: "date", mode: "range" },
    { name: "idNumber", label: "ID number", type: "text", optional: true, placeholder: "All",
      hint: "Leave blank for everyone." },
  ],
  groupBy: "department",
  columns: COLUMNS,
  columnsFor,
  exportColumnsFor,
  normalize: normalizeParams,
  subtitle,
  run,
};
