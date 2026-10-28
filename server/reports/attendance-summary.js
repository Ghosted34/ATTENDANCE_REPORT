// Attendance summary: one row per person for the whole period, with how many days they were
// Present and/or Absent. The day-by-day rules come from lib/attendance-data.js, so these counts
// always add up to what the Daily attendance and Absentees reports list for the same period.
//
// "Show" picks the count columns:
//   present → Present days only, and only people with at least one present day
//   absent  → Absent days only, and only people with at least one absent day
//   all     → both columns, for everyone on record

import { firstReaders, runPeriod } from "./lib/attendance-data.js";
import { normalizePeriod, periodParams, periodSubtitle } from "./lib/period.js";

// Reader name: the reader (Events/EventHistory.DeviceID -> HW_Devices.DeviceName) of the
// person's first swipe in the period. A person can use several readers; only the first is shown.
// "N/A" when they never swiped in the period (or the database has no DeviceID).
const READER_NA = "N/A";

const SHOW = {
  name: "show", label: "Show", type: "select", default: "all",
  options: [
    { value: "all", label: "Present and absent" },
    { value: "present", label: "Present only" },
    { value: "absent", label: "Absent only" },
  ],
};
const SHOW_VALUES = SHOW.options.map((o) => o.value);

const BASE_COLUMNS = [
  { key: "cardNumber", label: "Card no.", minWidth: 80 },
  { key: "firstName", label: "First name", minWidth: 110 },
  { key: "lastName", label: "Last name", minWidth: 110 },
  { key: "readerName", label: "Reader name", minWidth: 100 },
  { key: "department", label: "Department", minWidth: 120 },
];
const PRESENT_COLUMN = { key: "presentDays", label: "Present days", align: "right", minWidth: 80 };
const ABSENT_COLUMN = { key: "absentDays", label: "Absent days", align: "right", minWidth: 80 };

export const columnsFor = (params = {}) => [
  ...BASE_COLUMNS,
  ...(params.show !== "absent" ? [PRESENT_COLUMN] : []),
  ...(params.show !== "present" ? [ABSENT_COLUMN] : []),
];

const LABELS = { all: "Attendance summary", present: "Days present", absent: "Days absent" };

/** Daily Present/Absent rows -> one summary row per person, sorted by department then name. */
export function summarize({ present = [], absent = [] }, show = "all", readers = new Map()) {
  const people = new Map();
  const tally = (row, field) => {
    let person = people.get(row.personKey);
    if (!person) {
      person = {
        cardNumber: row.cardNumber, firstName: row.firstName, lastName: row.lastName,
        readerName: readers.get(row.personKey) ?? READER_NA, department: row.department, presentDays: 0, absentDays: 0,
      };
      people.set(row.personKey, person);
    }
    person[field] += 1;
  };
  present.forEach((row) => tally(row, "presentDays"));
  absent.forEach((row) => tally(row, "absentDays"));

  return [...people.values()]
    .filter((p) => (show === "present" ? p.presentDays > 0 : show === "absent" ? p.absentDays > 0 : true))
    .sort((a, b) =>
      a.department.localeCompare(b.department) ||
      String(a.lastName).localeCompare(String(b.lastName)) ||
      String(a.firstName).localeCompare(String(b.firstName)));
}

export default {
  id: "attendance-summary",
  title: "Attendance summary",
  description: "Days present and absent per person over a period.",
  category: "Attendance",
  icon: "chart",
  params: [...periodParams, SHOW],
  groupBy: "department",
  columns: columnsFor({ show: "all" }),
  columnsFor,
  normalize: (values) => ({
    ...normalizePeriod(values),
    show: SHOW_VALUES.includes(values.show) ? values.show : "all",
  }),
  subtitle: (params) => periodSubtitle(params, LABELS[params.show] ?? LABELS.all),
  run: async (params, options) => {
    const data = await runPeriod(params, options);
    const readers = data.present.length ? await firstReaders(data.normalized, options) : new Map();
    return summarize(data, params.show, readers);
  },
};
