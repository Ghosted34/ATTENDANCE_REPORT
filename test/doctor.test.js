import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDoctorReport, classifyColumn, columnTypeSql, isDateShapeError, isError241, isAllowedIdentifier,
  lastNDays, unparseableSql, withDateShapeHint, withError241Hint,
} from "../server/doctor.js";

const CONFIG = {
  connectionString: "Server=192.168.1.10,1433;Database=VIAC;User Id=reports;Password=s3cret!;TrustServerCertificate=True",
  host: "192.168.1.10", port: 1433, database: "VIAC", user: "reports", tzOffsetHours: 1,
};

const DATETIME_TYPES = [
  { tbl: "EventHistory", name: "PeopleID", type: "int" },
  { tbl: "EventHistory", name: "CardNumber", type: "int" },
  { tbl: "EventHistory", name: "EventCategory", type: "int" },
  { tbl: "EventHistory", name: "EventDescription", type: "nvarchar" },
  { tbl: "EventHistory", name: "EventUTCTime", type: "datetime" },
  { tbl: "p_people", name: "PeopleID", type: "int" },
  { tbl: "p_people", name: "Firstname", type: "nvarchar" },
  { tbl: "p_people", name: "Lastname", type: "nvarchar" },
  { tbl: "p_people", name: "Department", type: "nvarchar" },
];

const TEXT_TYPES = DATETIME_TYPES.map((r) => (r.name === "EventUTCTime" ? { ...r, type: "varchar" } : r));
const DATE_TYPES = DATETIME_TYPES.map((r) => (r.name === "EventUTCTime" ? { ...r, type: "date" } : r));

const attendanceRow = {
  LocalDate: "2026-10-01", PeopleID: 7, Firstname: "Ada", Lastname: "Obi", Department: "Ops",
  CardNumber: 1234, FirstEntry: "08:01:02", LastEntry: "17:12:00", DurationMin: 551, AccessCount: 2,
};

// The dry run covers the seven whole local days before today (tz +1): 2026-09-28..2026-10-04.
const TODAY = new Date("2026-10-05T09:00:00Z");

// One row set per statement the doctor is allowed to run; anything else fails the test, which is
// how "read-only, and only the checks it advertises" is pinned down.
const fakeDb = ({ types = DATETIME_TYPES, stats = {}, samples = [], bad = [], reportRows = [], reportError = null, typeProbeError = null } = {}) => {
  const calls = [];
  const queryFn = async (sql, params) => {
    calls.push({ sql, params });
    if (/INFORMATION_SCHEMA\.COLUMNS/.test(sql)) {
      const eventTime = types.find((row) => row.tbl === "EventHistory" && row.name === "EventUTCTime");
      return eventTime ? [{ kind: eventTime.type }] : [];
    }
    if (/sys\.tables/.test(sql)) {
      if (typeProbeError) throw typeProbeError;
      return types;
    }
    if (/ReadableRows/.test(sql)) return [stats];
    if (/SampleTime/.test(sql)) return samples;
    if (/BadValue/.test(sql)) return bad;
    if (/EventCategory/.test(sql)) {
      if (reportError) throw reportError;
      return reportRows;
    }
    throw new Error(`the doctor ran an unexpected statement: ${sql.slice(0, 60)}`);
  };
  return { calls, queryFn };
};

const capture = async (options) => {
  const lines = [];
  const report = await buildDoctorReport({ say: (line) => lines.push(line), ...options });
  return { report, lines, text: report.lines.join("\n") };
};

/* ---------- the checks, read together ---------- */

test("the doctor prints the configuration, the types, the range, the bad rows and a dry run — and never the password", async () => {
  const db = fakeDb({
    types: TEXT_TYPES,
    stats: {
      ReadableRows: 5120,
      MinTime: new Date("2026-09-28T07:12:00Z"),
      MaxTime: new Date("2026-10-04T18:40:00Z"),
      OutOfRange: 0,
    },
    samples: [{ SampleTime: new Date("2026-09-28T07:12:00Z") }, { SampleTime: new Date("2026-09-28T07:15:00Z") }],
    bad: [{ BadValue: "2026-13-45 08:00:00", BadRows: 3 }, { BadValue: "01/01/1900", BadRows: 1 }],
    reportRows: [attendanceRow, { ...attendanceRow, LocalDate: "2026-10-02", PeopleID: 9, Lastname: "Nwosu", Firstname: "Ben" }],
  });
  const { report, text, lines } = await capture({ config: CONFIG, queryFn: db.queryFn, today: TODAY });

  assert.match(text, /Config\s+\.env \(UTC offset 1h\)/);
  assert.match(text, /Connects\s+Server=192\.168\.1\.10,1433;Database=VIAC;User Id=reports;Password=••••;TrustServerCertificate=True/);
  assert.equal(text.includes("s3cret!"), false); // the secret is masked, not merely unlabelled
  assert.equal(CONFIG.connectionString.includes("s3cret!"), true);

  assert.match(text, /EventHistory\s+PeopleID int, CardNumber int, EventCategory int, EventDescription nvarchar, EventUTCTime varchar/);
  assert.match(text, /p_people\s+PeopleID int, Firstname nvarchar, Lastname nvarchar, Department nvarchar/);
  assert.match(text, /Statement\s+reads EventUTCTime \(a varchar column\) through TRY_CONVERT/);
  assert.match(text, /readable as date\/time: 5,120 row\(s\), 2026-09-28 07:12:00 to 2026-10-04 18:40:00/);
  assert.match(text, /Samples\s+2026-09-28 07:12:00, 2026-09-28 07:15:00/);
  assert.match(text, /Unparseable\s+2 value\(s\) cannot be read as a date\/time, most often "2026-13-45 08:00:00" ×3, "01\/01\/1900" ×1/);
  assert.match(text, /Dry run\s+the last 7 days \(2026-09-28\.\.2026-10-04\) returned 2 row\(s\) without an error/);

  assert.equal(report.problems, 1); // the bad rows are the only problem here
  assert.equal(lines.length, report.lines.length);
  assert.equal(db.calls.filter((c) => /^\s*(UPDATE|INSERT|DELETE|DROP|ALTER|EXEC)/i.test(c.sql)).length, 0);
  assert.ok(db.calls.every((c) => /^\s*(SELECT|DECLARE)/i.test(c.sql)));
});

