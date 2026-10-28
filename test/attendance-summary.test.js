import test from "node:test";
import assert from "node:assert/strict";
import summary from "../server/reports/attendance-summary.js";
import { reports } from "../server/reports/registry.js";
import ExcelJS from "exceljs";
import { columnsOf, toCsv, toXlsx } from "../server/reports/export.js";

// Mon 5 – Fri 9 Oct 2026. Ada came Mon+Tue, Ben came Tue, Chi never came, Dee has no card.
const swipes = [
  { LocalDate: "2026-10-05", PeopleID: 7, EmployeeID: "E-1007", Firstname: "Ada", Lastname: "Obi", Department: "Ops", CardNumber: 1234, FirstEntry: "08:00:00", LastEntry: "17:00:00", DurationMin: 540, AccessCount: 2 },
  { LocalDate: "2026-10-06", PeopleID: 7, EmployeeID: "E-1007", Firstname: "Ada", Lastname: "Obi", Department: "Ops", CardNumber: 1234, FirstEntry: "08:00:00", LastEntry: "17:00:00", DurationMin: 540, AccessCount: 2 },
  { LocalDate: "2026-10-06", PeopleID: 9, EmployeeID: "E-1009", Firstname: "Ben", Lastname: "Nwosu", Department: "Security", CardNumber: 9876, FirstEntry: "06:30:00", LastEntry: "18:00:00", DurationMin: 690, AccessCount: 4 },
];
const roster = [
  { PeopleID: 7, EmployeeID: "E-1007", Firstname: "Ada", Lastname: "Obi", Department: "Ops", PeopleCard: 1234, CardNumber: 1234 },
  { PeopleID: 9, EmployeeID: "E-1009", Firstname: "Ben", Lastname: "Nwosu", Department: "Security", PeopleCard: 9876, CardNumber: 9876 },
  { PeopleID: 11, EmployeeID: null, Firstname: "Chi", Lastname: "Eze", Department: "Ops", PeopleCard: 3333, CardNumber: 3333 },
  { PeopleID: 13, EmployeeID: "E-1013", Firstname: "Dee", Lastname: "Uche", Department: "Ops", PeopleCard: null, CardNumber: null },
];
// First reader per person per day, as the reader query returns it (in no particular order).
// Ada used the Main Gate first on Monday, then the Side Door on Tuesday: Main Gate is shown.
// Ben's reader has no DeviceName in HW_Devices, so its DeviceID is shown.
const readerRows = [
  { PeopleID: 7, LocalDate: "2026-10-06", DeviceID: "12", DeviceName: "Side Door" },
  { PeopleID: 9, LocalDate: "2026-10-06", DeviceID: "31", DeviceName: null },
  { PeopleID: 7, LocalDate: "2026-10-05", DeviceID: "10", DeviceName: "Main Gate" },
];
const catalog = (withDevice) => ["PeopleID", "CardNumber", "EventCategory", "EventDescription", "EventUTCTime",
  ...(withDevice ? ["DeviceID"] : [])]
  .map((name) => ({ tbl: "EventHistory", name, kind: name === "EventUTCTime" ? "datetime" : "int" }))
  .concat([{ tbl: "p_people", name: "EmployeeID", kind: "nvarchar" }, { tbl: "p_people", name: "CardNumber", kind: "int" }])
  .concat(withDevice ? [{ tbl: "HW_Devices", name: "DeviceID", kind: "int" }, { tbl: "HW_Devices", name: "DeviceName", kind: "nvarchar" }] : []);
const seen = [];
const makeQuery = (withDevice = true) => async (sql) => {
  seen.push(sql);
  if (/INFORMATION_SCHEMA/.test(sql)) return catalog(withDevice);
  if (/ROW_NUMBER/.test(sql)) return readerRows;
  return /IsActive/.test(sql) ? roster : swipes;
};
const queryFn = makeQuery();
const NOW = new Date("2026-10-12T09:00:00Z");
const run = (show) => {
  const params = summary.normalize({ mode: "range", start: "2026-10-05", end: "2026-10-09", days: "1,2,3,4,5", show });
  return summary.run(params, { tz: 1, queryFn, now: NOW }).then((rows) => ({ params, rows }));
};
const pick = (rows) => rows.map((r) => [r.firstName, r.lastName, r.presentDays, r.absentDays]);

test("the summary is registered", () => {
  assert.equal(reports.get("attendance-summary"), summary);
});

test("present and absent: everyone on record, both counts, sorted by department then name", async () => {
  const { params, rows } = await run("all");
  assert.deepEqual(pick(rows), [["Chi", "Eze", 0, 5], ["Ada", "Obi", 2, 3], ["Ben", "Nwosu", 1, 4]]);
  assert.deepEqual(rows[1], { cardNumber: 1234, firstName: "Ada", lastName: "Obi", readerName: "Main Gate",
    department: "Ops", presentDays: 2, absentDays: 3 });
  assert.deepEqual(columnsOf(summary, params).map((c) => c.label),
    ["Card no.", "First name", "Last name", "Reader name", "Department", "Present days", "Absent days"]);
});

test("reader name: first reader in the period, DeviceID when unnamed, N/A for no swipes", async () => {
  const { rows } = await run("all");
  assert.deepEqual(rows.map((r) => [r.firstName, r.readerName]), [["Chi", "N/A"], ["Ada", "Main Gate"], ["Ben", "31"]]);
  const sql = seen.find((q) => /ROW_NUMBER/.test(q));
  assert.match(sql, /e\.DeviceID/);
  assert.match(sql, /LEFT JOIN dbo\.HW_Devices AS d/);
});

test("a database without DeviceID shows N/A and never runs the reader query", async () => {
  seen.length = 0;
  const params = summary.normalize({ mode: "range", start: "2026-10-05", end: "2026-10-09", show: "all" });
  const rows = await summary.run(params, { tz: 1, queryFn: makeQuery(false), now: NOW });
  assert.ok(rows.every((r) => r.readerName === "N/A"));
  assert.ok(!seen.some((q) => /ROW_NUMBER/.test(q)));
});

test("present only: only people who came in, and no Absent days column", async () => {
  const { params, rows } = await run("present");
  assert.deepEqual(pick(rows), [["Ada", "Obi", 2, 3], ["Ben", "Nwosu", 1, 4]]);
  assert.ok(!columnsOf(summary, params).some((c) => c.key === "absentDays"));
  assert.match(summary.subtitle(params), /^Days present from 2026-10-05 to 2026-10-09/);
});

test("absent only: only people with an absence, and no Present days column", async () => {
  const { params, rows } = await run("absent");
  assert.equal(rows.length, 3);
  assert.ok(!columnsOf(summary, params).some((c) => c.key === "presentDays"));
  assert.match(String(toCsv(summary, rows, params)), /Card no\.,First name,Last name,Reader name,Department,Absent days/);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await toXlsx(summary, rows, params));
  const text = [];
  book.worksheets[0].eachRow((row) => text.push(row.values.slice(1).join("|")));
  assert.ok(text.some((line) => line.includes("Chi|Eze|N/A|Ops|5")), text.join("\n"));
});

test("an unknown Show value falls back to present and absent", () => {
  assert.equal(summary.normalize({ mode: "single", date: "2026-10-05", show: "bogus" }).show, "all");
});
