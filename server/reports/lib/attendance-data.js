// The data behind the Attendance and Absentees reports.
//
// Two read-only queries run for a period:
//   1. swipes — one row per person per local day with a granted access event (first/last entry, count)
//   2. roster — every active person (dbo.p_people.IsActive = 1), with the card on file
// They are combined here, in code, into Present rows and Absent rows.
//
// Who is "on record": active AND has a card. Nobody else appears in either report.
//
// All values are bound SQL parameters. Dates travel as integers (20261005) and are rebuilt
// inside SQL with DATETIMEFROMPARTS, so SQL Server never parses a date string (that used to
// cause error 241). Swipes are read from dbo.EventHistory and dbo.Events together (whichever
// exist), and a time column stored as text is handled too.

import { query } from "../../db/pool.js";
import { classifyColumn, isDateShapeError, withDateShapeHint } from "../../doctor.js";
import { daysInPeriod, isWeekend, localToday, toYmd, weekdayOf } from "./dates.js";
import { normalizePeriod, onPickedDay, WORKING_DAYS_ONLY } from "./period.js";

/* ---------- SQL ---------- */

// The local day ('YYYY-MM-DD') and clock time ('HH:MM:SS'), built from date parts so no
// language or date-format setting on the server can change them.
const localDayExpr = (t) =>
  `CONCAT(RIGHT('000' + CAST(YEAR(${t}) AS VARCHAR(4)), 4), '-', ` +
  `RIGHT('0' + CAST(MONTH(${t}) AS VARCHAR(2)), 2), '-', ` +
  `RIGHT('0' + CAST(DAY(${t}) AS VARCHAR(2)), 2))`;
// RIGHT keeps the last two characters ('0' + '15' -> '15'); LEFT would turn 15 into '01'.
const clockExpr = (t) =>
  `CONCAT(RIGHT('0' + CAST(DATEPART(HOUR, ${t}) AS VARCHAR(2)), 2), ':', ` +
  `RIGHT('0' + CAST(DATEPART(MINUTE, ${t}) AS VARCHAR(2)), 2), ':', ` +
  `RIGHT('0' + CAST(DATEPART(SECOND, ${t}) AS VARCHAR(2)), 2))`;

const ymdParts = (p) => `${p} / 10000, ${p} % 10000 / 100, ${p} % 100`;

// The event tables swipes can live in. Recent events may still be in dbo.Events while older ones
// have been moved to dbo.EventHistory, so a period can need either or both. A table is used only
// when the catalog shows it has every column below. These names are constants, never input.
export const EVENT_TABLES = Object.freeze(["EventHistory", "Events"]);
const EVENT_COLUMNS = ["PeopleID", "CardNumber", "EventCategory", "EventDescription", "EventUTCTime"];

// A table's time column as UTC datetime2(3). A real datetime column is compared as-is (so its
// index stays usable); text and date-only columns go through TRY_CONVERT, which skips unreadable
// values instead of failing the report (SQL Server error 241).
const utcTime = (alias, timeKind) =>
  (timeKind === "datetime" ? `${alias}.EventUTCTime` : `TRY_CONVERT(datetime2(3), ${alias}.EventUTCTime)`);

// Employee ID is dbo.p_people.EmployeeID; a database without that column shows PeopleID instead.
const badgeColumn = (identity) => (identity === "PeopleID" ? "pp.PeopleID" : "pp.EmployeeID");
const badgeSelect = (identity) => (identity === "PeopleID" ? "pp.PeopleID AS EmployeeID" : "pp.EmployeeID");

const usableCardSql = (alias) =>
  `${alias}.CardNumber IS NOT NULL AND LTRIM(RTRIM(CONVERT(VARCHAR(64), ${alias}.CardNumber))) <> '0'`;

