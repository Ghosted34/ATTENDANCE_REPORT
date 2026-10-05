import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import attendance, {
  columnsFor, exportColumnsFor, isIsoDate, normalizeParams, rangeDays, statementFor, subtitle, TEXT_SAFE_STATEMENT,
} from "../server/reports/attendance.js";
import { isError241 } from "../server/doctor.js";
import { columnsOf, toCsv, toHtml, toXlsx } from "../server/reports/export.js";
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
  { date: "2026-10-05", name: "Obi Ada", idNumber: 7, department: "Ops", cardNumber: 1234,
    firstEntry: "08:01:02", lastEntry: "17:12:00", duration: "9h 11m", accessCount: 2 },
  { date: "2026-10-06", name: "Obi Ada", idNumber: 7, department: "Ops", cardNumber: 1234,
    firstEntry: "07:58:41", lastEntry: "—", duration: "—", accessCount: 1 },
  { date: "2026-10-06", name: "Nwosu Ben", idNumber: 9, department: "Security", cardNumber: 9876,
    firstEntry: "06:30:00", lastEntry: "18:00:00", duration: "11h 30m", accessCount: 4 },
];

// The datetime column a modern installation has: the probe answers, the report returns rows.
const fakeQuery = () => {
  const calls = [];
  const queryFn = async (sql, params) => {
    calls.push({ sql, params });
    return /INFORMATION_SCHEMA\.COLUMNS/.test(sql) ? [{ kind: "datetime" }] : dbRows;
  };
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
    mode: "single", date: "2026-10-05", start: "2026-10-05", end: "2026-10-05", idNumber: "",
  });
  assert.deepEqual(normalizeParams({ mode: "single", date: "2026-10-05", idNumber: "" }), {
    mode: "single", date: "2026-10-05", start: "2026-10-05", end: "2026-10-05", idNumber: "",
  });
  assert.deepEqual(normalizeParams({ mode: "range", start: "2026-10-05", end: "2026-10-07" }), {
    mode: "range", start: "2026-10-05", end: "2026-10-07", idNumber: "",
  });
  assert.deepEqual(normalizeParams({ mode: "range", start: "2026-10-05", end: "2026-10-05" }), {
    mode: "range", start: "2026-10-05", end: "2026-10-05", idNumber: "",
  });
});

test("invalid dates, unknown modes, reversed ranges and bad ID numbers are rejected with 400", () => {
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
  bad({ date: "2026-10-05", idNumber: "7 OR 1=1" }, /ID number can only contain/);
  bad({ date: "2026-10-05", idNumber: "a".repeat(65) }, /ID number can only contain/);
});

test("rangeDays counts both ends", () => {
  assert.equal(rangeDays("2026-10-05", "2026-10-05"), 1);
  assert.equal(rangeDays("2026-10-05", "2026-10-07"), 3);
  assert.equal(rangeDays("2026-12-31", "2027-01-01"), 2);
});

/* ---------- Columns and subtitle ---------- */

test("the screen table is Name, ID number, … and range mode adds Date", () => {
  assert.deepEqual(columnsFor({ mode: "single", date: "2026-10-05" }).map((c) => c.key), [
    "name", "idNumber", "cardNumber", "firstEntry", "lastEntry", "duration", "accessCount",
  ]);
  assert.deepEqual(columnsFor({ mode: "range", start: "2026-10-05", end: "2026-10-07" }).map((c) => c.key), [
    "date", "name", "idNumber", "cardNumber", "firstEntry", "lastEntry", "duration", "accessCount",
  ]);
  assert.equal(columnsFor({})[1].label, "ID number"); // the old "People ID" label is gone
  assert.equal(attendance.columns.some((c) => c.key === "peopleId"), false);
  assert.equal(attendance.columns.length, 7); // legacy shape keeps the single-date columns
});

