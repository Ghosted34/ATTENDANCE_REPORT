import test from "node:test";
import assert from "node:assert/strict";
import punctuality, { bucketOf, clockTime, tally, ALL_DEPARTMENTS } from "../server/reports/punctuality.js";
import { reports } from "../server/reports/registry.js";
import { columnsOf, group, toCsv } from "../server/reports/export.js";
import { paramFieldsHtml } from "../renderer/app/js/template.js";

const swipe = (PeopleID, LocalDate, FirstEntry, who) => ({ LocalDate, PeopleID, FirstEntry, LastEntry: "17:00:00",
  DurationMin: 500, AccessCount: 2, CardNumber: who.card, EmployeeID: null, ...who.names });
const ADA = { card: 1234, names: { Firstname: "Ada", Lastname: "Obi", Department: "Ops" } };
const BEN = { card: 9876, names: { Firstname: "Ben", Lastname: "Nwosu", Department: "Security" } };
// Ada: 06:45 early, 07:00 on time, 07:14:59 on time, 07:15 late, 08:00 very late. Ben: 07:30 late.
const swipes = [
  swipe(7, "2026-10-05", "06:45:00", ADA), swipe(7, "2026-10-06", "07:00:00", ADA), swipe(7, "2026-10-07", "07:14:59", ADA),
  swipe(7, "2026-10-08", "07:15:00", ADA), swipe(7, "2026-10-09", "08:00:00", ADA), swipe(9, "2026-10-05", "07:30:00", BEN),
];
const roster = [
  { PeopleID: 7, EmployeeID: null, PeopleCard: 1234, CardNumber: 1234, ...ADA.names },
  { PeopleID: 9, EmployeeID: null, PeopleCard: 9876, CardNumber: 9876, ...BEN.names },
];
const queryFn = async (sql) => {
  if (/INFORMATION_SCHEMA/.test(sql)) return [];
  return /IsActive/.test(sql) ? roster : swipes;
};
const run = async (extra = {}) => {
  const params = punctuality.normalize({ mode: "range", start: "2026-10-05", end: "2026-10-09", ...extra });
  return { params, rows: await punctuality.run(params, { tz: 1, queryFn, now: new Date("2026-10-12T09:00:00Z") }) };
};

test("registered, with time fields defaulting to 07:00 / 07:15 / 08:00", () => {
  assert.equal(reports.get("punctuality"), punctuality);
  const p = punctuality.normalize({ mode: "single", date: "2026-10-05" });
  assert.deepEqual([p.resumption, p.late, p.veryLate, p.view], ["07:00:00", "07:15:00", "08:00:00", "person"]);
  assert.match(paramFieldsHtml(punctuality, { resumption: "07:00" }), /type="time" value="07:00"/);
});

test("buckets: boundaries belong to the later bucket", () => {
  const t = { resumption: "07:00:00", late: "07:15:00", veryLate: "08:00:00" };
  assert.deepEqual(["06:59:59", "07:00:00", "07:14:59", "07:15:00", "07:59:59", "08:00:00"].map((x) => bucketOf(x, t)),
    ["early", "onTime", "onTime", "late", "late", "veryLate"]);
});

test("by person: counts per person, total = on time + late + very late", async () => {
  const { params, rows } = await run();
  assert.deepEqual(rows, [
    { cardNumber: 1234, firstName: "Ada", lastName: "Obi", department: "Ops", early: 1, onTime: 2, late: 1, veryLate: 1, total: 4 },
    { cardNumber: 9876, firstName: "Ben", lastName: "Nwosu", department: "Security", early: 0, onTime: 0, late: 1, veryLate: 0, total: 1 },
  ]);
  assert.deepEqual(columnsOf(punctuality, params).map((c) => c.label),
    ["Card no.", "First name", "Last name", "Department", "Early", "On time", "Late", "Very late", "Total"]);
  assert.deepEqual(group(punctuality, rows).map((s) => s.name), ["Ops", "Security"]);
});

test("by department: one row per department and a grand total, in one unheaded table", async () => {
  const { params, rows } = await run({ view: "department" });
  assert.deepEqual(rows.map((r) => [r.departmentName, r.early, r.onTime, r.late, r.veryLate, r.total]),
    [["Ops", 1, 2, 1, 1, 4], ["Security", 0, 0, 1, 0, 1], [ALL_DEPARTMENTS, 1, 2, 2, 1, 5]]);
  assert.deepEqual(group(punctuality, rows).map((s) => s.name), [null]);
  assert.match(String(toCsv(punctuality, rows, params)), /Department,Early,On time,Late,Very late,Total/);
});

test("custom times move the buckets, and bad or out-of-order times are refused", async () => {
  const { rows, params } = await run({ resumption: "07:30", late: "08:00", veryLate: "09:00" });
  assert.deepEqual([rows[0].early, rows[0].onTime, rows[0].late], [4, 0, 1]);
  assert.match(punctuality.subtitle(params), /resumption 07:30, late from 08:00, very late from 09:00/);
  assert.throws(() => punctuality.normalize({ mode: "single", date: "2026-10-05", late: "25:00" }), /Late from/);
  assert.throws(() => punctuality.normalize({ mode: "single", date: "2026-10-05", late: "06:00" }), /in order/);
  assert.equal(clockTime("7:05"), "07:05:00");
});

test("tally ignores rows without a first entry", () => {
  assert.deepEqual(tally([{ personKey: "1", department: "X" }], { view: "person" }), []);
});
