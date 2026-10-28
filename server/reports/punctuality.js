// Punctuality: how each person's first swipe of the day compares with the resumption time.
//
//   Early      first swipe before the resumption time
//   On time    from the resumption time, up to (not including) "Late from"
//   Late       from "Late from", up to (not including) "Very late from"
//   Very late  from "Very late from" on
//
// Only days the person came in count (the Present rows of lib/attendance-data.js, so the days
// picker, weekend rule and "on record" rule are the same as Daily attendance).
// Total = On time + Late + Very late.
//
// "View" gives one row per person (grouped by department), or one row per department with an
// "All departments" grand total at the end.

import { runPeriod } from "./lib/attendance-data.js";
import { normalizePeriod, periodParams, periodSubtitle } from "./lib/period.js";

export const DEFAULT_TIMES = Object.freeze({ resumption: "07:00", late: "07:15", veryLate: "08:00" });
export const ALL_DEPARTMENTS = "All departments";

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

// Drawn together as one "Arrival times" box on the form.
const TIMES_GROUP = { group: "Arrival times", groupHint: "Before resumption is Early; from resumption until Late from is On time." };
const TIME_FIELDS = [
  { name: "resumption", label: "Resumption", type: "time", default: DEFAULT_TIMES.resumption, ...TIMES_GROUP },
  { name: "late", label: "Late from", type: "time", default: DEFAULT_TIMES.late, ...TIMES_GROUP },
  { name: "veryLate", label: "Very late from", type: "time", default: DEFAULT_TIMES.veryLate, ...TIMES_GROUP },
];
const VIEW = {
  name: "view", label: "View", type: "select", default: "person",
  options: [{ value: "person", label: "By person" }, { value: "department", label: "By department" }],
};

const COUNT_COLUMNS = [
  { key: "early", label: "Early", align: "right", minWidth: 60 },
  { key: "onTime", label: "On time", align: "right", minWidth: 60 },
  { key: "late", label: "Late", align: "right", minWidth: 60 },
  { key: "veryLate", label: "Very late", align: "right", minWidth: 70 },
  { key: "total", label: "Total", align: "right", minWidth: 60 },
];
const PERSON_COLUMNS = [
  { key: "cardNumber", label: "Card no.", minWidth: 80 },
  { key: "firstName", label: "First name", minWidth: 110 },
  { key: "lastName", label: "Last name", minWidth: 110 },
  { key: "department", label: "Department", minWidth: 120 },
  ...COUNT_COLUMNS,
];
// Department rows keep their name under another key, so they are not split into one-row sections.
const DEPARTMENT_COLUMNS = [{ key: "departmentName", label: "Department", minWidth: 140 }, ...COUNT_COLUMNS];

export const columnsFor = (params = {}) => (params.view === "department" ? DEPARTMENT_COLUMNS : PERSON_COLUMNS);

/** "7:00", "07:00" or "07:00:00" -> "07:00:00"; null when it is not a clock time. */
export function clockTime(value) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(value ?? "").trim());
  if (!m) return null;
  const [h, min, s] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  if (h > 23 || min > 59 || s > 59) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(min)}:${pad(s)}`;
}

export function normalize(values = {}) {
  const times = {};
  for (const field of TIME_FIELDS) {
    const raw = String(values[field.name] ?? "").trim() || field.default;
    const time = clockTime(raw);
    if (!time) throw badRequest(`${field.label}: enter a time like 07:00.`);
    times[field.name] = time;
  }
  if (!(times.resumption <= times.late && times.late <= times.veryLate)) {
    throw badRequest("Arrival times must be in order: Resumption ≤ Late from ≤ Very late from.");
  }
  return { ...normalizePeriod(values), ...times, view: values.view === "department" ? "department" : "person" };
}

/** Which bucket a first swipe ("HH:MM:SS", 24-hour) falls in. */
export function bucketOf(firstEntry, { resumption, late, veryLate }) {
  if (firstEntry < resumption) return "early";
  if (firstEntry < late) return "onTime";
  if (firstEntry < veryLate) return "late";
  return "veryLate";
}

const emptyCounts = () => ({ early: 0, onTime: 0, late: 0, veryLate: 0, total: 0 });
const add = (counts, bucket) => {
  counts[bucket] += 1;
  if (bucket !== "early") counts.total += 1;
};

/** Present rows -> one row per person (view "person") or per department plus a grand total. */
export function tally(present, params) {
  const people = new Map();
  for (const row of present) {
    if (!row.firstEntrySort) continue;
    let person = people.get(row.personKey);
    if (!person) {
      person = { cardNumber: row.cardNumber, firstName: row.firstName, lastName: row.lastName,
        department: row.department, ...emptyCounts() };
      people.set(row.personKey, person);
    }
    add(person, bucketOf(row.firstEntrySort, params));
  }
  const persons = [...people.values()].sort((a, b) =>
    a.department.localeCompare(b.department) ||
    String(a.lastName).localeCompare(String(b.lastName)) ||
    String(a.firstName).localeCompare(String(b.firstName)));
  if (params.view !== "department") return persons;

  const departments = new Map();
  const grand = { departmentName: ALL_DEPARTMENTS, ...emptyCounts() };
  for (const p of persons) {
    if (!departments.has(p.department)) departments.set(p.department, { departmentName: p.department, ...emptyCounts() });
    const d = departments.get(p.department);
    for (const key of Object.keys(emptyCounts())) { d[key] += p[key]; grand[key] += p[key]; }
  }
  return [...departments.values(), grand];
}

const hm = (t) => t.slice(0, 5);

export default {
  id: "punctuality",
  title: "Punctuality",
  description: "Early, on-time, late and very late arrivals, per person or per department.",
  category: "Attendance",
  icon: "clock",
  params: [...periodParams, ...TIME_FIELDS, VIEW],
  groupBy: "department",
  columns: PERSON_COLUMNS,
  columnsFor,
  normalize,
  subtitle: (p) => `${periodSubtitle(p, "Punctuality")} · resumption ${hm(p.resumption)}, late from ${hm(p.late)}, very late from ${hm(p.veryLate)}`,
  run: async (params, options) => tally((await runPeriod(params, options)).present, params),
};
