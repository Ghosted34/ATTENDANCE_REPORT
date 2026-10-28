// The "Report for" picker shared by every period report: a single date, a date range or a month.
// A report that uses it gets the form fields, the validation, the Date/Day columns and the subtitle.

import { isIsoDate, monthBounds, MONTH_NAMES, rangeDays, SHORT_DAYS, weekdayOf } from "./dates.js";

/** Longest period one run may cover. */
export const MAX_PERIOD_DAYS = 366;

/** Monday to Friday are working days: nobody is ever marked Absent on a Saturday or Sunday. */
export const WORKING_DAYS_ONLY = true;

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

/** The form fields. A field with `mode` is only shown (and sent) when that mode is picked. */
export const periodParams = Object.freeze([
  {
    name: "mode", label: "Report for", type: "select", default: "single",
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
  // Day picker (Sun–Sat). Mon–Fri are on by default; the report covers only the picked weekdays
  // (nothing picked = every day).
  { name: "days", label: "Days", type: "weekdays", mode: "range month", optional: true, default: "1,2,3,4,5" },
  { name: "idNumber", label: "Employee ID", type: "text", optional: true, placeholder: "All employees" },
]);

/**
 * Checks the submitted fields and turns every mode into one inclusive window { start, end }.
 * Bad input is refused with HTTP 400 before any SQL runs.
 */
export function normalizePeriod(values = {}) {
  const mode = String(values.mode ?? "").trim() || "single";
  if (!["single", "range", "month"].includes(mode)) throw badRequest('Choose "Single date", "Date range" or "Month".');

  // `employeeId` is accepted as an alias for hand-written links.
  const idNumber = String(values.idNumber ?? "").trim() || String(values.employeeId ?? "").trim();
  if (idNumber && !/^[A-Za-z0-9_-]{1,64}$/.test(idNumber)) {
    throw badRequest("Employee ID can only contain letters, digits, dashes and underscores.");
  }

  if (mode === "single") {
    const date = String(values.date ?? "").trim();
    if (!isIsoDate(date)) throw badRequest("Pick a valid date.");
    return { mode, date, start: date, end: date, idNumber, days: [] };
  }

  // "1,2,3" -> [1, 2, 3] (0 = Sunday). None or all seven picked means every day.
  const days = [...new Set(String(values.days ?? "").split(",").map((d) => d.trim()).filter(Boolean))];
  if (days.some((d) => !/^[0-6]$/.test(d))) throw badRequest("Pick days of the week from Sunday to Saturday.");
  const daysPicked = days.length === 7 ? [] : days.map(Number).sort();

  if (mode === "month") {
    const month = String(values.month ?? "").trim();
    const bounds = monthBounds(month);
    if (!bounds) throw badRequest("Pick a valid month (YYYY-MM).");
    return { mode, month, start: bounds.start, end: bounds.end, idNumber, days: daysPicked };
  }

  const start = String(values.start ?? "").trim();
  const end = String(values.end ?? "").trim();
  if (!isIsoDate(start) || !isIsoDate(end)) throw badRequest("Pick a valid start date and end date.");
  if (start > end) throw badRequest("The start date must be on or before the end date.");
  if (rangeDays(start, end) > MAX_PERIOD_DAYS) throw badRequest(`A date range can cover at most ${MAX_PERIOD_DAYS} days.`);
  return { mode, start, end, idNumber, days: daysPicked };
}

/** True when a date's weekday is one of the picked days (or no days were picked). */
export const onPickedDay = (days = []) => (ymd) => !days.length || days.includes(new Date(`${ymd}T00:00:00Z`).getUTCDay());

const spansDays = (p = {}) => (p.mode ? p.mode !== "single" : Boolean(p.start && p.end && p.start !== p.end));

const DATE_COLUMN = { key: "date", label: "Date", minWidth: 80 };
const DAY_COLUMN = { key: "day", label: "Day", minWidth: 80 };

/** Puts Day (and Date, for a range or month) in front of a report's own columns. */
export const withPeriodColumns = (columns, params = {}) =>
  (spansDays(params) ? [DATE_COLUMN, DAY_COLUMN, ...columns] : [DAY_COLUMN, ...columns]);

/** " · Mon, Wed, Fri only" when days were picked. */
const daysNote = (days = []) => (days.length ? ` · ${days.map((d) => SHORT_DAYS[d]).join(", ")} only` : "");

/**
 * "Attendance for 2026-10-05 (Monday)", "Attendance from 2026-10-05 to 2026-10-11 (7 days) · Mon, Tue only",
 * "Attendance for October 2026 (2026-10-01 to 2026-10-31)".
 */
export function periodSubtitle(params = {}, label) {
  if (params.mode === "month") {
    const b = monthBounds(params.month);
    if (b) return `${label} for ${MONTH_NAMES[b.month - 1]} ${b.year} (${b.start} to ${b.end})${daysNote(params.days)}`;
  }
  if (!spansDays(params)) {
    const date = params.date ?? params.start ?? "";
    return isIsoDate(date) ? `${label} for ${date} (${weekdayOf(date)})` : `${label} for ${date}`;
  }
  const n = rangeDays(params.start, params.end);
  return `${label} from ${params.start} to ${params.end} (${n} day${n === 1 ? "" : "s"})${daysNote(params.days)}`;
}
