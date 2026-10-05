import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import attendance, { columnsFor, isIsoDate, normalizeParams, rangeDays, subtitle } from "../server/reports/attendance.js";
import { columnsOf, toHtml, toXlsx } from "../server/reports/export.js";
import { toPdf } from "../server/reports/pdf.js";

// Two people, two local days: the range query returns one row per person per day.
const dbRows = [
  { LocalDate: "2026-10-05", PeopleID: 7, Firstname: "Ada", Lastname: "Obi", Department: "Ops",
    CardNumber: 1234, FirstEntry: "08:01:02", LastEntry: "17:12:00", DurationMin: 551, AccessCount: 2 },
  { LocalDate: "2026-10-06", PeopleID: 7, Firstname: "Ada", Lastname: "Obi", Department: "Ops",
    CardNumber: 1234, FirstEntry: "07:58:41", LastEntry: "07:58:41", DurationMin: 0, AccessCount: 1 },
  { LocalDate: "2026-10-06", PeopleID: 9, Firstname: "Ben", Lastname: "Nwosu", Department: "Security",
    CardNumber: 9876, FirstEntry: "06:30:00", LastEntry: "18:00:00", DurationMin: 690, AccessCount: 4 },
];

// The rows the report hands to the UI and the exports.
const reportRows = [
  { date: "2026-10-05", name: "Obi Ada", peopleId: 7, department: "Ops", cardNumber: 1234,
    firstEntry: "08:01:02", lastEntry: "17:12:00", duration: "9h 11m", accessCount: 2 },
  { date: "2026-10-06", name: "Obi Ada", peopleId: 7, department: "Ops", cardNumber: 1234,
    firstEntry: "07:58:41", lastEntry: "—", duration: "—", accessCount: 1 },
  { date: "2026-10-06", name: "Nwosu Ben", peopleId: 9, department: "Security", cardNumber: 9876,
    firstEntry: "06:30:00", lastEntry: "18:00:00", duration: "11h 30m", accessCount: 4 },
];

const fakeQuery = () => {
  const calls = [];
  const queryFn = async (sql, params) => { calls.push({ sql, params }); return dbRows; };
  return { calls, queryFn };
};

const captureThrow = (fn) => {
  try { fn(); } catch (error) { return error; }
  throw new Error("Expected the call to throw.");
};

const headersOf = (ws, rowNumber) => {
  const headers = [];
  ws.getRow(rowNumber).eachCell((cell) => headers.push(cell.value));
  return headers;
};

/* ---------- Validation ---------- */

test("isIsoDate accepts real calendar days only", () => {
  assert.equal(isIsoDate("2026-10-05"), true);
  assert.equal(isIsoDate("2028-02-29"), true); // leap year
  assert.equal(isIsoDate("2026-02-29"), false); // not a leap year
  assert.equal(isIsoDate("2026-02-31"), false); // Date.parse() would roll this over
  assert.equal(isIsoDate("2026-13-01"), false);
  assert.equal(isIsoDate("2026-10-5"), false); // must be zero padded
  assert.equal(isIsoDate("05/10/2026"), false);
  assert.equal(isIsoDate(""), false);
  assert.equal(isIsoDate(undefined), false);
  assert.equal(isIsoDate(20261005), false);
});

test("single date is the default and both modes only cover one local day each", () => {
  assert.deepEqual(normalizeParams({ date: "2026-10-05" }), {
    mode: "single", date: "2026-10-05", start: "2026-10-05", end: "2026-10-05",
  });
  assert.deepEqual(normalizeParams({ mode: "single", date: "2026-10-05" }), {
    mode: "single", date: "2026-10-05", start: "2026-10-05", end: "2026-10-05",
  });
  assert.deepEqual(normalizeParams({ mode: "range", start: "2026-10-05", end: "2026-10-07" }), {
    mode: "range", start: "2026-10-05", end: "2026-10-07",
  });
  assert.deepEqual(normalizeParams({ mode: "range", start: "2026-10-05", end: "2026-10-05" }), {
    mode: "range", start: "2026-10-05", end: "2026-10-05",
  });
});

test("invalid dates, unknown modes and reversed ranges are rejected with 400", () => {
  const bad = (values, expected) => {
    const error = captureThrow(() => normalizeParams(values));
    assert.equal(error.status, 400);
    assert.match(error.message, expected);
  };
  bad({ date: "2026-02-31" }, /valid date/);
  bad({ mode: "single", date: "" }, /valid date/);
  bad({ mode: "range", start: "2026-10-05", end: "2026-10-01" }, /on or before/);
  bad({ mode: "range", start: "2026-10-05", end: "2026-10-05x" }, /valid start date and end date/);
  bad({ mode: "range", start: "2026-10-05" }, /valid start date and end date/);
  bad({ mode: "daily", date: "2026-10-05" }, /Single date/);
});

test("rangeDays counts both ends", () => {
  assert.equal(rangeDays("2026-10-05", "2026-10-05"), 1);
  assert.equal(rangeDays("2026-10-05", "2026-10-07"), 3);
  assert.equal(rangeDays("2026-12-31", "2027-01-01"), 2);
});

/* ---------- Columns and subtitle ---------- */

