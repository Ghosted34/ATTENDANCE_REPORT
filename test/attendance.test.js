import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import attendance, {
  ABSENCE_SKIP_WEEKENDS, absentRows, columnsFor, daysInPeriod, exportColumnsFor, isIsoDate, isWeekend, localToday,
  MAX_PERIOD_DAYS, monthBounds, normalizeParams, periodParams, rangeDays, readEventTimeType, ROSTER_SQL, runPeriod,
  statementFor, subtitle, TEXT_SAFE_STATEMENT, weekdayOf,
} from "../server/reports/attendance.js";
import absentees, { columnsFor as absenteesColumnsFor } from "../server/reports/absentees.js";
import { classifyColumn, isDateShapeError, isError241 } from "../server/doctor.js";
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

// Active employees (IsActive = 1 in the roster query). Ada and Ben swiped in the range above; Chi
// never did, so Chi is the person the report must list as Absent on every day.
const roster = [
  { PeopleID: 7, Firstname: "Ada", Lastname: "Obi", Department: "Ops" },
  { PeopleID: 9, Firstname: "Ben", Lastname: "Nwosu", Department: "Security" },
  { PeopleID: 11, Firstname: "Chi", Lastname: "Eze", Department: "Ops" },
];

// A fixed "now" (12 Oct 2026 09:00 UTC, i.e. 10:00 in Lagos) so the future-day cut-off is stable.
const NOW = new Date("2026-10-12T09:00:00Z");

// The swipe rows that fall inside the requested window, as the SQL's window predicate would return.
const swipesIn = (params = {}) => dbRows.filter((r) => {
  const ymd = Number(r.LocalDate.replace(/-/g, ""));
  return params.startYmd === undefined || (ymd >= params.startYmd && ymd <= params.endYmd);
});

// The rows the report hands to the UI and the exports, in the order it hands them over:
// by department, then by date. 5 October 2026 is a Monday, the 6th a Tuesday.
const reportRows = [
  { date: "2026-10-05", day: "Monday", name: "Obi Ada", idNumber: 7, department: "Ops", cardNumber: 1234,
    firstEntry: "08:01:02", lastEntry: "17:12:00", duration: "9h 11m", accessCount: 2, status: "Present" },
  { date: "2026-10-06", day: "Tuesday", name: "Obi Ada", idNumber: 7, department: "Ops", cardNumber: 1234,
    firstEntry: "07:58:41", lastEntry: "—", duration: "—", accessCount: 1, status: "Present" },
  { date: "2026-10-06", day: "Tuesday", name: "Nwosu Ben", idNumber: 9, department: "Security", cardNumber: 9876,
    firstEntry: "06:30:00", lastEntry: "18:00:00", duration: "11h 30m", accessCount: 4, status: "Present" },
];

// The datetime column a modern installation has: the probe answers, the report returns rows.
const fakeQuery = () => {
  const calls = [];
  const queryFn = async (sql, params) => {
    calls.push({ sql, params });
    if (/IsActive/.test(sql)) return roster;
    return /INFORMATION_SCHEMA\.COLUMNS/.test(sql) ? [{ kind: "datetime" }] : swipesIn(params);
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

/** Split the argument list of generated SQL function calls without confusing nested calls. */
const functionCalls = (sql, name) => {
  const calls = [];
  const matcher = new RegExp(`\\b${name}\\s*\\(`, "gi");
  let match;
  while ((match = matcher.exec(sql))) {
    const open = sql.indexOf("(", match.index);
    const args = [];
    let depth = 0;
    let inString = false;
    let argStart = open + 1;
    let closed = false;
    for (let i = open + 1; i < sql.length; i += 1) {
      const char = sql[i];
      if (inString) {
        if (char === "'" && sql[i + 1] === "'") { i += 1; continue; }
        if (char === "'") inString = false;
        continue;
      }
      if (char === "'") { inString = true; continue; }
      if (char === "(") { depth += 1; continue; }
      if (char === ")") {
        if (depth > 0) { depth -= 1; continue; }
        args.push(sql.slice(argStart, i).trim());
        closed = true;
        break;
      }
      if (char === "," && depth === 0) {
        args.push(sql.slice(argStart, i).trim());
        argStart = i + 1;
      }
    }
    assert.equal(closed, true, `unclosed ${name}( call`);
    calls.push(args);
  }
  return calls;
};

const assertBalancedSql = (sql) => {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    if (inString) {
      if (char === "'" && sql[i + 1] === "'") { i += 1; continue; }
      if (char === "'") inString = false;
      continue;
    }
    if (char === "'") { inString = true; continue; }
    if (char === "(" ) depth += 1;
    if (char === ")") {
      depth -= 1;
      assert.ok(depth >= 0, "SQL closed a parenthesis before opening it");
    }
  }
  assert.equal(depth, 0, "SQL must have balanced parentheses");
  assert.equal(inString, false, "SQL must have balanced string quotes");
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
  bad({ date: "2026-10-05", idNumber: "7 OR 1=1" }, /Employee ID can only contain/);
  bad({ date: "2026-10-05", idNumber: "a".repeat(65) }, /Employee ID can only contain/);
});

