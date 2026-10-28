// Calendar helpers. Every date here is plain "YYYY-MM-DD" text in local time, so the machine's
// own clock and time zone can never shift a day.

const DAY_MS = 86400000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

const pad = (n) => String(n).padStart(2, "0");
const dayNumber = (ymd) => Date.parse(`${ymd}T00:00:00Z`) / DAY_MS;
const ymdOf = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);

/** True only for a real calendar day written as YYYY-MM-DD (so 2026-02-31 is refused). */
export function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** "2026-10" -> { year, month, start: "2026-10-01", end: "2026-10-31" }, or null if invalid. */
export function monthBounds(value) {
  const match = /^(\d{4})-(\d{2})$/.exec(typeof value === "string" ? value : "");
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 1900 || year > 9999 || month < 1 || month > 12) return null;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { year, month, start: `${year}-${pad(month)}-01`, end: `${year}-${pad(month)}-${pad(lastDay)}` };
}

/** Number of days from start to end, counting both. */
export const rangeDays = (start, end) => dayNumber(end) - dayNumber(start) + 1;

/** Every day from start to end, both included. */
export function daysInPeriod(start, end) {
  const days = [];
  for (let n = dayNumber(start); n <= dayNumber(end); n += 1) days.push(ymdOf(n));
  return days;
}

/** "2026-10-05" -> "Monday". */
export const weekdayOf = (ymd) => WEEKDAYS[new Date(`${ymd}T00:00:00Z`).getUTCDay()];

/** 0 = Sunday … 6 = Saturday. */
export const weekdayIndex = (ymd) => new Date(`${ymd}T00:00:00Z`).getUTCDay();

export const isWeekend = (ymd) => [0, 6].includes(weekdayIndex(ymd));

export const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Today's local date for a UTC offset in hours (Nigeria is 1). */
export function localToday(now = new Date(), tzOffsetHours = 0) {
  return new Date(now.getTime() + (Number(tzOffsetHours) || 0) * 3600000).toISOString().slice(0, 10);
}

/** "2026-10-05" -> 20261005, the form SQL receives dates in (never as text). */
export const toYmd = (isoDate) => Number(isoDate.replace(/-/g, ""));
