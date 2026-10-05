import path from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "./brand.js";
import { maskConnectionString } from "./config.js";
import { query } from "./db/pool.js";

/**
 * `npm run doctor` — a read-only explanation of why the attendance report fails, for the
 * SQL Server error 241 family in particular ("conversion of a character string to a date/time
 * produced an out-of-range or unparsable value").
 *
 * It prints the masked connection string, the real column types, the time column's range and a
 * few samples, the rows whose text cannot be read as a date/time, and a 7-day report dry run.
 *
 * Two rules are deliberate:
 *  - every identifier it looks for comes from the allowlists below, which are *matched*, never
 *    taken from user input, so there is nothing to inject;
 *  - everything sent to SQL Server is a bound parameter and every statement is a SELECT, so the
 *    doctor cannot be turned into a way of changing the database.
 */

export const EVENT_TABLE = "EventHistory";
export const PEOPLE_TABLE = "p_people";
export const TIME_COLUMN = "EventUTCTime";

/**
 * The only columns this app reads, and the allowlist the doctor will look up. The report module
 * imports these, so a check here describes exactly what a report run touches — and nothing can
 * be added to a statement through them, because they are constants rather than input.
 */
export const EVENT_COLUMNS = Object.freeze(["PeopleID", "CardNumber", "EventCategory", "EventDescription", TIME_COLUMN]);
export const PEOPLE_COLUMNS = Object.freeze(["PeopleID", "Firstname", "Lastname", "Department"]);

/** Column types as declared in the catalog, grouped the way the report needs them. */
const DATETIME_TYPES = new Set(["datetime", "datetime2", "smalldatetime", "date"]);
const TEXT_TYPES = new Set(["varchar", "nvarchar", "char", "nchar", "text", "ntext"]);

/**
 * "datetime" for a real date/time column, "text" for a character column, "missing" when the
 * lookup returned nothing and "unknown" for a type the report does not know (treated as text).
 */
export function classifyColumn(type) {
  const name = String(type ?? "").toLowerCase().trim();
  if (!name) return "missing";
  if (DATETIME_TYPES.has(name)) return "datetime";
  if (TEXT_TYPES.has(name)) return "text";
  return "unknown";
}

/** "EventUTCTime datetime" / "EventUTCTime (column not found)", for the printed report. */
export const describeColumn = (name, type) => `${name} ${type ?? "(column not found)"}`;

/** Only the columns this app already knows about may be looked up in the catalog. */
export function isAllowedIdentifier(table, column) {
  if (table === EVENT_TABLE) return EVENT_COLUMNS.includes(column);
  if (table === PEOPLE_TABLE) return PEOPLE_COLUMNS.includes(column);
  return false;
}

/**
 * The catalog query for a single column, as a building block for any one-off lookup. The
 * identifier is checked against the allowlist first: asking for anything else throws instead of
 * returning a statement, so the whitelist is the gate and not a suggestion.
 */
export function columnTypeSql(table, column) {
  if (!isAllowedIdentifier(table, column)) {
    throw new Error(`dbo.${table}.${column} is not a column this report uses (allowed: ` +
      [...EVENT_COLUMNS, ...PEOPLE_COLUMNS].join(", ") + ").");
  }
  return `
SELECT sc.name AS name, t.name AS type
FROM sys.columns AS sc
JOIN sys.types AS t ON t.user_type_id = sc.user_type_id
JOIN sys.tables AS st ON st.object_id = sc.object_id
JOIN sys.schemas AS s ON s.schema_id = st.schema_id
WHERE s.name = 'dbo' AND st.name = N'${table}' AND sc.name = N'${column}';`;
}

/** Legacy LOB types need a CONVERT before they can be compared or printed as text. */
const asText = (type, column) => (type === "ntext" || type === "text"
  ? `CONVERT(VARCHAR(MAX), ${column})` : column);

/**
 * The rows whose EventUTCTime text cannot be read as a date/time, with examples. This is exactly
 * what the report's TRY_CONVERT skips, so a non-zero count explains a report that "loses" people.
 */
