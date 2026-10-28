// Absentees: only the Absent rows of the attendance report, so the two can never disagree.

import { runPeriod } from "./lib/attendance-data.js";
import { normalizePeriod, periodParams, periodSubtitle, withPeriodColumns } from "./lib/period.js";

const COLUMNS = [
  { key: "name", label: "Name", minWidth: 150 },
  { key: "idNumber", label: "Employee ID", minWidth: 80 },
  { key: "cardNumber", label: "Card no.", minWidth: 80 },
  { key: "department", label: "Department", minWidth: 120 },
];

export default {
  id: "absentees",
  title: "Absentees",
  description: "Who did not come in on a working day (Mon–Fri).",
  category: "Exceptions",
  icon: "user-x",
  params: periodParams,
  groupBy: "department",
  columns: COLUMNS,
  columnsFor: (params) => withPeriodColumns(COLUMNS, params),
  normalize: normalizePeriod,
  subtitle: (params) => periodSubtitle(params, "Absentees"),
  run: async (params, options) => (await runPeriod(params, options)).absent,
};