test("exported columns add Department after the ID number", () => {
  assert.deepEqual(exportColumnsFor({ mode: "single", date: "2026-10-05" }).map((c) => c.key), [
    "name", "idNumber", "department", "cardNumber", "firstEntry", "lastEntry", "duration", "accessCount",
  ]);
  assert.deepEqual(columnsOf(attendance, { mode: "range", start: "2026-10-05", end: "2026-10-07" }).map((c) => c.key), [
    "date", "name", "idNumber", "department", "cardNumber", "firstEntry", "lastEntry", "duration", "accessCount",
  ]);
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

test("SQL is parameterized and the window is bound as integers, so no date is ever parsed from a string", async () => {
  const { calls, queryFn } = fakeQuery();
  await attendance.run({ mode: "range", start: "2026-10-05", end: "2026-10-07" }, { tz: 1, queryFn });

  assert.equal(calls.length, 2); // the column type first, then the report itself
  const { sql } = calls[1];
  assert.match(sql, /@startYmd/);
  assert.match(sql, /@endYmd/);
  assert.match(sql, /@tz/);
  assert.match(sql, /@idNumber/);
  assert.match(sql, /DATEADD\(HOUR, -@tz,/); // UTC window still shifted by the configured offset
  // Grouped per local day, and the day is produced as zero-padded text: no style code, no parsing.
  assert.match(sql, /GROUP BY[\s\S]*CONCAT\(RIGHT\('000' \+ CAST\(YEAR\(DATEADD\(HOUR, @tz, eh\.EventUTCTime\)\) AS VARCHAR\(4\)\), 4\)/);
  assert.doesNotMatch(sql, /CONVERT\(VARCHAR\(10\)|, 23\)/);
  assert.doesNotMatch(sql, /2026-10-05/); // no value is interpolated into the statement

  // The days travel as integers and are rebuilt inside SQL, so there is no character string for
  // the server to parse: neither CONVERT(...,23) nor SET LANGUAGE/SET DATEFORMAT can raise 241.
  assert.deepEqual(calls[1].params, { startYmd: 20261005, endYmd: 20261007, idNumber: "", tz: 1 });
  assert.match(sql, /DATEFROMPARTS\(@startYmd \/ 10000, @startYmd % 10000 \/ 100, @startYmd % 100\)/);
  assert.match(sql, /DATEFROMPARTS\(@endYmd \/ 10000, @endYmd % 10000 \/ 100, @endYmd % 100\)/);
  assert.doesNotMatch(sql, /CONVERT\(\s*DATETIME/);
  assert.doesNotMatch(sql, /TRY_CONVERT\(\s*DATETIME\s*,\s*@/);

  // The UTC window compares the raw column, so an index on it can still be used.
  assert.match(sql, /AND eh\.EventUTCTime >= @from AND eh\.EventUTCTime < @to/);

  // A single date is the same statement with a one-day window.
  const single = fakeQuery();
  await attendance.run({ date: "2026-10-05" }, { tz: 1, queryFn: single.queryFn });
  assert.deepEqual(single.calls[1].params, { startYmd: 20261005, endYmd: 20261005, idNumber: "", tz: 1 });
});

test("the filters never convert, and the optional ID number travels as its own SQL parameter", async () => {
  const { calls, queryFn } = fakeQuery();
  await attendance.run({ date: "2026-10-05", idNumber: " 7 " }, { tz: 1, queryFn });
  const { sql } = calls[1];
  assert.equal(calls[1].params.idNumber, "7"); // trimmed, still a bound parameter
  assert.match(sql, /LTRIM\(RTRIM\(CONVERT\(VARCHAR\(64\), eh\.PeopleID\)\)\) = @idNumber/);
  assert.match(sql, /TRY_CONVERT\(int, eh\.EventCategory\) = 10001/);
  assert.match(sql, /LTRIM\(RTRIM\(CONVERT\(VARCHAR\(64\), eh\.CardNumber\)\)\) <> '0'/);
  assert.doesNotMatch(sql, /eh\.EventCategory = 10001/); // the bare compare would fail on a text column
});

// Runs the report with a chosen answer for the column-type lookup (null = the column is not in
// the catalog at all, "boom" = the lookup itself fails) and hands back the queries it issued.
const runWithColumnType = async (type) => {
  const calls = [];
  const queryFn = async (sql, params) => {
    calls.push({ sql, params });
    if (/INFORMATION_SCHEMA\.COLUMNS/.test(sql)) {
      if (type === "boom") throw new Error("permission denied on INFORMATION_SCHEMA.COLUMNS");
      return type === null ? [] : [{ kind: type }];
    }
    return dbRows;
  };
  await attendance.run({ date: "2026-10-05" }, { tz: 1, queryFn });
  return calls;
};

test("the statement matches the type of the time column: plain column for a real date/time, TRY_CONVERT for text", async () => {
  // A real date/time column is read as it is, so the index on it stays usable.
  const typed = (await runWithColumnType("datetime"))[1];
  assert.match(typed.sql, /AND eh\.EventUTCTime >= @from/);
  assert.equal(typed.sql.includes("TRY_CONVERT(datetime2(3), eh.EventUTCTime)"), false);
  assert.match(typed.sql, /CONCAT\(RIGHT\('000' \+ CAST\(YEAR\(DATEADD\(HOUR, @tz, eh\.EventUTCTime\)\)/);

  // A legacy text column is read through TRY_CONVERT, which skips unparsable values instead of
  // failing the whole run, and the window compares the parsed value, never a raw string.
  const text = (await runWithColumnType("nvarchar"))[1];
  assert.equal(text.sql, statementFor("text"));
  assert.match(text.sql, />= @from/);
  assert.match(text.sql, /TRY_CONVERT\(datetime2\(3\), eh\.EventUTCTime\)/);

  // The lookup is asked once per run, not once per person or per day.
  assert.equal((await runWithColumnType("datetime")).filter((c) => /INFORMATION_SCHEMA/.test(c.sql)).length, 1);
});

test("an unknown, missing or unreadable column type falls back to the text-safe statement", async () => {
  for (const [label, type] of [["unknown type", "uniqueidentifier"], ["no such column", null], ["a failing lookup", "boom"]]) {
    const calls = await runWithColumnType(type);
    assert.equal(calls[1].sql, TEXT_SAFE_STATEMENT, label);
    assert.deepEqual(calls[1].params, { startYmd: 20261005, endYmd: 20261005, idNumber: "", tz: 1 }, label);
  }
});

test("a 241 is rethrown with a pointer at npm run doctor, and other errors are left alone", async () => {
  const failWith = (error) => attendance.run({ date: "2026-10-05" }, {
    tz: 1,
    queryFn: async (sql) => {
      if (/INFORMATION_SCHEMA\.COLUMNS/.test(sql)) return [{ kind: "datetime" }];
      throw error;
    },
  });

  const conversion = Object.assign(new Error("Conversion failed when converting date and/or time from character string."), { number: 241 });
  const err = await failWith(conversion).catch((e) => e);
  assert.match(err.message, /npm run doctor/);
  assert.match(err.hint, /npm run doctor/);
  assert.equal(err.number, 241); // the server's own code survives, so callers can still branch on it

  const timeout = Object.assign(new Error("Timeout: Request failed to complete"), { code: "ETIMEDOUT" });
  assert.equal(await failWith(timeout).catch((e) => e), timeout);
  assert.equal(isError241(timeout), false);
  assert.equal(isError241(conversion), true);
});

test("rows keep one entry per person per local day and carry the date and department", async () => {
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
  assert.equal(out[2].idNumber, 9);
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

test("Excel export follows the export template", async () => {
  const rangeParams = normalizeParams({ mode: "range", start: "2026-10-05", end: "2026-10-07" });
  const rangeBook = new ExcelJS.Workbook();
  await rangeBook.xlsx.load(await toXlsx(attendance, reportRows, rangeParams));
  const rangeSheet = rangeBook.worksheets[0];
  assert.deepEqual(headersOf(rangeSheet, 4), [
    "Date", "Name", "ID number", "Department", "Card no.", "First entry", "Last entry", "Duration", "Swipes",
  ]);
  assert.match(rangeSheet.getRow(2).getCell(1).value, /Attendance from 2026-10-05 to 2026-10-07/);
  assert.equal(rangeSheet.getRow(5).getCell(1).value, "Ops (2)"); // the section heading, now also repeated per row
  assert.equal(rangeSheet.getRow(6).getCell(1).value, "2026-10-05");
  assert.equal(rangeSheet.getRow(6).getCell(4).value, "Ops");

  const singleParams = normalizeParams({ date: "2026-10-05" });
  const singleBook = new ExcelJS.Workbook();
  await singleBook.xlsx.load(await toXlsx(attendance, reportRows, singleParams));
  const headers = headersOf(singleBook.worksheets[0], 4);
  assert.equal(headers.includes("Date"), false);
  assert.equal(headers.includes("Department"), true);
});

test("CSV export uses the same columns, with a BOM for Excel", () => {
  const csv = toCsv(attendance, reportRows, normalizeParams({ mode: "range", start: "2026-10-05", end: "2026-10-07" })).toString("utf8");
  assert.equal(csv.startsWith("\uFEFF"), true);
  const [head, first] = csv.replace(/^\uFEFF/, "").split("\r\n");
  assert.equal(head, "Date,Name,ID number,Department,Card no.,First entry,Last entry,Duration,Swipes");
  assert.equal(first, "2026-10-05,Obi Ada,7,Ops,1234,08:01:02,17:12:00,9h 11m,2");
  assert.equal(csv.includes('"—"'), false); // the em dash needs no quoting
});

test("CSV quotes separators and quotes inside a value", () => {
  const rows = [{ name: 'Ada "The Boss", Obi', department: "Ops,\nNight" }];
  const report = {
    title: "Daily attendance", subtitle: () => "", groupBy: null,
    columns: [{ key: "name", label: "Name" }, { key: "department", label: "Department" }],
  };
  const csv = toCsv(report, rows, {}).toString("utf8").replace(/^\uFEFF/, "");
  assert.equal(csv.split("\r\n")[1], '"Ada ""The Boss"", Obi","Ops,\nNight"');
});

test("HTML (Electron PDF source) export follows the export template", () => {
  const rangeHtml = toHtml(attendance, reportRows, normalizeParams({ mode: "range", start: "2026-10-05", end: "2026-10-07" }), "Reports Desk");
  assert.match(rangeHtml, /<th class="">Date<\/th>/);
  assert.match(rangeHtml, /<th class="">ID number<\/th>/);
  assert.match(rangeHtml, /<th class="">Department<\/th>/);
  assert.match(rangeHtml, /Attendance from 2026-10-05 to 2026-10-07 \(3 days\)/);
  assert.match(rangeHtml, /<td class="">2026-10-06<\/td>/);
  assert.match(rangeHtml, /@page\{size:A4 landscape/); // shared page setup in print-template.js

  const singleHtml = toHtml(attendance, reportRows, normalizeParams({ date: "2026-10-05" }), "Reports Desk");
  assert.doesNotMatch(singleHtml, /<th class="">Date<\/th>/);
  assert.match(singleHtml, /<th class="">Department<\/th>/);
});

test("PDFKit export renders the range report with a Date column", async () => {
  const pdf = await toPdf(attendance, reportRows, normalizeParams({ mode: "range", start: "2026-10-05", end: "2026-10-07" }), "Reports Desk");
  assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
  assert.ok(pdf.length > 1000);
});