test("a healthy datetime column leaves nothing to fix, and a failing dry run is named for what it is", async () => {
  const healthy = await capture({
    config: CONFIG,
    today: TODAY,
    queryFn: fakeDb({
      stats: { ReadableRows: 10, MinTime: new Date("2026-09-30T07:00:00Z"), MaxTime: new Date("2026-10-04T18:00:00Z"), OutOfRange: 0 },
      reportRows: [attendanceRow],
    }).queryFn,
  });
  assert.equal(healthy.report.problems, 0, healthy.text);
  assert.match(healthy.text, /Statement\s+reads EventUTCTime as a datetime column: the plain column/);
  assert.match(healthy.text, /Unparseable\s+not applicable/);
  assert.match(healthy.text, /Dry run\s+the last 7 days \(2026-09-28\.\.2026-10-04\) returned 1 row\(s\)/);

  // A 241 from the driver on a datetime column — the legacy "text in a datetime-shaped column"
  // situation — is reported as a data problem, not as a bug in the parameters.
  const failing = await capture({
    config: CONFIG,
    today: TODAY,
    queryFn: fakeDb({
      stats: { ReadableRows: 10, MinTime: new Date("1753-01-01T00:00:00Z"), MaxTime: new Date("2026-10-04T18:00:00Z"), OutOfRange: 7 },
      reportError: Object.assign(new Error("Conversion failed when converting date and/or time from character string."), { number: 241 }),
    }).queryFn,
  });
  assert.match(failing.text, /7 row\(s\) fall outside 1900-01-01\.\.2100-01-01/);
  assert.match(failing.text, /Dry run\s+the last 7 days \(2026-09-28\.\.2026-10-04\) failed: Conversion failed/);
  assert.match(failing.text, /error 241 confirmed/);
  assert.ok(failing.report.problems >= 3, failing.text);
});