/** Granted swipes from one table inside the window, as (PeopleID, CardNumber, EventTime UTC). */
const swipeBranch = ({ table, timeKind }, { withDevice = false } = {}) => {
  const t = utcTime("e", timeKind);
  const [from, to] = timeKind === "datetime" ? ["@fromDt", "@toDt"] : ["@fromDt2", "@toDt2"];
  const device = withDevice ? ", CONVERT(VARCHAR(64), e.DeviceID) AS DeviceID" : "";
  return `  SELECT e.PeopleID, CONVERT(VARCHAR(64), e.CardNumber) AS CardNumber, CAST(${t} AS datetime2(3)) AS EventTime${device}
  FROM dbo.${table} AS e
  WHERE TRY_CONVERT(int, e.EventCategory) = 10001
    AND e.EventDescription = N'Access Granted'
    AND ${usableCardSql("e")}
    AND ${t} >= ${from} AND ${t} < ${to}`;
};

/**
 * Swipe query: one row per person per local day. The granted swipes of every event table are
 * combined with UNION (not UNION ALL), so an event present in both tables is counted once.
 */
const WINDOW_SQL = `
DECLARE @fromDt  DATETIME     = DATEADD(HOUR, -@tz, DATETIMEFROMPARTS(${ymdParts("@startYmd")}, 0, 0, 0, 0));
DECLARE @toDt    DATETIME     = DATEADD(DAY, 1, DATEADD(HOUR, -@tz, DATETIMEFROMPARTS(${ymdParts("@endYmd")}, 0, 0, 0, 0)));
DECLARE @fromDt2 DATETIME2(3) = DATEADD(HOUR, -@tz, DATETIME2FROMPARTS(${ymdParts("@startYmd")}, 0, 0, 0, 0, 3));
DECLARE @toDt2   DATETIME2(3) = DATEADD(DAY, 1, DATEADD(HOUR, -@tz, DATETIME2FROMPARTS(${ymdParts("@endYmd")}, 0, 0, 0, 0, 3)));
`;

export function swipeSql(sources, identity = "EmployeeID") {
  const badge = badgeColumn(identity);
  const local = "DATEADD(HOUR, @tz, eh.EventTime)";
  return `${WINDOW_SQL}
SELECT
  eh.PeopleID, ${badgeSelect(identity)}, pp.Firstname, pp.Lastname, pp.Department,
  ${localDayExpr(local)} AS LocalDate,
  MIN(eh.CardNumber) AS CardNumber,
  ${clockExpr("DATEADD(HOUR, @tz, MIN(eh.EventTime))")} AS FirstEntry,
  ${clockExpr("DATEADD(HOUR, @tz, MAX(eh.EventTime))")} AS LastEntry,
  DATEDIFF(SECOND, MIN(eh.EventTime), MAX(eh.EventTime)) / 60 AS DurationMin,
  COUNT(*) AS AccessCount
FROM (
${sources.map((src) => swipeBranch(src)).join("\n  UNION\n")}
) AS eh
LEFT JOIN dbo.p_people AS pp ON eh.PeopleID = pp.PeopleID
WHERE (@idNumber = '' OR LTRIM(RTRIM(CONVERT(VARCHAR(64), ${badge}))) = @idNumber)
GROUP BY eh.PeopleID, ${badge}, pp.Firstname, pp.Lastname, pp.Department, ${localDayExpr(local)};`;
}

/**
 * Roster query: active people only. `card.CardNumber` is the person's latest usable card in any
 * event table; `PeopleCard` (when p_people has a CardNumber column) is the card on file.
 */
export function rosterSql(identity = "EmployeeID", sources = [{ table: "EventHistory", timeKind: "text" }], peopleCard = true) {
  const branches = sources.map(({ table, timeKind }) =>
    `    SELECT CONVERT(VARCHAR(64), e.CardNumber) AS CardNumber, CAST(${utcTime("e", timeKind)} AS datetime2(3)) AS EventTime
    FROM dbo.${table} AS e
    WHERE e.PeopleID = pp.PeopleID AND ${usableCardSql("e")}`).join("\n    UNION ALL\n");
  return `
SELECT pp.PeopleID, ${badgeSelect(identity)}, pp.Firstname, pp.Lastname, pp.Department, card.CardNumber${peopleCard ? ", pp.CardNumber AS PeopleCard" : ""}
FROM dbo.p_people AS pp
OUTER APPLY (
  SELECT TOP (1) c.CardNumber
  FROM (
${branches}
  ) AS c
  ORDER BY c.EventTime DESC
) AS card
WHERE TRY_CONVERT(int, pp.IsActive) = 1
  AND (@idNumber = '' OR LTRIM(RTRIM(CONVERT(VARCHAR(64), ${badgeColumn(identity)}))) = @idNumber);`;
}