export function unparseableSql(type = "varchar") {
  const text = asText(type, `eh.${TIME_COLUMN}`);
  return `
SELECT TOP (10) CONVERT(VARCHAR(255), ${text}) AS BadValue, COUNT(*) AS BadRows
FROM dbo.${EVENT_TABLE} AS eh
WHERE eh.${TIME_COLUMN} IS NOT NULL
  AND LTRIM(RTRIM(${text})) <> ''
  AND TRY_CONVERT(datetime2(3), ${text}) IS NULL
GROUP BY CONVERT(VARCHAR(255), ${text})
ORDER BY COUNT(*) DESC;`;
}

/* ---------- error 241 ---------- */

/**
 * True for SQL Server error 241 (a character string that could not be read as date/time).
 * Reads the server's own number when the driver exposes it and falls back to the message,
 * because not every driver version keeps `number`.
 */
export function isError241(error) {
  if (!error || typeof error !== "object") return false;
  if (error.number === 241) return true;
  const message = String(error.message ?? "");
  // "Msg 241, Level 16, …" or "…SQL Server: Error 241: …": the server naming the number is
  // conclusive on its own, and drivers truncate messages, so no second keyword is required.
  if (/\b(?:error|msg)\s*:?\s*241\b/i.test(message)) return true;
  // A bare 241 is only trusted when it comes with the conversion wording.
  return /\b241\b/.test(message) && /conversion|datetime/i.test(message);
}

/** The same error with a pointer at `npm run doctor`, so the message is actionable. */
export function withError241Hint(error) {
  const err = error instanceof Error ? error : new Error(String(error?.message ?? error));
  err.hint = "SQL Server error 241: a date/time value in the database could not be read. " +
    "Run `npm run doctor` to see the real column types, the rows that fail to parse, and a report dry run.";
  err.message = `${err.message} ${err.hint}`;
  return err;
}

/* ---------- statements the report needs, derived from the column types ---------- */

/** All the columns this report uses, in one round trip, with the table names kept apart. */
const COLUMN_TYPES_SQL = `
SELECT st.name AS tbl, sc.name AS name, t.name AS type
FROM sys.columns AS sc
JOIN sys.types AS t ON t.user_type_id = sc.user_type_id
JOIN sys.tables AS st ON st.object_id = sc.object_id
JOIN sys.schemas AS s ON s.schema_id = st.schema_id
WHERE s.name = 'dbo' AND ((st.name = @eventTable AND sc.name IN (@c0, @c1, @c2, @c3, @c4))
   OR (st.name = @peopleTable AND sc.name IN (@p0, @p1, @p2, @p3)))
ORDER BY st.name, sc.column_id;`;

/**
 * Range and samples for the time column, read the way the report reads it. The bounds are built
 * with DATEFROMPARTS rather than written as a date literal, so even this diagnostic never asks
 * SQL Server to parse a character string as a date.
 */
const rangeSql = (timeExpr) => `
SELECT COUNT(${timeExpr}) AS ReadableRows,
       MIN(${timeExpr}) AS MinTime,
       MAX(${timeExpr}) AS MaxTime,
       SUM(CASE WHEN ${timeExpr} BETWEEN DATEFROMPARTS(1900, 1, 1) AND DATEFROMPARTS(2100, 1, 1) THEN 0 ELSE 1 END) AS OutOfRange
FROM dbo.${EVENT_TABLE} AS eh;`;

const samplesSql = (timeExpr) => `
SELECT TOP (3) ${timeExpr} AS SampleTime
FROM dbo.${EVENT_TABLE} AS eh
WHERE ${timeExpr} IS NOT NULL
ORDER BY ${timeExpr};`;

/* ---------- report ---------- */

const fmt = (value) =>
  value instanceof Date ? value.toISOString().replace("T", " ").slice(0, 19) : (value ?? "—");

const MARK = { ok: "OK  ", fail: "FAIL", note: "    " };
const LABEL = 13; // one past the longest label, so nothing runs into the detail

/**
 * Runs every check, prints the report through `say` and returns { lines, problems }.
 * `queryFn(sql, params)` is injected so this is testable without a database — and so the doctor
 * has exactly one way to reach SQL Server, the same one the reports use.
 */
