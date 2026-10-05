import { query } from "../db/pool.js";

// Times are stored in UTC. @tz shifts them to local time. The UTC window is computed in
// the query from the local first/last day so an index on EventUTCTime can still be used,
// and rows are grouped per person *and* local calendar day so a range never merges days.
const SQL = `
DECLARE @from DATETIME = DATEADD(HOUR, -@tz, CONVERT(DATETIME, @start, 23));
DECLARE @to DATETIME = DATEADD(DAY, 1, DATEADD(HOUR, -@tz, CONVERT(DATETIME, @end, 23)));

SELECT
  eh.PeopleID, pp.Firstname, pp.Lastname, pp.Department,
  CONVERT(VARCHAR(10), DATEADD(HOUR, @tz, eh.EventUTCTime), 23) AS LocalDate,
  MIN(eh.CardNumber) AS CardNumber,
  CONVERT(VARCHAR(8), DATEADD(HOUR, @tz, MIN(eh.EventUTCTime)), 108) AS FirstEntry,
  CONVERT(VARCHAR(8), DATEADD(HOUR, @tz, MAX(eh.EventUTCTime)), 108) AS LastEntry,
  DATEDIFF(MINUTE, MIN(eh.EventUTCTime), MAX(eh.EventUTCTime)) AS DurationMin,
  COUNT(*) AS AccessCount
FROM dbo.EventHistory AS eh
LEFT JOIN dbo.p_people AS pp ON eh.PeopleID = pp.PeopleID
WHERE eh.EventCategory = 10001
  AND eh.EventDescription = 'Access Granted'
  AND eh.CardNumber IS NOT NULL AND eh.CardNumber <> 0
  AND eh.EventUTCTime >= @from AND eh.EventUTCTime < @to
GROUP BY eh.PeopleID, pp.Firstname, pp.Lastname, pp.Department,
  CONVERT(VARCHAR(10), DATEADD(HOUR, @tz, eh.EventUTCTime), 23);`;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MODES = new Set(["single", "range"]);
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

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

  if (mode === "single") {
    const date = String(values.date ?? "").trim();
    if (!isIsoDate(date)) throw badRequest("Pick a valid date.");
    return { mode, date, start: date, end: date };
  }

  const start = String(values.start ?? "").trim();
  const end = String(values.end ?? "").trim();
  if (!isIsoDate(start) || !isIsoDate(end)) throw badRequest("Pick a valid start date and end date.");
  if (start > end) throw badRequest("The start date must be on or before the end date.");
  return { mode, start, end };
}

const isRange = (params = {}) =>
  params.mode ? params.mode === "range" : Boolean(params.start && params.end && params.start !== params.end);

const COLUMNS = [
  { key: "name", label: "Name" },
  { key: "peopleId", label: "People ID" },
  { key: "cardNumber", label: "Card no." },
  { key: "firstEntry", label: "First entry" },
  { key: "lastEntry", label: "Last entry" },
  { key: "duration", label: "Duration" },
  { key: "accessCount", label: "Swipes", align: "right" },
];

/** Range mode adds a Date column so the same person's days stay distinguishable. */
export const columnsFor = (params = {}) => (isRange(params) ? [{ key: "date", label: "Date" }, ...COLUMNS] : [...COLUMNS]);

export function subtitle(params = {}) {
  if (!isRange(params)) return `Attendance for ${params.date ?? params.start ?? ""}`;
  const days = rangeDays(params.start, params.end);
  return `Attendance from ${params.start} to ${params.end} (${days} day${days === 1 ? "" : "s"})`;
}

async function run(params, { tz, queryFn = query } = {}) {
  const { start, end } = normalizeParams(params);
  const rows = await queryFn(SQL, { start, end, tz });
  return rows
    .map((r) => {
      const single = r.DurationMin === 0; // one swipe: no check-out to show
      return {
        date: r.LocalDate ?? start,
        name: [r.Lastname, r.Firstname].filter(Boolean).join(" ") || "Unknown",
        peopleId: r.PeopleID ?? "—",
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
  ],
  groupBy: "department",
  columns: COLUMNS,
  columnsFor,
  normalize: normalizeParams,
  subtitle,
  run,
};