test("rangeDays counts both ends", () => {
  assert.equal(rangeDays("2026-10-05", "2026-10-05"), 1);
  assert.equal(rangeDays("2026-10-05", "2026-10-07"), 3);
  assert.equal(rangeDays("2026-12-31", "2027-01-01"), 2);
});

/* ---------- Columns and subtitle ---------- */

test("the screen table leads with Day (and Date for a longer period), and Department is a column of its own", () => {
  assert.deepEqual(columnsFor({ mode: "single", date: "2026-10-05" }).map((c) => c.key), [
    "day", "name", "idNumber", "department", "status", "cardNumber", "firstEntry", "lastEntry", "duration", "accessCount",
  ]);
  assert.deepEqual(columnsFor({ mode: "range", start: "2026-10-05", end: "2026-10-07" }).map((c) => c.key), [
    "date", "day", "name", "idNumber", "department", "status", "cardNumber", "firstEntry", "lastEntry", "duration", "accessCount",
  ]);
  assert.deepEqual(columnsFor({ mode: "month", month: "2026-10" }).map((c) => c.key), [
    "date", "day", "name", "idNumber", "department", "status", "cardNumber", "firstEntry", "lastEntry", "duration", "accessCount",
  ]);
  // Date and Day are adjacent in both orders, and Day is the first column when there is no Date.
  assert.equal(columnsFor({ mode: "single", date: "2026-10-05" })[0].label, "Day");
  assert.equal(columnsFor({ mode: "month", month: "2026-10" })[1].label, "Day");
  // No period at all (the legacy call): Day still leads, and no Date column is invented.
  assert.deepEqual(columnsFor({}).map((c) => c.label), [
    "Day", "Name", "Employee ID", "Department", "Status", "Card no.", "First entry", "Last entry", "Duration", "Swipes",
  ]);
  assert.equal(attendance.columns.some((c) => c.key === "peopleId"), false);
  assert.equal(attendance.columns.length, 9); // legacy shape: the single-date columns, minus Day/Date
  assert.equal(attendance.columns.some((c) => ["day", "date"].includes(c.key)), false);
});

test("exports carry exactly the screen columns, so nothing has to be inserted into a sheet", () => {
  for (const params of [
    { mode: "single", date: "2026-10-05" },
    { mode: "range", start: "2026-10-05", end: "2026-10-07" },
    { mode: "month", month: "2026-10" },
  ]) {
    const screen = columnsFor(params).map((c) => c.key);
    const exported = exportColumnsFor(params).map((c) => c.key);
    assert.deepEqual(exported, screen, params.mode);
    assert.equal(screen.includes("department"), true, params.mode); // visible on screen, not only in the sheet
    assert.equal(screen.indexOf("day"), screen.indexOf("date") + 1, params.mode);
  }
  assert.deepEqual(exportColumnsFor({ mode: "single", date: "2026-10-05" }).map((c) => c.key), [
    "day", "name", "idNumber", "department", "status", "cardNumber", "firstEntry", "lastEntry", "duration", "accessCount",
  ]);
  assert.deepEqual(exportColumnsFor({ mode: "range", start: "2026-10-05", end: "2026-10-07" }).map((c) => c.key), [
    "date", "day", "name", "idNumber", "department", "status", "cardNumber", "firstEntry", "lastEntry", "duration", "accessCount",
  ]);
});

test("subtitle names the day (with its weekday), the range or the month, and its length", () => {
  // A single date has no Date column, so the weekday is named in the subtitle.
  assert.equal(subtitle({ mode: "single", date: "2026-10-05" }), "Attendance for 2026-10-05 (Monday)");
  assert.equal(subtitle({ date: "2026-10-05" }), "Attendance for 2026-10-05 (Monday)");
  assert.equal(subtitle({ date: "2026-10-11" }), "Attendance for 2026-10-11 (Sunday)");
  assert.equal(subtitle({ date: "" }), "Attendance for "); // nothing to name: never an Invalid Date
  assert.equal(subtitle({ mode: "range", start: "2026-10-05", end: "2026-10-07" }),
    "Attendance from 2026-10-05 to 2026-10-07 (3 days)");
  assert.equal(subtitle({ mode: "range", start: "2026-10-05", end: "2026-10-05" }),
    "Attendance from 2026-10-05 to 2026-10-05 (1 day)");
  assert.equal(subtitle({ mode: "month", month: "2026-02" }),
    "Attendance for February 2026 (2026-02-01 to 2026-02-28, 28 days)");
});