export async function buildDoctorReport({ config, queryFn = query, today = new Date(), say } = {}) {
  const print = say ?? ((text) => console.log(text));
  const report = { lines: [], problems: 0 };
  // One shape for every line — mark, label, detail — so the report reads as a table.
  const line = (label, detail, mark = MARK.ok) => {
    if (mark === MARK.fail) report.problems += 1;
    const out = `${mark} ${String(label).padEnd(LABEL)}${detail}`;
    report.lines.push(out);
    print(out);
  };
  const fail = (label, detail) => line(label, detail, MARK.fail);
  const note = (label, detail) => line(label, detail, MARK.note);

  note("", `${brand.name} — database doctor (read-only)`);

  // 1. Configuration. The connection string holds the password, so it is masked unconditionally.
  if (!config?.connectionString) {
    fail("", "No local database configuration. Local mode: put DB_CONNECTION_STRING in .env. " +
      "Electron keeps its own encrypted settings and does not read .env, so run this from a terminal with a .env.");
    return report;
  }
  line("Config", `${config.source ?? ".env"} (UTC offset ${config.tzOffsetHours}h)`);
  line("Connects", maskConnectionString(config.connectionString));

  // 2. The column types the database really has.
  let types;
  try {
    const rows = await queryFn(COLUMN_TYPES_SQL, {
      eventTable: EVENT_TABLE,
      peopleTable: PEOPLE_TABLE,
      c0: EVENT_COLUMNS[0], c1: EVENT_COLUMNS[1], c2: EVENT_COLUMNS[2], c3: EVENT_COLUMNS[3], c4: EVENT_COLUMNS[4],
      p0: PEOPLE_COLUMNS[0], p1: PEOPLE_COLUMNS[1], p2: PEOPLE_COLUMNS[2], p3: PEOPLE_COLUMNS[3],
    });
    types = new Map((rows ?? []).map((r) => [`${r.tbl}.${r.name}`, r.type]));
  } catch (error) {
    fail("Columns", `the column types could not be read: ${error.message}`);
    return report;
  }

  for (const [table, columns] of [[EVENT_TABLE, EVENT_COLUMNS], [PEOPLE_TABLE, PEOPLE_COLUMNS]]) {
    const parts = columns.map((column) => describeColumn(column, types.get(`${table}.${column}`)));
    const missing = parts.filter((part) => part.endsWith("(column not found)"));
    if (missing.length) fail(table, `${missing.join(", ")} — dbo.${table} has to provide these.`);
    else line(table, parts.join(", "));
  }

  // 3. Which statement the report will run, chosen from that type.
  const declaredType = types.get(`${EVENT_TABLE}.${TIME_COLUMN}`);
  const typeLabel = declaredType ?? "(column not found)";
  const kind = classifyColumn(declaredType);
  if (kind === "datetime") {
    line("Statement", `reads ${TIME_COLUMN} as a ${typeLabel} column: the plain column, so the index on it is still usable.`);
  } else if (kind === "text") {
    line("Statement", `reads ${TIME_COLUMN} (a ${typeLabel} column) through TRY_CONVERT(datetime2(3), …): ` +
      "values that cannot be parsed are skipped instead of failing the report.");
  } else if (kind === "missing") {
    fail("Statement", `no ${TIME_COLUMN} column in dbo.${EVENT_TABLE}: the report cannot run at all.`);
    return report;
  } else {
    note("Statement", `${TIME_COLUMN} is declared "${typeLabel}", which the report does not know, so it uses the ` +
      "text-safe statement. A 241 cannot come from that column on this path.");
  }

  // 4. The time column's range and a few samples, read through the same expression the report uses.
  const timeExpr = kind === "datetime" ? `eh.${TIME_COLUMN}` : `TRY_CONVERT(datetime2(3), eh.${TIME_COLUMN})`;
  try {
    const [stats] = await queryFn(rangeSql(timeExpr), {});
    const readable = Number(stats?.ReadableRows ?? 0);
    const outOfRange = Number(stats?.OutOfRange ?? 0);
    const detail = `readable as date/time: ${readable.toLocaleString("en-US")} row(s), ` +
      `${fmt(stats?.MinTime)} to ${fmt(stats?.MaxTime)}.`;
    if (readable) line("Time", detail);
    else fail("Time", `nothing in ${TIME_COLUMN} can be read as a date/time — ${detail}`);
    if (outOfRange) {
      fail("Time", `${outOfRange.toLocaleString("en-US")} row(s) fall outside 1900-01-01..2100-01-01, ` +
        "which is where a converted date usually overflows.");
    }
    const samples = await queryFn(samplesSql(timeExpr), {});
    if (samples?.length) note("Samples", samples.map((s) => fmt(s.SampleTime)).join(", "));
  } catch (error) {
    fail("Time", `the column could not be read: ${error.message}`);
  }

  // 5. The rows that break a text column, with examples.
  if (kind === "text" || kind === "unknown") {
    try {
      const rows = await queryFn(unparseableSql(declaredType), {});
      const examples = (rows ?? []).map((r) => `${JSON.stringify(r.BadValue)} ×${Number(r.BadRows)}`);
      if (examples.length) {
        fail("Unparseable", `${examples.length} value(s) cannot be read as a date/time, most often ` +
          `${examples.slice(0, 5).join(", ")}. The report skips those rows, so whoever they belong to is missing from it.`);
      } else {
        line("Unparseable", `no ${TIME_COLUMN} value fails to parse.`);
      }
    } catch (error) {
      fail("Unparseable", `the check could not run: ${error.message}`);
    }
  } else {
    line("Unparseable", `not applicable: ${TIME_COLUMN} is a date/time column, so nothing is parsed from it.`);
  }

  // 6. A 7-day dry run through the report's own code path, so this answers "does it work now?".
  const dry = await dryRunReport({ config, queryFn, today });
  if (dry.ok) {
    line("Dry run", `the last 7 days (${dry.start}..${dry.end}) returned ${dry.rows} row(s) without an error.`);
  } else {
    fail("Dry run", `the last 7 days (${dry.start}..${dry.end}) failed: ${dry.error}`);
    if (dry.error241) fail("", "error 241 confirmed — it is a data problem, not a parameter one: start with the type above, then the bad rows.");
  }
  return report;
}