// One catalog lookup per run: which event tables exist with the needed columns (and the type of
// their time column), and whether p_people has EmployeeID / CardNumber.
const CATALOG_SQL = `
SELECT TABLE_NAME AS tbl, COLUMN_NAME AS name, DATA_TYPE AS kind
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = 'dbo'
  AND (
    (TABLE_NAME IN ('EventHistory', 'Events')
      AND COLUMN_NAME IN ('PeopleID', 'CardNumber', 'EventCategory', 'EventDescription', 'EventUTCTime', 'DeviceID'))
    OR (TABLE_NAME = 'p_people' AND COLUMN_NAME IN ('EmployeeID', 'CardNumber'))
    OR (TABLE_NAME = 'HW_Devices' AND COLUMN_NAME IN ('DeviceID', 'DeviceName'))
  );`;

const FALLBACK_SOURCES = [{ table: "EventHistory", timeKind: "text" }];

/**
 * { sources: [{ table, timeKind }], identity: "EmployeeID" | "PeopleID", peopleCard: boolean }.
 * `sources` lists the event tables to read; if the catalog cannot be read it is EventHistory alone,
 * through the text-safe statement.
 */
export async function readReportShape(queryFn = query) {
  try {
    const rows = (await queryFn(CATALOG_SQL, {})) ?? [];
    const same = (a, b) => String(a ?? "").toLowerCase() === b.toLowerCase();
    const has = (tbl, name) => rows.find((r) => same(r?.tbl, tbl) && same(r?.name, name));
    const sources = EVENT_TABLES
      .filter((tbl) => EVENT_COLUMNS.every((col) => has(tbl, col)))
      .map((tbl) => {
        const kind = classifyColumn(has(tbl, "EventUTCTime").kind);
        return { table: tbl, timeKind: kind === "datetime" ? "datetime" : "text", hasDevice: Boolean(has(tbl, "DeviceID")) };
      });
    return {
      sources: sources.length ? sources : FALLBACK_SOURCES,
      identity: has("p_people", "EmployeeID") ? "EmployeeID" : "PeopleID",
      peopleCard: Boolean(has("p_people", "CardNumber")),
      deviceNames: Boolean(has("HW_Devices", "DeviceID") && has("HW_Devices", "DeviceName")),
    };
  } catch {
    return { sources: FALLBACK_SOURCES, identity: "PeopleID", peopleCard: false, deviceNames: false };
  }
}

/** The newest event time (UTC) across the event tables, or null. Used by the doctor. */
export async function latestEventTime(queryFn = query) {
  const { sources } = await readReportShape(queryFn);
  const sql = `SELECT MAX(t) AS Latest FROM (\n${sources.map(({ table, timeKind }) =>
    `  SELECT MAX(${utcTime("e", timeKind)}) AS t FROM dbo.${table} AS e`).join("\n  UNION ALL\n")}\n) AS x;`;
  const [row] = (await queryFn(sql, {})) ?? [];
  return row?.Latest ? new Date(row.Latest) : null;
}

/**
 * Reader query: for each person and local day, the reader (DeviceID) of their first granted swipe,
 * named from dbo.HW_Devices.DeviceName when that table exists. Only event tables that have
 * a DeviceID column are read. Ties at the same instant go to the lowest DeviceID, so it is stable.
 */