test("the Day column names each row's weekday in every period, and the absentee report has it too", async () => {
  const { queryFn } = fakeQuery();
  const single = await attendance.run({ date: "2026-10-05" }, { tz: 1, queryFn, now: NOW });
  assert.deepEqual(single.map((r) => [r.date, r.day, r.status]), [
    ["2026-10-05", "Monday", "Present"], // Ops: Ada swiped, Chi did not
    ["2026-10-05", "Monday", "Absent"],
    ["2026-10-05", "Monday", "Absent"], // Security: Ben did not
  ]);

  const range = await attendance.run({ mode: "range", start: "2026-10-05", end: "2026-10-07" }, { tz: 1, queryFn, now: NOW });
  const weekdays = { "2026-10-05": "Monday", "2026-10-06": "Tuesday", "2026-10-07": "Wednesday" };
  assert.equal(range.length > 0, true);
  for (const row of range) assert.equal(row.day, weekdays[row.date], `${row.date} is a ${weekdays[row.date]}`);

  // The absentee report leaves out the swipe columns, but keeps the same period columns.
  const absenteeRows = await absentees.run({ mode: "range", start: "2026-10-05", end: "2026-10-07" }, { tz: 1, queryFn, now: NOW });
  assert.equal(absenteeRows.every((r) => r.status === "Absent"), true);
  assert.deepEqual(absenteeRows.map((r) => [r.date, r.day]).slice(0, 2), [["2026-10-05", "Monday"], ["2026-10-06", "Tuesday"]]);
  assert.deepEqual(absenteesColumnsFor({ mode: "single", date: "2026-10-05" }).map((c) => c.key),
    ["day", "name", "idNumber", "department"]);
  assert.deepEqual(absenteesColumnsFor({ mode: "month", month: "2026-10" }).map((c) => c.key),
    ["date", "day", "name", "idNumber", "department"]);
});

test("rows run by department and date, and on each day the present people come before the absentees", async () => {
  const { queryFn } = fakeQuery();
  const rows = await attendance.run({ mode: "range", start: "2026-10-05", end: "2026-10-07" }, { tz: 1, queryFn, now: NOW });

  // Ops first with its three days in order; Ada's swipes before Chi's absences on each of them,
  // and on a day nobody swiped the two absences are alphabetical.
  assert.deepEqual(rows.map((r) => [r.department, r.date, r.status, r.name]), [
    ["Ops", "2026-10-05", "Present", "Obi Ada"],
    ["Ops", "2026-10-05", "Absent", "Eze Chi"],
    ["Ops", "2026-10-06", "Present", "Obi Ada"],
    ["Ops", "2026-10-06", "Absent", "Eze Chi"],
    ["Ops", "2026-10-07", "Absent", "Eze Chi"],
    ["Ops", "2026-10-07", "Absent", "Obi Ada"],
    ["Security", "2026-10-05", "Absent", "Nwosu Ben"],
    ["Security", "2026-10-06", "Present", "Nwosu Ben"],
    ["Security", "2026-10-07", "Absent", "Nwosu Ben"],
  ]);

  // The same rule read as properties: grouped by department, dated inside it, Present first each day.
  const sections = Map.groupBy(rows, (r) => r.department);
  assert.deepEqual([...sections.keys()], ["Ops", "Security"]);
  for (const [department, section] of sections) {
    const dates = section.map((r) => r.date);
    assert.deepEqual(dates, [...dates].sort(), `${department} runs by date`);
    for (const [date, day] of Map.groupBy(section, (r) => r.date)) {
      const statuses = day.map((r) => r.status);
      const lastPresent = statuses.lastIndexOf("Present");
      const firstAbsent = statuses.indexOf("Absent");
      if (lastPresent >= 0 && firstAbsent >= 0) {
        assert.ok(lastPresent < firstAbsent, `${department} ${date}: no Present row after an Absent one (${statuses})`);
      }
      assert.equal(new Set(day.map((r) => r.name)).size, day.length, `${department} ${date} has one row per person`);
    }
  }
});

test("the weekday comes from the calendar date alone, so leap days and month boundaries cannot shift it", () => {
  assert.equal(weekdayOf("2026-10-05"), "Monday");
  assert.equal(weekdayOf("2028-02-29"), "Tuesday"); // a leap day
  assert.equal(weekdayOf("2026-12-31"), "Thursday");
  assert.equal(weekdayOf("2027-01-01"), "Friday");
  // Whatever the machine's clock and time zone think, a whole month always names its 30/31 days.
  for (const date of daysInPeriod("2026-10-01", "2026-10-31")) {
    assert.equal(isWeekend(date), ["Saturday", "Sunday"].includes(weekdayOf(date)), date);
  }
  assert.equal(new Set(daysInPeriod("2026-10-01", "2026-10-31").map(weekdayOf)).size, 7);
});

/* ---------- Query ---------- */

