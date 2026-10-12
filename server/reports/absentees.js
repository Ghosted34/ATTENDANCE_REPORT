import { columnsFor as periodColumns, normalizeParams, periodParams, periodSubtitle, runPeriod } from "./attendance.js";

/**
 * Absentee-only report: the same periods, the same parameterized swipe and roster queries, and the
 * same absence rule as the attendance report — but only the Absent rows. Nothing here queries
 * anything itself, so the two reports can never disagree about who is absent.
 */

// Absent rows have no swipe, so no card, entry or duration columns: name and Employee ID only.
const COLUMNS = [
  { key: "name", label: "Name" },
  { key: "idNumber", label: "Employee ID" },
];

/** Range and month periods add the Date column in front, as they do on the attendance report. */
export const columnsFor = (params = {}) => (periodColumns(params)[0]?.key === "date"
  ? [{ key: "date", label: "Date" }, ...COLUMNS]
  : [...COLUMNS]);

/** Exports carry Department after the Employee ID, matching the attendance report. */
export const exportColumnsFor = (params = {}) => {
  const cols = columnsFor(params);
  const at = cols.findIndex((c) => c.key === "idNumber") + 1;
  return [...cols.slice(0, at), { key: "department", label: "Department" }, ...cols.slice(at)];
};

export const subtitle = (params = {}) => periodSubtitle(params, "Absentees");

export default {
  id: "absentees",
  title: "Absentees",
  description: "Active employees with no granted swipe on each day of the chosen date, range or month.",
  params: periodParams,
  groupBy: "department",
  columns: COLUMNS,
  columnsFor,
  exportColumnsFor,
  normalize: normalizeParams,
  subtitle,
  run: async (params, options = {}) => (await runPeriod(params, options)).absent,
};
