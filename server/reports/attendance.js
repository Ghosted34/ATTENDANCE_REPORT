// Daily attendance: who came in (Present), for each day of the period, with first/last entry.
// "Show: Present and absent" adds the Absent rows too. See lib/attendance-data.js for the rules.

import { runPeriod, sortRows } from "./lib/attendance-data.js";
import { normalizePeriod, periodParams, periodSubtitle, withPeriodColumns } from "./lib/period.js";

const SHOW = {
  name: "show", label: "Show", type: "select", default: "present",
  options: [{ value: "present", label: "Present only" }, { value: "all", label: "Present and absent" }],
};

const COLUMNS = [
  { key: "name", label: "Name", minWidth: 150 },
  { key: "idNumber", label: "Employee ID", minWidth: 80 },
  { key: "cardNumber", label: "Card no.", minWidth: 80 },
  { key: "department", label: "Department", minWidth: 120 },
  { key: "firstEntry", label: "First entry", minWidth: 80 },
  { key: "lastEntry", label: "Last entry", minWidth: 80 },
  { key: "duration", label: "Duration", minWidth: 80 },
  { key: "accessCount", label: "Swipes", align: "right", minWidth: 60 },
  { key: "status", label: "Status", minWidth: 80 },
];

export default {
  id: "attendance",
  title: "Daily attendance",
  description: "Who came in, with first and last entry. Optionally include absentees.",
  category: "Attendance",
  icon: "calendar",
  params: [...periodParams, SHOW],
  // One section per department; with absentees shown, each section lists Present rows first.
  groupBy: "department",
  columns: COLUMNS,
  columnsFor: (params) => withPeriodColumns(COLUMNS, params),
  normalize: (values) => ({ ...normalizePeriod(values), show: values.show === "all" ? "all" : "present" }),
  subtitle: (params) => periodSubtitle(params, params.show === "all" ? "Attendance" : "Present"),
  run: async (params, options) => {
    const { present, absent } = await runPeriod(params, options);
    return params.show === "all" ? sortRows([...present, ...absent]) : present;
  },
};