export function firstReaderSql(sources, deviceNames = true) {
  const local = "DATEADD(HOUR, @tz, s.EventTime)";
  const name = deviceNames ? "d.DeviceName" : "CAST(NULL AS VARCHAR(1))";
  const join = deviceNames
    ? "LEFT JOIN dbo.HW_Devices AS d ON CONVERT(VARCHAR(64), d.DeviceID) = x.DeviceID"
    : "";
  return `${WINDOW_SQL}
SELECT x.PeopleID, x.LocalDate, x.DeviceID, ${name} AS DeviceName
FROM (
  SELECT s.PeopleID, s.DeviceID, ${localDayExpr(local)} AS LocalDate,
    ROW_NUMBER() OVER (PARTITION BY s.PeopleID, ${localDayExpr(local)} ORDER BY s.EventTime, s.DeviceID) AS rn
  FROM (
${sources.map((src) => swipeBranch(src, { withDevice: true })).join("\n  UNION\n")}
  ) AS s
  WHERE s.DeviceID IS NOT NULL
) AS x
${join}
WHERE x.rn = 1;`;
}

/**
 * Map of person key -> reader name: the reader of the person's first swipe in the period
 * (on a picked day). The DeviceName is used when it has one, else the bare DeviceID.
 * Empty when no event table has a DeviceID column.
 */
export async function firstReaders(normalized, { tz, queryFn = query } = {}) {
  const { start, end, days } = normalized;
  const keepDay = onPickedDay(days);
  const { sources, deviceNames } = await readReportShape(queryFn);
  const withDevice = sources.filter((src) => src.hasDevice);
  const readers = new Map();
  if (!withDevice.length) return readers;
  const rows = await guard(() => queryFn(firstReaderSql(withDevice, deviceNames),
    { startYmd: toYmd(start), endYmd: toYmd(end), tz }));
  const sorted = [...(rows ?? [])].sort((a, b) => String(a.LocalDate).localeCompare(String(b.LocalDate)));
  for (const r of sorted) {
    const key = keyOf(r.PeopleID);
    if (!key || readers.has(key) || !keepDay(r.LocalDate)) continue;
    const label = usable(r.DeviceName) ?? usable(r.DeviceID);
    if (label !== null) readers.set(key, String(label));
  }
  return readers;
}

/* ---------- Turning query rows into report rows ---------- */

const keyOf = (id) => (id === null || id === undefined ? null : String(id).trim() || null);
const nameOf = (row) => [row.Lastname, row.Firstname].filter(Boolean).join(" ") || "Unknown";

/** A value worth showing, else null. A card of 0 counts as no card. */
const usable = (value, { zeroIsBlank = false } = {}) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text || (zeroIsBlank && text === "0")) return null;
  return typeof value === "string" ? text : value;
};
const card = (value) => usable(value, { zeroIsBlank: true });

/**
 * One Absent row per person per day with no swipe, from `start` to `end` but never after `today`.
 * Weekends are skipped when `skipWeekends` is on (the default: working days are Mon–Fri).
 * `roster` is [{ key, name, idNumber, department, cardNumber }]; `presentKeys` holds "key|date".
 */
export function absentRows({ start, end, today, roster, presentKeys, skipWeekends = WORKING_DAYS_ONLY, keepDay = () => true }) {
  const last = end < today ? end : today;
  const rows = [];
  if (start > last) return rows;
  for (const date of daysInPeriod(start, last)) {
    if ((skipWeekends && isWeekend(date)) || !keepDay(date)) continue;
    for (const person of roster) {
      if (presentKeys.has(`${person.key}|${date}`)) continue;
      rows.push({
        date, day: weekdayOf(date), personKey: person.key, name: person.name, firstName: person.firstName,
        lastName: person.lastName, idNumber: person.idNumber, department: person.department,
        cardNumber: person.cardNumber, firstEntry: "—", lastEntry: "—", duration: "—", accessCount: 0, status: "Absent",
      });
    }
  }
  return rows;
}

/** Report order: department, then Present before Absent, then date, then name. */
export const sortRows = (rows) => rows.sort((a, b) =>
  a.department.localeCompare(b.department) ||
  (a.status === b.status ? 0 : a.status === "Present" ? -1 : 1) ||
  a.date.localeCompare(b.date) ||
  a.name.localeCompare(b.name));