test("SQL is parameterized and the window is bound as integers, so no date is ever parsed from a string", async () => {
  const { calls, queryFn } = fakeQuery();
  await attendance.run({ mode: "range", start: "2026-10-05", end: "2026-10-07" }, { tz: 1, queryFn });

  assert.equal(calls.length, 3); // the column type first, then the swipes, then the roster
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
  assert.match(sql, /DATETIMEFROMPARTS\(@startYmd \/ 10000, @startYmd % 10000 \/ 100, @startYmd % 100, 0, 0, 0, 0\)/);
  assert.match(sql, /DATETIMEFROMPARTS\(@endYmd \/ 10000, @endYmd % 10000 \/ 100, @endYmd % 100, 0, 0, 0, 0\)/);
  assert.doesNotMatch(sql, /CONVERT\(\s*DATETIME/);
  assert.doesNotMatch(sql, /TRY_CONVERT\(\s*DATETIME\s*,\s*@/);

  // The UTC window compares the raw column, so an index on it can still be used.
  assert.match(sql, /AND eh\.EventUTCTime >= @from AND eh\.EventUTCTime < @to/);

  // A single date is the same statement with a one-day window.
  const single = fakeQuery();
  await attendance.run({ date: "2026-10-05" }, { tz: 1, queryFn: single.queryFn });
  assert.deepEqual(single.calls[1].params, { startYmd: 20261005, endYmd: 20261005, idNumber: "", tz: 1 });
});

test("both SQL variants build time-capable windows with documented function arities", () => {
  const variants = [
    { kind: "datetime", sql: statementFor("datetime"), builder: "DATETIMEFROMPARTS", arity: 7 },
    { kind: "text", sql: statementFor("text"), builder: "DATETIME2FROMPARTS", arity: 8 },
  ];

  for (const { kind, sql, builder, arity } of variants) {
    assertBalancedSql(sql);
    if (kind === "datetime") {
      assert.match(sql, /DECLARE @from DATETIME = DATEADD\(HOUR, -@tz, DATETIMEFROMPARTS\(/);
      assert.match(sql, /DECLARE @to\s+DATETIME = DATEADD\(DAY, 1, DATEADD\(HOUR, -@tz, DATETIMEFROMPARTS\(/);
    } else {
      assert.match(sql, /DECLARE @from DATETIME2\(3\) = DATEADD\(HOUR, -@tz, DATETIME2FROMPARTS\(/);
      assert.match(sql, /DECLARE @to\s+DATETIME2\(3\) = DATEADD\(DAY, 1, DATEADD\(HOUR, -@tz, DATETIME2FROMPARTS\(/);
    }

    // Each window boundary is built twice (start and end) with the documented SQL Server arity.
    const builderCalls = functionCalls(sql, builder);
    assert.equal(builderCalls.length, 2, kind);
    assert.ok(builderCalls.every((args) => args.length === arity), `${builder} must take ${arity} arguments`);
    assert.equal(functionCalls(sql, "DATEFROMPARTS").length, 0, "a date-only value cannot be shifted by HOUR");

    // Every HOUR/MINUTE/SECOND DATEADD must receive a type that carries time: the matching
    // window builder, a TRY_CONVERT(datetime2(3)), or the plain date/time column variant.
    const timeAdds = functionCalls(sql, "DATEADD").filter(([datepart]) => /^(HOUR|MINUTE|SECOND)$/i.test(datepart));
    assert.ok(timeAdds.length > 0, `${kind} has time DATEADD expressions`);
    const timeBearingExpression = kind === "datetime"
      ? /^(?:DATETIMEFROMPARTS|eh\.EventUTCTime\b)/i
      : /^(?:DATETIME2FROMPARTS|TRY_CONVERT\s*\(\s*datetime2)/i;
    for (const [, , dateArgument] of timeAdds) {
      assert.doesNotMatch(dateArgument, /^(?:DATEFROMPARTS\s*\(|CAST\s*\([\s\S]*?\s+AS\s+DATE\s*\)|CONVERT\s*\(\s*DATE\b)/i);
      assert.match(dateArgument, timeBearingExpression,
        `time DATEADD must use a time-bearing ${kind} expression, got: ${dateArgument}`);
    }
  }
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
    if (/IsActive/.test(sql)) return roster;
    return swipesIn(params);
  };
  await attendance.run({ date: "2026-10-05" }, { tz: 1, queryFn, now: NOW });
  return calls;
};

test("the statement matches the type of the time column: plain for time-bearing types, TRY_CONVERT for text", async () => {
  // A real datetime column is read as it is, so the index on it stays usable.
  const typed = (await runWithColumnType("datetime"))[1];
  assert.match(typed.sql, /AND eh\.EventUTCTime >= @from/);
  assert.equal(typed.sql.includes("TRY_CONVERT(datetime2(3), eh.EventUTCTime)"), false);
  assert.match(typed.sql, /CONCAT\(RIGHT\('000' \+ CAST\(YEAR\(DATEADD\(HOUR, @tz, eh\.EventUTCTime\)\)/);

  // A legacy text column is read through TRY_CONVERT, which skips unparsable values instead of
  // failing the whole run, and the window compares the parsed value, never a raw string.
  const text = (await runWithColumnType("nvarchar"))[1];
  assert.equal(text.sql, statementFor("text"));
  assert.match(text.sql, /AND TRY_CONVERT\(datetime2\(3\), eh\.EventUTCTime\) >= @from/);
  assert.doesNotMatch(text.sql, /AND eh\.EventUTCTime >= @from/);
  assert.match(text.sql, /TRY_CONVERT\(datetime2\(3\), eh\.EventUTCTime\)/);

  // DATE is date-only, so the doctor classifies it separately and the report must use the
  // text-safe datetime2 expression rather than DATEADD(HOUR, ..., EventUTCTime).
  assert.equal(classifyColumn("date"), "date");
  assert.equal(await readEventTimeType(async () => [{ kind: "date" }]), "date");
  const dateOnly = (await runWithColumnType("date"))[1];
  assert.equal(dateOnly.sql, TEXT_SAFE_STATEMENT);
  assert.match(dateOnly.sql, /AND TRY_CONVERT\(datetime2\(3\), eh\.EventUTCTime\) >= @from/);
  assert.match(dateOnly.sql, /DECLARE @from DATETIME2\(3\) = DATEADD\(HOUR, -@tz, DATETIME2FROMPARTS/);
  assert.doesNotMatch(dateOnly.sql, /AND eh\.EventUTCTime >= @from/);

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

test("SQL date-shape errors 241, 242 and 9810 get the doctor hint without losing driver fields", async () => {
  const failWith = (error) => attendance.run({ date: "2026-10-05" }, {
    tz: 1,
    queryFn: async (sql) => {
      if (/INFORMATION_SCHEMA\.COLUMNS/.test(sql)) return [{ kind: "datetime" }];
      throw error;
    },
  });

  const dateErrors = [
    Object.assign(new Error("Conversion failed when converting date and/or time from character string."), { number: 241, code: "EREQUEST" }),
    Object.assign(new Error("The conversion of a varchar data type to a datetime data type resulted in an out-of-range value."), { number: 242, code: "EREQUEST" }),
    Object.assign(new Error("The datepart hour is not supported by date function dateadd for data type date."), { number: 9810, code: "EREQUEST" }),
  ];
  for (const original of dateErrors) {
    const err = await failWith(original).catch((e) => e);
    assert.equal(err, original); // same driver error object, not a wrapper that drops its fields
    assert.match(err.message, /npm run doctor/);
    assert.match(err.hint, /npm run doctor/);
    assert.equal(err.number, original.number);
    assert.equal(err.code, original.code);
    assert.equal(isDateShapeError(err), true);
    assert.equal(isError241(err), original.number === 241);
  }
  assert.match(dateErrors[2].hint, /9810/);

  const timeout = Object.assign(new Error("Timeout: Request failed to complete"), { code: "ETIMEDOUT" });
  assert.equal(await failWith(timeout).catch((e) => e), timeout);
  assert.equal(isDateShapeError(timeout), false);
  assert.equal(isError241(timeout), false);
});

test("swipe rows keep one entry per person per local day and carry the date and department", async () => {
  const { queryFn } = fakeQuery();
  const out = await attendance.run({ mode: "range", start: "2026-10-05", end: "2026-10-07" }, { tz: 1, queryFn, now: NOW });
  const present = out.filter((r) => r.status === "Present");

  assert.deepEqual(present.map((r) => [r.date, r.name]), [
    ["2026-10-05", "Obi Ada"],
    ["2026-10-06", "Obi Ada"],
    ["2026-10-06", "Nwosu Ben"],
  ]);
  assert.equal(present[0].duration, "9h 11m");
  assert.equal(present[1].duration, "—"); // single swipe on the second day
  assert.equal(present[1].lastEntry, "—");
  assert.equal(present[2].accessCount, 4);
  assert.equal(present[2].department, "Security");
  assert.equal(present[2].idNumber, 9);
});

test("eligible employees with no swipe are listed as Absent on every day of the period", async () => {
  const { queryFn } = fakeQuery();
  const out = await attendance.run({ mode: "range", start: "2026-10-05", end: "2026-10-07" }, { tz: 1, queryFn, now: NOW });

  // Chi never swiped: one Absent row per day, with the absence shown in the swipe columns too.
  const chi = out.filter((r) => r.idNumber === 11);
  assert.deepEqual(chi.map((r) => r.date), ["2026-10-05", "2026-10-06", "2026-10-07"]);
  for (const row of chi) {
    assert.equal(row.status, "Absent");
    assert.equal(row.name, "Eze Chi");
    assert.equal(row.department, "Ops");
    assert.equal(row.accessCount, 0);
    assert.equal(row.cardNumber, "—");
    assert.equal(row.firstEntry, "—");
  }
  // Ada swiped on the 5th and 6th, so only the 7th is absent; Ben swiped on the 6th only.
  assert.deepEqual(out.filter((r) => r.idNumber === 7).map((r) => [r.date, r.status]), [
    ["2026-10-05", "Present"], ["2026-10-06", "Present"], ["2026-10-07", "Absent"],
  ]);
  assert.deepEqual(out.filter((r) => r.idNumber === 9).map((r) => [r.date, r.status]), [
    ["2026-10-05", "Absent"], ["2026-10-06", "Present"], ["2026-10-07", "Absent"],
  ]);
  // One row per person per day: never both Present and Absent for the same day.
  const keys = out.map((r) => `${r.idNumber}|${r.date}`);
  assert.equal(new Set(keys).size, keys.length);
});

test("the roster is the active employees only, by the IsActive flag, and is bound by the same ID filter", () => {
  // IsActive = 1 is the only value that counts; inactive, not-yet-employed or unknown (NULL,
  // unreadable text) people are never marked absent.
  assert.match(ROSTER_SQL, /TRY_CONVERT\(int, pp\.IsActive\) = 1/);
  assert.match(ROSTER_SQL, /FROM dbo\.p_people AS pp/);
  assert.doesNotMatch(ROSTER_SQL, /IsActive\s*(!=|<>|IS NULL)/);
  assert.match(ROSTER_SQL, /@idNumber = '' OR LTRIM\(RTRIM\(CONVERT\(VARCHAR\(64\), pp\.PeopleID\)\)\) = @idNumber/);
  assert.doesNotMatch(ROSTER_SQL, /\d{4}-\d{2}/); // no value is interpolated into the statement
});

test("a person listed twice in the roster is reported once per day", async () => {
  const doubled = [...roster, { PeopleID: 11, Firstname: "Chi", Lastname: "Eze", Department: "Ops" }];
  const queryFn = async (sql) => {
    if (/INFORMATION_SCHEMA/.test(sql)) return [{ kind: "datetime" }];
    if (/IsActive/.test(sql)) return doubled;
    return [];
  };
  const out = await attendance.run({ date: "2026-10-05" }, { tz: 1, queryFn, now: NOW });
  assert.equal(out.filter((r) => r.idNumber === 11).length, 1);
});

test("a future day is never reported absent, for a single date, a range or a month", async () => {
  const empty = async (sql) => (/INFORMATION_SCHEMA/.test(sql) ? [{ kind: "datetime" }] : /IsActive/.test(sql) ? roster : []);
  // Today is 12 Oct (local). Nothing after today may appear.
  const month = await attendance.run({ mode: "month", month: "2026-10" }, { tz: 1, queryFn: empty, now: NOW });
  assert.equal(month.at(-1).date, "2026-10-12");
  assert.equal(month.filter((r) => r.date > "2026-10-12").length, 0);

  const future = await attendance.run({ date: "2026-10-20" }, { tz: 1, queryFn: empty, now: NOW });
  assert.deepEqual(future, []); // a day that has not happened yet has neither swipes nor absences

  const today = await attendance.run({ date: "2026-10-12" }, { tz: 1, queryFn: empty, now: NOW });
  assert.equal(today.length, roster.length); // today is reported, so today's absences are visible
});

test("a single date lists every eligible employee who did not swipe that day", async () => {
  const { queryFn } = fakeQuery();
  const out = await attendance.run({ date: "2026-10-06" }, { tz: 1, queryFn, now: NOW });
  assert.deepEqual(out.map((r) => [r.name, r.status]).sort(), [
    ["Eze Chi", "Absent"], ["Nwosu Ben", "Present"], ["Obi Ada", "Present"],
  ].sort());
  assert.equal(out.length, 3);
});

test("with no eligible employees and no swipes the report is empty, not an error", async () => {
  const queryFn = async (sql) => (/INFORMATION_SCHEMA/.test(sql) ? [{ kind: "datetime" }] : []);
  assert.deepEqual(await attendance.run({ date: "2026-10-05" }, { tz: 1, queryFn, now: NOW }), []);
});

test("absentRows needs no database and respects the cut-off and the weekend setting", () => {
  const people = [{ key: "7", name: "Obi Ada", idNumber: 7, department: "Ops" }];
  const none = new Set();
  // 10 and 11 Oct 2026 are a Saturday and a Sunday; 12 Oct is today.
  const week = absentRows({ start: "2026-10-09", end: "2026-10-13", today: "2026-10-12", roster: people, presentKeys: none });
  assert.deepEqual(week.map((r) => r.date), ["2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12"]);
  assert.equal(week.every((r) => r.status === "Absent"), true);

  const weekdays = absentRows({
    start: "2026-10-09", end: "2026-10-13", today: "2026-10-12", roster: people, presentKeys: none, skipWeekends: true,
  });
  assert.deepEqual(weekdays.map((r) => r.date), ["2026-10-09", "2026-10-12"]);

  const present = absentRows({
    start: "2026-10-09", end: "2026-10-09", today: "2026-10-12", roster: people, presentKeys: new Set(["7|2026-10-09"]),
  });
  assert.deepEqual(present, []);
  assert.equal(ABSENCE_SKIP_WEEKENDS, false); // the default counts every calendar day
});

test("runPeriod returns the swipes and the absences as separate lists", async () => {
  const { queryFn } = fakeQuery();
  const { present, absent } = await runPeriod({ date: "2026-10-05" }, { tz: 1, queryFn, now: NOW });
  assert.deepEqual(present.map((r) => r.name), ["Obi Ada"]);
  assert.deepEqual(absent.map((r) => r.name), ["Eze Chi", "Nwosu Ben"]); // sorted by department, then name
});

test("a failing roster lookup is an error, never a silently empty absence list", async () => {
  const queryFn = async (sql) => {
    if (/INFORMATION_SCHEMA/.test(sql)) return [{ kind: "datetime" }];
    if (/IsActive/.test(sql)) throw Object.assign(new Error("Invalid object name 'dbo.p_people'."), { number: 208 });
    return dbRows;
  };
  await assert.rejects(attendance.run({ date: "2026-10-05" }, { tz: 1, queryFn, now: NOW }), /Invalid object name/);
});

/* ---------- Periods: month, date boundaries and the range cap ---------- */

test("month periods run from the first to the last day of the calendar month", () => {
  assert.deepEqual(monthBounds("2026-02"), { year: 2026, month: 2, start: "2026-02-01", end: "2026-02-28" });
  assert.equal(monthBounds("2028-02").end, "2028-02-29"); // leap year
  assert.equal(monthBounds("2026-12").end, "2026-12-31");
  assert.equal(monthBounds("2026-04").end, "2026-04-30");
  assert.equal(monthBounds("1900-02").end, "1900-02-28"); // not a leap year
  assert.equal(monthBounds("2000-02").end, "2000-02-29"); // a leap century
  assert.equal(monthBounds("2026-13"), null);
  assert.equal(monthBounds("2026-00"), null);
  assert.equal(monthBounds("2026-1"), null);
  assert.equal(monthBounds("2026-10-01"), null);
  assert.equal(monthBounds("1899-12"), null);
  assert.equal(monthBounds(""), null);
  assert.equal(monthBounds(undefined), null);
});

test("a month is normalized to the same inclusive window the other periods use", () => {
  assert.deepEqual(normalizeParams({ mode: "month", month: "2026-10" }), {
    mode: "month", month: "2026-10", start: "2026-10-01", end: "2026-10-31", idNumber: "",
  });
  assert.deepEqual(normalizeParams({ mode: "month", month: "2028-02", idNumber: "7" }), {
    mode: "month", month: "2028-02", start: "2028-02-01", end: "2028-02-29", idNumber: "7",
  });
  for (const bad of ["2026-13", "2026-1", "2026-10-01", "", undefined]) {
    assert.throws(() => normalizeParams({ mode: "month", month: bad }),
      (e) => e.status === 400 && /valid month/.test(e.message), String(bad));
  }
});

test("a month's window is bound as integers (first and last day) through the normal SQL", async () => {
  const { calls, queryFn } = fakeQuery();
  await attendance.run({ mode: "month", month: "2028-02" }, { tz: 1, queryFn, now: new Date("2029-01-01T00:00:00Z") });
  assert.deepEqual(calls[1].params, { startYmd: 20280201, endYmd: 20280229, idNumber: "", tz: 1 });
});

test("date boundaries: the first and last day are both included, the day after is not", () => {
  assert.deepEqual(daysInPeriod("2026-10-31", "2026-11-01"), ["2026-10-31", "2026-11-01"]);
  assert.deepEqual(daysInPeriod("2026-12-31", "2027-01-01"), ["2026-12-31", "2027-01-01"]);
  assert.deepEqual(daysInPeriod("2026-10-05", "2026-10-05"), ["2026-10-05"]);
  assert.deepEqual(daysInPeriod("2026-10-06", "2026-10-05"), []);
  assert.equal(daysInPeriod("2028-02-01", "2028-02-29").length, 29);
  const leap = absentRows({
    start: "2028-02-28", end: "2028-03-01", today: "2030-01-01",
    roster: [{ key: "1", name: "A", idNumber: 1, department: "x" }], presentKeys: new Set(),
  });
  assert.deepEqual(leap.map((r) => r.date), ["2028-02-28", "2028-02-29", "2028-03-01"]);
});

test("the local day for the cut-off follows the configured offset, not the machine clock", () => {
  // 23:30 UTC on the 4th is already the 5th in Lagos (UTC+1).
  assert.equal(localToday(new Date("2026-10-04T23:30:00Z"), 1), "2026-10-05");
  assert.equal(localToday(new Date("2026-10-04T23:30:00Z"), 0), "2026-10-04");
  assert.equal(localToday(new Date("2026-10-04T23:30:00Z"), -5), "2026-10-04");
});

test("weekends are worked out from the calendar date alone", () => {
  assert.equal(isWeekend("2026-10-10"), true); // Saturday
  assert.equal(isWeekend("2026-10-11"), true); // Sunday
  assert.equal(isWeekend("2026-10-12"), false); // Monday
});

test("a range longer than the cap is refused before SQL runs", async () => {
  assert.equal(MAX_PERIOD_DAYS, 366);
  assert.equal(normalizeParams({ mode: "range", start: "2026-01-01", end: "2026-12-31" }).end, "2026-12-31"); // 365 days
  const { calls, queryFn } = fakeQuery();
  await assert.rejects(
    attendance.run({ mode: "range", start: "2025-01-01", end: "2026-12-31" }, { tz: 1, queryFn }),
    (e) => e.status === 400 && /at most 366 days/.test(e.message),
  );
  assert.equal(calls.length, 0);
});

test("the form offers single date, date range and month, with a month input for the month", () => {
  const modes = periodParams.find((p) => p.name === "mode");
  assert.deepEqual(modes.options.map((o) => o.value), ["single", "range", "month"]);
  assert.deepEqual(periodParams.find((p) => p.name === "month"), { name: "month", label: "Month", type: "month", mode: "month" });
  assert.equal(periodParams.find((p) => p.name === "idNumber").label, "Employee ID");
});

test("no user-facing source or documentation still says 'ID number' or 'People ID'", () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const files = [
    "README.md",
    "renderer/app/js/app.js", "renderer/app/js/template.js", "renderer/app/index.html", "renderer/setup/setup.html",
    "server/reports/attendance.js", "server/reports/absentees.js", "server/reports/export.js", "server/reports/pdf.js",
    "server/reports/print-template.js", "server/doctor.js",
  ];
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    // The SQL column PeopleID stays as it is; only the labels and the old report key are checked.
    assert.doesNotMatch(text, /ID number|People ID/i, file);
    assert.doesNotMatch(text, /\bpeopleId\b/, file);
  }
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
    "Date", "Day", "Name", "Employee ID", "Department", "Status", "Card no.", "First entry", "Last entry", "Duration", "Swipes",
  ]);
  assert.match(rangeSheet.getRow(2).getCell(1).value, /Attendance from 2026-10-05 to 2026-10-07/);
  assert.equal(rangeSheet.getRow(5).getCell(1).value, "Ops (2)"); // the section heading, now also repeated per row
  assert.equal(rangeSheet.getRow(6).getCell(1).value, "2026-10-05");
  assert.equal(rangeSheet.getRow(6).getCell(2).value, "Monday");
  assert.equal(rangeSheet.getRow(6).getCell(5).value, "Ops");

  const singleParams = normalizeParams({ date: "2026-10-05" });
  const singleBook = new ExcelJS.Workbook();
  await singleBook.xlsx.load(await toXlsx(attendance, reportRows, singleParams));
  const headers = headersOf(singleBook.worksheets[0], 4);
  assert.equal(headers.includes("Date"), false);
  assert.equal(headers[0], "Day"); // the single date's weekday still starts the row
  assert.equal(headers.includes("Department"), true);
});

test("CSV export uses the same columns, with a BOM for Excel", () => {
  const csv = toCsv(attendance, reportRows, normalizeParams({ mode: "range", start: "2026-10-05", end: "2026-10-07" })).toString("utf8");
  assert.equal(csv.startsWith("\uFEFF"), true);
  const [head, first] = csv.replace(/^\uFEFF/, "").split("\r\n");
  assert.equal(head, "Date,Day,Name,Employee ID,Department,Status,Card no.,First entry,Last entry,Duration,Swipes");
  assert.equal(first, "2026-10-05,Monday,Obi Ada,7,Ops,Present,1234,08:01:02,17:12:00,9h 11m,2");
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
  assert.match(rangeHtml, /<th class="">Day<\/th>/);
  assert.match(rangeHtml, /<th class="">Employee ID<\/th>/);
  assert.match(rangeHtml, /<th class="">Status<\/th>/);
  assert.match(rangeHtml, /<th class="">Department<\/th>/);
  assert.match(rangeHtml, /Attendance from 2026-10-05 to 2026-10-07 \(3 days\)/);
  assert.match(rangeHtml, /<td class="">2026-10-06<\/td><td class="">Tuesday<\/td>/); // date, then its weekday
  assert.match(rangeHtml, /@page\{size:A4 landscape/); // shared page setup in print-template.js

  const singleHtml = toHtml(attendance, reportRows, normalizeParams({ date: "2026-10-05" }), "Reports Desk");
  assert.doesNotMatch(singleHtml, /<th class="">Date<\/th>/);
  assert.match(singleHtml, /<th class="">Day<\/th>/);
  assert.match(singleHtml, /<th class="">Department<\/th>/);
  assert.match(singleHtml, /Attendance for 2026-10-05 \(Monday\)/);
});

test("PDFKit export renders the range report with a Date column", async () => {
  const pdf = await toPdf(attendance, reportRows, normalizeParams({ mode: "range", start: "2026-10-05", end: "2026-10-07" }), "Reports Desk");
  assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
  assert.ok(pdf.length > 1000);
});