test("a date-only EventUTCTime uses the safe statement and explains its zero-duration limitation", async () => {
  const db = fakeDb({
    types: DATE_TYPES,
    stats: { ReadableRows: 12, MinTime: new Date("2026-10-01T00:00:00Z"), MaxTime: new Date("2026-10-04T00:00:00Z"), OutOfRange: 0 },
    samples: [{ SampleTime: new Date("2026-10-01T00:00:00Z") }],
    reportRows: [attendanceRow],
  });
  const { report, text } = await capture({ config: CONFIG, queryFn: db.queryFn, today: TODAY });

  assert.equal(classifyColumn("date"), "date");
  assert.equal(report.problems, 0, text);
  assert.match(text, /EventUTCTime date/);
  assert.match(text, /Statement\s+reads the date-only EventUTCTime through TRY_CONVERT\(datetime2\(3\), …\) so DATEADD\(HOUR, …\) has a time-capable type/);
  assert.match(text, /all stored entry times are midnight and DATEDIFF\(MINUTE, …\) is always 0, so duration and last-entry fields display as —/);
  assert.match(text, /Unparseable\s+not applicable: EventUTCTime is a native date column, not character data/);

  // The doctor never asks the character-value diagnostic to RTRIM a native date. The dry run
  // goes through the same datetime2-safe variant the report uses for a date-only column.
  assert.equal(db.calls.some((call) => /BadValue/.test(call.sql)), false);
  const reportSql = db.calls.find((call) => /EventCategory/.test(call.sql));
  assert.match(reportSql.sql, /DECLARE @from DATETIME2\(3\) = DATEADD\(HOUR, -@tz, DATETIME2FROMPARTS/);
  assert.match(reportSql.sql, /TRY_CONVERT\(datetime2\(3\), eh\.EventUTCTime\) >= @from/);
  assert.match(reportSql.sql, /DATEDIFF\(MINUTE, MIN\(TRY_CONVERT\(datetime2\(3\), eh\.EventUTCTime\)\), MAX\(TRY_CONVERT\(datetime2\(3\), eh\.EventUTCTime\)\)\)/);

  const diagnostics = db.calls.filter((call) => /ReadableRows|SampleTime/.test(call.sql));
  assert.equal(diagnostics.length, 2);
  for (const { sql } of diagnostics) {
    assert.doesNotMatch(sql, /DATEADD\s*\(\s*(?:HOUR|MINUTE|SECOND)\s*,/i);
  }
  assert.doesNotMatch(unparseableSql("date"), /DATEADD\s*\(\s*(?:HOUR|MINUTE|SECOND)\s*,/i);
});

/* ---------- the statements and the checks ---------- */

test("every statement is parameterized and only ever looks at the whitelisted identifiers", () => {
  assert.equal(isAllowedIdentifier("EventHistory", "EventUTCTime"), true);
  assert.equal(isAllowedIdentifier("p_people", "Department"), true);
  assert.equal(isAllowedIdentifier("p_people", "Salary"), false);
  assert.equal(isAllowedIdentifier("sys", "sql"), false);
  assert.equal(isAllowedIdentifier("EventHistory", "1; DROP TABLE x--"), false);

  assert.match(columnTypeSql("EventHistory", "EventUTCTime"), /sc\.name = N'EventUTCTime'/);
  assert.throws(() => columnTypeSql("EventHistory", "Shadow"), /not a column this report uses/);
  assert.throws(() => columnTypeSql("EventHistory", "x' OR 1=1--"), /not a column this report uses/);

  const sql = unparseableSql();
  assert.match(sql, /TRY_CONVERT\(datetime2\(3\), eh\.EventUTCTime\) IS NULL/);
  assert.doesNotMatch(sql, /CONVERT\(\s*DATETIME\b/); // no style-dependent date parsing anywhere
  assert.match(unparseableSql("ntext"), /CONVERT\(VARCHAR\(MAX\), eh\.EventUTCTime\)/); // LOB columns need a cast
});

test("the doctor classifies types, names date-shape errors, and dry-runs whole local days", async () => {
  assert.equal(classifyColumn("datetime2"), "datetime");
  assert.equal(classifyColumn("DATETIME"), "datetime");
  assert.equal(classifyColumn("date"), "date");
  assert.equal(classifyColumn("varchar"), "text");
  assert.equal(classifyColumn("char"), "text");
  assert.equal(classifyColumn("uniqueidentifier"), "unknown");
  assert.equal(classifyColumn(null), "missing");

  const conversion = Object.assign(new Error("Conversion failed when converting date and/or time from character string."), { number: 241 });
  assert.equal(isError241(conversion), true);
  assert.equal(isError241({ message: "Microsoft SQL Server: Error 241: ..." }), true);
  assert.equal(isError241({ message: "Msg 241, Level 16, State 1, Server SQL1, Line 1" }), true);
  assert.equal(isError241(new Error("Timeout expired")), false);
  assert.equal(isError241({ message: "Invalid column name 'EventUTCTime'." }), false); // a 208, not a 241
  assert.equal(isError241(undefined), false);

  assert.equal(isDateShapeError({ message: "Microsoft SQL Server: Error 242: out of range" }), true);
  assert.equal(isDateShapeError({ message: "RequestError number: 9810, datepart hour is unsupported for date" }), true);
  assert.equal(isDateShapeError(new Error("Timeout expired")), false);
  const unsupported = Object.assign(new Error("The datepart hour is not supported by date function dateadd for data type date."), {
    number: 9810, code: "EREQUEST",
  });
  const shapeHinted = withDateShapeHint(unsupported);
  assert.match(shapeHinted.message, /SQL Server error 9810/);
  assert.match(shapeHinted.hint, /npm run doctor/);
  assert.equal(shapeHinted.number, 9810);
  assert.equal(shapeHinted.code, "EREQUEST");

  const hinted = withError241Hint(new Error("Msg 241, Level 16"));
  assert.match(hinted.message, /npm run doctor/);
  assert.match(hinted.hint, /column types/i);

  // Nothing to read at all is itself a problem, and it is reported without touching the database.
  const noConfig = await capture({ config: null, queryFn: async () => { throw new Error("must not query"); } });
  assert.match(noConfig.text, /No local database configuration/);
  assert.equal(noConfig.report.problems, 1);

  // The dry run's window: the seven whole days before today, ending yesterday, in the report's
  // own timezone — never a partial "today" that would make a run hard to interpret.
  assert.deepEqual(lastNDays(TODAY, 1, 7), { start: "2026-09-28", end: "2026-10-04" });
  assert.deepEqual(lastNDays(new Date("2026-10-05T23:30:00Z"), 1, 7), { start: "2026-09-28", end: "2026-10-04" });
  assert.deepEqual(lastNDays(new Date("2026-10-05T00:30:00Z"), 1, 7), { start: "2026-09-27", end: "2026-10-03" });
  assert.deepEqual(lastNDays(new Date("2026-01-01T00:30:00Z"), 1, 7), { start: "2025-12-24", end: "2025-12-30" });
  assert.deepEqual(lastNDays(TODAY, 0, 3), { start: "2026-10-02", end: "2026-10-04" });
});