/**
 * Runs the report over the last 7 whole local days using the injected query function, so the
 * doctor exercises the real statement selection and window code rather than a copy of it.
 */
async function dryRunReport({ config, queryFn, today }) {
  const { default: attendance } = await import("./reports/attendance.js");
  const { start, end } = lastNDays(today, config.tzOffsetHours);
  try {
    const rows = await attendance.run({ mode: "range", start, end }, { tz: config.tzOffsetHours, queryFn });
    return { ok: true, start, end, rows: rows.length };
  } catch (error) {
    return { ok: false, start, end, error: error.message, error241: isError241(error) };
  }
}

/**
 * The last `days` whole days in the report's local time, ending yesterday, so the dry run always
 * covers complete days. The offset is subtracted exactly as the query subtracts it from UTC.
 */
export function lastNDays(today = new Date(), offsetHours = 0, days = 7) {
  const local = new Date(today.getTime() - Number(offsetHours || 0) * 3600000);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  return { start: iso(midnight - days * 86400000), end: iso(midnight - 86400000) };
}

/* ---------- command line ---------- */

async function main() {
  const { default: dotenv } = await import("dotenv");
  const { readEnvConfig } = await import("./env.js");
  const { configure, testConnection, closePool } = await import("./db/pool.js");
  dotenv.config({ quiet: true });
  let config = null;
  try {
    config = readEnvConfig();
  } catch (error) {
    console.error(`[doctor] ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (config) {
    // Fail fast on an unreachable server with the driver's own message, then hand the pool to the
    // checks, so the doctor reports through the same path a report run uses.
    try {
      await testConnection(config);
      await configure(config);
    } catch (error) {
      console.error(`[doctor] Cannot reach the database (${error.message}). Fix the connection first.`);
      process.exitCode = 1;
      await closePool().catch(() => {});
      return;
    }
  }
  const report = await buildDoctorReport({ config });
  await closePool().catch(() => {});
  process.exitCode = report.problems ? 1 : 0;
  if (report.problems) {
    console.log(`\n${report.problems} problem(s) found. Nothing above changed the database — the doctor only reads.`);
  } else {
    console.log("\nNothing to fix in the database. If a report still fails, the message above the doctor's is the one to look at.");
  }
}

// Runs as `npm run doctor`; importing it (the tests do) only gives you the functions.
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[doctor] ${error.message}`);
    process.exitCode = 1;
  });
}