/** "15:21:05" -> "3:21:05 PM". The 24-hour value is kept on the row as <key>Sort for ordering. */
const to12h = (hms) => {
  const [h, m, s] = String(hms ?? "").split(":").map(Number);
  if (![h, m, s].every(Number.isFinite)) return hms ?? "—";
  const pad = (n) => String(n).padStart(2, "0");
  return `${h % 12 || 12}:${pad(m)}:${pad(s)} ${h < 12 ? "AM" : "PM"}`;
};

const durationText = (minutes) => `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;

/** Adds the database's hint to SQL Server date-shape errors (241/242/9810). */
const guard = async (fn) => {
  try { return await fn(); } catch (error) { throw isDateShapeError(error) ? withDateShapeHint(error) : error; }
};

/**
 * Runs both queries for a period and returns { normalized, present, absent }, each sorted.
 * `params` is the raw form input; `tz` the UTC offset in hours.
 */
export async function runPeriod(params, { tz, queryFn = query, now = new Date() } = {}) {
  const normalized = normalizePeriod(params);
  const { start, end, idNumber = "", days } = normalized;
  const keepDay = onPickedDay(days);
  const { sources, identity, peopleCard } = await readReportShape(queryFn);

  const swipes = await guard(() => queryFn(swipeSql(sources, identity),
    { startYmd: toYmd(start), endYmd: toYmd(end), idNumber, tz }));
  const people = await guard(() => queryFn(rosterSql(identity, sources, peopleCard), { idNumber }));

  // The roster, one entry per PeopleID. Card on file first, then the latest card on EventHistory.
  const roster = new Map();
  for (const p of people) {
    const key = keyOf(p.PeopleID);
    if (!key || roster.has(key)) continue;
    roster.set(key, {
      key,
      name: nameOf(p),
      firstName: usable(p.Firstname) ?? "—",
      lastName: usable(p.Lastname) ?? "—",
      idNumber: usable(p.EmployeeID),
      department: p.Department || "Unassigned",
      cardNumber: card(p.PeopleCard) ?? card(p.CardNumber),
    });
  }

  // A blank Employee ID or card on the roster is filled from this person's own swipes.
  for (const s of swipes) {
    const person = roster.get(keyOf(s.PeopleID));
    if (!person) continue;
    person.idNumber ??= usable(s.EmployeeID);
    person.cardNumber ??= card(s.CardNumber);
  }

  // On record = active (in the roster) AND carded. Everyone else is left out entirely.
  const onRecord = [...roster.values()]
    .filter((p) => p.cardNumber !== null)
    .map((p) => ({ ...p, idNumber: p.idNumber ?? "—" }));
  const byKey = new Map(onRecord.map((p) => [p.key, p]));

  const presentKeys = new Set();
  const present = [];
  for (const s of swipes) {
    const person = byKey.get(keyOf(s.PeopleID));
    if (!person) continue;
    const date = s.LocalDate ?? start;
    presentKeys.add(`${person.key}|${date}`);
    if (!keepDay(date)) continue;
    const single = Number(s.AccessCount) <= 1; // exactly one swipe: no check-out to show
    present.push({
      date,
      day: weekdayOf(date),
      personKey: person.key,
      name: person.name,
      firstName: person.firstName,
      lastName: person.lastName,
      idNumber: person.idNumber,
      department: person.department,
      cardNumber: card(s.CardNumber) ?? person.cardNumber,
      firstEntry: to12h(s.FirstEntry),
      lastEntry: single ? "—" : to12h(s.LastEntry),
      // 24-hour copies, so sorting by time puts 1:00 PM after 11:00 AM (see sortRows in template.js).
      firstEntrySort: s.FirstEntry,
      lastEntrySort: single ? null : s.LastEntry,
      duration: single ? "—" : durationText(s.DurationMin),
      accessCount: s.AccessCount,
      status: "Present",
    });
  }

  const absent = absentRows({ start, end, today: localToday(now, tz), roster: onRecord, presentKeys, keepDay });
  return { normalized, present: sortRows(present), absent: sortRows(absent) };
}