test("the Date column appears in range mode only, ahead of the existing columns", () => {
  assert.deepEqual(columnsFor({ mode: "single", date: "2026-10-05" }).map((c) => c.key), [
    "name", "peopleId", "cardNumber", "firstEntry", "lastEntry", "duration", "accessCount",
  ]);
  assert.deepEqual(columnsFor({ mode: "range", start: "2026-10-05", end: "2026-10-07" }).map((c) => c.key), [
    "date", "name", "peopleId", "cardNumber", "firstEntry", "lastEntry", "duration", "accessCount",
  ]);
  assert.equal(columnsFor({}).some((c) => c.key === "date"), false); // default stays single
  assert.equal(attendance.columns.length, 7); // legacy shape keeps the single-date columns
  assert.equal(columnsOf(attendance, { mode: "range", start: "a", end: "b" })[0].label, "Date");
});

test("subtitle names the day or the range and its length", () => {
  assert.equal(subtitle({ mode: "single", date: "2026-10-05" }), "Attendance for 2026-10-05");
  assert.equal(subtitle({ date: "2026-10-05" }), "Attendance for 2026-10-05");
  assert.equal(subtitle({ mode: "range", start: "2026-10-05", end: "2026-10-07" }),
    "Attendance from 2026-10-05 to 2026-10-07 (3 days)");
  assert.equal(subtitle({ mode: "range", start: "2026-10-05", end: "2026-10-05" }),
    "Attendance from 2026-10-05 to 2026-10-05 (1 day)");
});

/* ---------- Query ---------- */

test("SQL is parameterized and derives the UTC window from the local dates", async () => {
  const { calls, queryFn } = fakeQuery();
  await attendance.run({ mode: "range", start: "2026-10-05", end: "2026-10-07" }, { tz: 1, queryFn });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, { start: "2026-10-05", end: "2026-10-07", tz: 1 });
  const { sql } = calls[0];
  assert.match(sql, /@start/);
  assert.match(sql, /@end/);
  assert.match(sql, /@tz/);
  assert.match(sql, /DATEADD\(HOUR, -@tz,/); // UTC window still shifted by the configured offset
  assert.match(sql, /GROUP BY[\s\S]*CONVERT\(VARCHAR\(10\), DATEADD\(HOUR, @tz, eh\.EventUTCTime\), 23\)/);
  assert.doesNotMatch(sql, /2026-10-05/); // no value is interpolated into the statement
});

test("rows keep one entry per person per local day and carry the date", async () => {
  const { queryFn } = fakeQuery();
  const out = await attendance.run({ mode: "range", start: "2026-10-05", end: "2026-10-07" }, { tz: 1, queryFn });

  assert.deepEqual(out.map((r) => [r.date, r.name]), [
    ["2026-10-05", "Obi Ada"],
    ["2026-10-06", "Obi Ada"],
    ["2026-10-06", "Nwosu Ben"],
  ]);
  assert.equal(out[0].duration, "9h 11m");
  assert.equal(out[1].duration, "—"); // single swipe on the second day
  assert.equal(out[1].lastEntry, "—");
  assert.equal(out[2].accessCount, 4);
  assert.equal(out[2].department, "Security");
  assert.equal(out[2].peopleId, 9);
});

test("invalid input is rejected before any SQL runs", async () => {
  const { calls, queryFn } = fakeQuery();
  await assert.rejects(
    attendance.run({ mode: "range", start: "2026-10-07", end: "2026-10-05" }, { tz: 1, queryFn }),
    /on or before/,
  );
  await assert.rejects(attendance.run({ date: "nope" }, { tz: 1, queryFn }), /valid date/);
  assert.equal(calls.length, 0);
});

/* ---------- Exports ---------- */

test("Excel export follows the mode's columns", async () => {
  const rangeParams = normalizeParams({ mode: "range", start: "2026-10-05", end: "2026-10-07" });
  const rangeBook = new ExcelJS.Workbook();
  await rangeBook.xlsx.load(await toXlsx(attendance, reportRows, rangeParams));
  const rangeSheet = rangeBook.worksheets[0];
  assert.deepEqual(headersOf(rangeSheet, 4), [
    "Date", "Name", "People ID", "Card no.", "First entry", "Last entry", "Duration", "Swipes",
  ]);
  assert.match(rangeSheet.getRow(2).getCell(1).value, /Attendance from 2026-10-05 to 2026-10-07/);
  assert.equal(rangeSheet.getRow(7).getCell(1).value, "2026-10-06");

  const singleParams = normalizeParams({ date: "2026-10-05" });
  const singleBook = new ExcelJS.Workbook();
  await singleBook.xlsx.load(await toXlsx(attendance, reportRows, singleParams));
  assert.equal(headersOf(singleBook.worksheets[0], 4).includes("Date"), false);
});

test("HTML (Electron PDF source) export follows the mode's columns", () => {
  const rangeHtml = toHtml(attendance, reportRows, normalizeParams({ mode: "range", start: "2026-10-05", end: "2026-10-07" }), "Reports Desk");
  assert.match(rangeHtml, /<th class="">Date<\/th>/);
  assert.match(rangeHtml, /Attendance from 2026-10-05 to 2026-10-07 \(3 days\)/);
  assert.match(rangeHtml, /<td class="">2026-10-06<\/td>/);

  const singleHtml = toHtml(attendance, reportRows, normalizeParams({ date: "2026-10-05" }), "Reports Desk");
  assert.doesNotMatch(singleHtml, /<th class="">Date<\/th>/);
});

test("PDFKit export renders the range report with a Date column", async () => {
  const pdf = await toPdf(attendance, reportRows, normalizeParams({ mode: "range", start: "2026-10-05", end: "2026-10-07" }), "Reports Desk");
  assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
  assert.ok(pdf.length > 1000);
});
