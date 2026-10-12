import { normalizeParams, periodColumnsFor, periodParams, periodSubtitle, runPeriod } from "./attendance.js";

/**
 * Absentee-only report: the same periods, the same parameterized swipe and roster queries, and the
 * same absence rule as the attendance report — but only the Absent rows. Nothing here queries
 * anything itself, so the two reports can never disagree about who is absent.
 */

// Absent rows have no swipe, so no card, entry or duration columns: who the person is, where they
// work, and — through the shared period columns — the date and its weekday.
const COLUMNS = [
  { key: "name", label: "Name", minWidth: 150 },
  { key: "idNumber", label: "Employee ID", minWidth: 80 },
  { key: "department", label: "Department", minWidth: 120 },
];

/** The same period columns as the attendance report: Date for a range or month, Day for every period. */
export const columnsFor = (params = {}) => periodColumnsFor(COLUMNS, params);

/** Screen and exports use the one list, exactly as they do on the attendance report. */
export const exportColumnsFor = (params = {}) => columnsFor(params);

export const subtitle = (params = {}) => periodSubtitle(params, "Absentees");

export default {
  id: "absentees",
  title: "Absentees",
  description: "Active employees with no granted swipe on each day of the chosen date, range or month.",
  params: periodParams,
  // One section per department: every row here is Absent, so the attendance report's extra
  // Present/Absent split would only repeat itself.
  groupBy: "department",
  columns: COLUMNS,
  columnsFor,
  exportColumnsFor,
  normalize: normalizeParams,
  subtitle,
  run: async (params, options = {}) => (await runPeriod(params, options)).absent,
};
